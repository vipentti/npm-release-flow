/**
 * Signing-material verification shared by the CLI commands (T3/T4/T5): the
 * read-only signing preflights every signing path gates on, phrased as
 * checkable states so `check` can aggregate them and `prepare`/`tag` can
 * refuse with the same messages.
 */

import { msysPath, runSync } from "./spawn.mjs";
import { CliError, CommandError, describeFailure } from "./errors.mjs";
import { configuredSigningKey, gpgProgram, git } from "./repo-state.mjs";

/**
 * @typedef {object} SigningCtx
 * @property {string} cwd The directory the signing commands run in.
 * @property {NodeJS.ProcessEnv} env The environment for the signing commands.
 */

/**
 * @typedef {{ ok: true, key: string } | { ok: false, message: string }}
 *   SigningState
 */

const fingerprintPattern = /^[0-9a-fA-F]{40}$/;

/**
 * GPG argument prefix mirroring git's keyring selection: an explicit
 * `--homedir` when GNUPGHOME is set (some gpg builds ignore the env var).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function gpgHomeArgs(env) {
  if (env.GNUPGHOME) {
    // Product boundary for the kit's own gpg calls: the Git-bundled gpg on
    // win32 misreads a native drive-letter path as cwd-relative, so the
    // MSYS form is passed here (no-op on POSIX). Callers keep native paths.
    return ["--homedir", msysPath(env.GNUPGHOME)];
  }
  return [];
}

/**
 * Check git's configured commit-signing key: `user.signingkey` must be set
 * and the secret key must exist in the GPG keyring (`prepare`'s preflight).
 *
 * @param {SigningCtx} ctx
 * @returns {SigningState}
 */
export function commitSigningState(ctx) {
  const key = configuredSigningKey(ctx);
  if (!key) {
    return {
      ok: false,
      message: describeFailure({
        checked: "git's configured commit-signing key (user.signingkey)",
        found: "no user.signingkey is configured",
        correction:
          "configure user.signingkey with the fingerprint of the key that must sign release commits",
      }),
    };
  }
  try {
    runSync(
      gpgProgram(ctx),
      ["--batch", ...gpgHomeArgs(ctx.env), "--list-secret-keys", key],
      ctx,
    );
  } catch (err) {
    const detail =
      err instanceof CommandError
        ? err.stderr.trim() || err.message
        : String(err);
    return {
      ok: false,
      message: describeFailure({
        checked: `that the configured signing key ${key} is locally available in the GPG keyring`,
        found: detail,
        correction:
          "import or restore the secret key in the local GPG home (GNUPGHOME)",
      }),
    };
  }
  return { ok: true, key };
}

/**
 * Fully verify a local annotated tag against the expected release commit:
 * annotated object, target, subject `Release v<version>`, exactly one
 * VALIDSIG whose primary fingerprint equals the configured fingerprint.
 * Shared by the local break-glass `tag` command and the protected `release`
 * job; returns the tag object SHA (without dereferencing, what `ls-remote`
 * reports and what GitHub's API verifies).
 *
 * @param {{ version: string, targetSha: string, fingerprint: string, cwd: string, env: NodeJS.ProcessEnv }} input
 * @returns {string} The tag object SHA.
 */
export function verifyTagObject({ version, targetSha, fingerprint, cwd, env }) {
  const ctx = { cwd, env };
  const tagRef = `refs/tags/v${version}`;
  const type = git(["cat-file", "-t", tagRef], ctx).stdout.trim();
  if (type !== "tag") {
    throw new CliError(
      describeFailure({
        checked: `that v${version} is an annotated tag object`,
        found: `it is a ${type} object`,
        correction: "the tag must be annotated and signed",
      }),
    );
  }
  const target = git(["rev-parse", `${tagRef}^{commit}`], ctx).stdout.trim();
  if (target !== targetSha) {
    throw new CliError(
      describeFailure({
        checked: `that v${version} points at the release commit`,
        found: `the tag points at ${target.slice(0, 8)}, not ${targetSha.slice(0, 8)}`,
        correction: "the tag must point at the release commit",
      }),
    );
  }
  const tagBody = git(["cat-file", "tag", tagRef], ctx).stdout;
  if (!tagBody.includes(`\n\nRelease v${version}\n`)) {
    throw new CliError(
      describeFailure({
        checked: `that the tag subject is "Release v${version}"`,
        found: "the tag message differs",
        correction: "recreate the tag with the subject 'Release v<version>'",
      }),
    );
  }
  const raw = git(["verify-tag", "--raw", tagRef], ctx).stderr;
  const validsigs = [...raw.matchAll(/\[GNUPG:\] VALIDSIG ([0-9A-Fa-f]{40})/g)];
  if (validsigs.length !== 1) {
    throw new CliError(
      describeFailure({
        checked: `that v${version} has exactly one valid GPG signature`,
        found: `${validsigs.length} VALIDSIG line(s)`,
        correction: "the tag must be signed by exactly one key",
      }),
    );
  }
  if (validsigs[0][1].toLowerCase() !== fingerprint) {
    throw new CliError(
      describeFailure({
        checked:
          "that the signature's primary fingerprint matches NPM_RELEASE_FLOW_GPG_FINGERPRINT",
        found: validsigs[0][1],
        correction: "the tag must be signed with the configured release key",
      }),
    );
  }
  return git(["rev-parse", tagRef], ctx).stdout.trim();
}

/**
 * Check the `NPM_RELEASE_FLOW_GPG_FINGERPRINT` signing material: the env
 * value must be 40-hex and a usable secret key for it must exist in the GPG
 * keyring (`tag`'s preflight).
 *
 * @param {SigningCtx} ctx
 * @returns {SigningState}
 */
export function fingerprintSigningState(ctx) {
  const fingerprint = ctx.env.NPM_RELEASE_FLOW_GPG_FINGERPRINT ?? "";
  if (!fingerprintPattern.test(fingerprint)) {
    return {
      ok: false,
      message: describeFailure({
        checked: "NPM_RELEASE_FLOW_GPG_FINGERPRINT",
        found:
          fingerprint === ""
            ? "the environment variable is not set"
            : `${JSON.stringify(fingerprint)} is not 40 hexadecimal characters`,
        correction:
          "set NPM_RELEASE_FLOW_GPG_FINGERPRINT to the release key's 40-character primary fingerprint",
      }),
    };
  }
  const normalized = fingerprint.toLowerCase();
  try {
    runSync(
      gpgProgram(ctx),
      ["--batch", ...gpgHomeArgs(ctx.env), "--list-secret-keys", normalized],
      ctx,
    );
  } catch (err) {
    const detail =
      err instanceof CommandError
        ? err.stderr.trim() || err.message
        : String(err);
    return {
      ok: false,
      message: describeFailure({
        checked: `that a usable secret key for ${normalized} exists in the GPG keyring`,
        found: detail,
        correction:
          "import or restore the release secret key in the local GPG home (GNUPGHOME)",
      }),
    };
  }
  return { ok: true, key: normalized };
}
