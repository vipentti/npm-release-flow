/**
 * Signing-material verification shared by the CLI commands (T3/T4/T5): the
 * read-only signing preflights every signing path gates on, phrased as
 * checkable states so `check` can aggregate them and `prepare`/`tag` can
 * refuse with the same messages.
 */

import { runSync } from "./spawn.mjs";
import { CommandError, describeFailure } from "./errors.mjs";
import {
  configuredSigningKey,
  gpgProgram,
} from "./repo-state.mjs";

/**
 * @typedef {Object} SigningCtx
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} env
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
    return ["--homedir", env.GNUPGHOME];
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
      [
        "--batch",
        ...gpgHomeArgs(ctx.env),
        "--list-secret-keys",
        normalized,
      ],
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
