/**
 * `tag` command (blueprint §8, §9 boundary 4): break-glass local recovery.
 * Creates the annotated, signed tag `vX.Y.Z` (subject `Release vX.Y.Z`) on
 * the release-merge commit at `origin/main` and pushes it authenticated as
 * the release GitHub App. Deliberately separate from the automated path
 * (PR merge -> protected job -> tag + publish); `prepare`'s signed branch
 * commit is never the target.
 *
 * Completion semantics per §9 boundary 4: a valid remote tag -> fetch + full
 * verify, exit 0 (no push); a divergent remote tag -> exit 1, manual; remote
 * absent with a valid local tag -> dry-run reports the push and `--execute`
 * pushes that tag; remote absent with no local tag -> create, verify, push,
 * verify. Refuses unsigned or lightweight tags.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CliError,
  CommandError,
  ExitCode,
  describeFailure,
} from "../lib/errors.mjs";
import {
  git,
  gh,
  isCleanWorktree,
  remoteRefSha,
  localRefSha,
  localObjectSha,
} from "../lib/repo-state.mjs";
import { fingerprintSigningState } from "../lib/tag-verify.mjs";
import { parseStableVersion } from "../lib/versions.mjs";
import { classifyRelease } from "../lib/release-state.mjs";
import { mintAppToken } from "../lib/app-token.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const kitRoot = resolve(moduleDir, "..", "..");

/**
 * @param {string} version
 * @returns {RegExp} The documented release-merge message grammar:
 *   `Merge pull request #N from <owner>/<repo>/release/v<version>`.
 */
function releaseMergePattern(version) {
  const escaped = version.replace(/\./g, "\\.");
  return new RegExp(
    `^Merge pull request #[0-9]+ from [^/\\s]+/[^/\\s]+/release/v${escaped}$`,
  );
}

/**
 * @typedef {Object} TagOptions
 * @property {string} [cwd] Repository root the command operates on.
 * @property {NodeJS.ProcessEnv} [env] Environment.
 * @property {(line: string) => void} [log] Plan-line sink.
 */

/**
 * @param {string} line
 * @returns {void}
 */
function consoleLog(line) {
  console.log(line);
}

/**
 * Show a file at a revision (`git show <rev>:<path>`), or null when the file
 * is missing there.
 *
 * @param {string} rev
 * @param {string} path
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {string | null}
 */
function showFile(rev, path, ctx) {
  try {
    return git(["show", `${rev}:${path}`], ctx).stdout;
  } catch (err) {
    if (err instanceof CommandError && err.status === 128) return null;
    throw err;
  }
}

/**
 * Parse JSON from a revision, or null when unreadable.
 *
 * @param {string} rev
 * @param {string} path
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {Record<string, any> | null}
 */
function showJson(rev, path, ctx) {
  const text = showFile(rev, path, ctx);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read-only signing preflight wrapper for `tag`: the
 * `NPM_RELEASE_FLOW_GPG_FINGERPRINT` env value must be 40-hex and a usable
 * secret key for it must exist in the (GNUPGHOME-scoped) GPG keyring.
 * Proven before any mutation.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {string} The normalized (lowercase) fingerprint.
 */
function fingerprintPreflight(env, ctx) {
  const state = fingerprintSigningState({ cwd: ctx.cwd, env });
  if (!state.ok) {
    throw new CliError(state.message);
  }
  return state.key;
}

/**
 * Resolve the release-merge candidate commit for a version: exactly one
 * matching release merge on `origin/main`'s first-parent history, classified
 * by §9 as a valid release for that version.
 *
 * @param {string} version
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {string} The candidate commit SHA.
 */
function resolveReleaseMerge(version, ctx) {
  const shas = git(["rev-list", "--first-parent", "origin/main"], ctx)
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const subjects = git(
    ["log", "--first-parent", "--format=%s", "origin/main"],
    ctx,
  )
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const pattern = releaseMergePattern(version);
  const candidates = shas.filter((sha, i) => pattern.test(subjects[i] ?? ""));
  if (candidates.length === 0) {
    throw new CliError(
      describeFailure({
        checked: `origin/main's first-parent history for a release merge of v${version}`,
        found: "no commit matches the release-merge message grammar",
        correction:
          "confirm the release PR was merged into main; tag the merged commit manually if it was",
      }),
    );
  }
  if (candidates.length > 1) {
    throw new CliError(
      describeFailure({
        checked: `origin/main's first-parent history for a release merge of v${version}`,
        found: `${candidates.length} commits match the release-merge message grammar`,
        correction: "resolve which merge is the release for this version, then tag it manually",
      }),
    );
  }
  const candidate = candidates[0];
  const parent = git(["rev-parse", `${candidate}^`], ctx).stdout.trim();
  const tagTarget = localRefSha(`refs/tags/v${version}`, ctx);
  const verdict = classifyRelease({
    beforeResolved: true,
    headMatchesTrigger: true,
    beforePkg: showJson(parent, "package.json", ctx),
    afterPkg: showJson(candidate, "package.json", ctx),
    beforeLock: showJson(parent, "package-lock.json", ctx),
    afterLock: showJson(candidate, "package-lock.json", ctx),
    changedFiles: git(
      ["diff", "--name-only", parent, candidate],
      ctx,
    )
      .stdout.trim()
      .split("\n")
      .filter(Boolean),
    changelog: showFile(candidate, "CHANGELOG.md", ctx),
    tagTarget,
    afterSha: candidate,
  });
  if (verdict.verdict !== "valid") {
    throw new CliError(
      describeFailure({
        checked: `the release merge of v${version} as a valid release`,
        found: verdict.reasons[0] ?? "the merge is not a valid release",
        correction:
          "the merge commit's diff must be exactly the three control files with a stable version increase and a valid changelog",
      }),
    );
  }
  return candidate;
}

/**
 * Fully verify the local annotated tag: annotated object, target commit,
 * subject `Release v<version>`, exactly one VALIDSIG whose primary
 * fingerprint equals the configured fingerprint.
 *
 * @param {string} version
 * @param {string} candidate
 * @param {string} fingerprint
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {void}
 */
function verifyLocalTag(version, candidate, fingerprint, ctx) {
  const tagRef = `refs/tags/v${version}`;
  const type = git(["cat-file", "-t", tagRef], ctx).stdout.trim();
  if (type !== "tag") {
    throw new CliError(
      describeFailure({
        checked: `that v${version} is an annotated tag object`,
        found: `it is a ${type} object`,
        correction: "recreate the tag with an annotated, signed tag",
      }),
    );
  }
  const target = git(["rev-parse", `${tagRef}^{commit}`], ctx).stdout.trim();
  if (target !== candidate) {
    throw new CliError(
      describeFailure({
        checked: `that v${version} points at the release-merge commit`,
        found: `the tag points at ${target.slice(0, 8)}, not ${candidate.slice(0, 8)}`,
        correction: "delete the tag and recreate it on the release merge",
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
        correction: "re-sign the tag with the release key",
      }),
    );
  }
  if (validsigs[0][1].toLowerCase() !== fingerprint) {
    throw new CliError(
      describeFailure({
        checked: "that the signature's primary fingerprint matches NPM_RELEASE_FLOW_GPG_FINGERPRINT",
        found: validsigs[0][1],
        correction: "sign the tag with the configured release key",
      }),
    );
  }
}

/**
 * Mint the App installation token used for the tag push: App ID from the
 * repository variable via `gh api`, private key from the local environment
 * (secrets are never API-readable), installation token via the shared
 * helper. Refuses when the material is absent or the token cannot be minted.
 *
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {Promise<string>}
 */
async function appTokenForPush(ctx) {
  let nameWithOwner;
  try {
    nameWithOwner = gh(
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      ctx,
    ).stdout.trim();
  } catch (err) {
    const detail =
      err instanceof CommandError ? err.stderr.trim() : String(err);
    throw new CliError(
      describeFailure({
        checked: "the repository identity via gh repo view",
        found: detail || "gh repo view failed",
        correction: "check gh auth and that the current directory is a GitHub repository",
      }),
    );
  }
  const slash = nameWithOwner.indexOf("/");
  if (slash === -1 || slash === 0 || slash === nameWithOwner.length - 1) {
    throw new CliError(
      describeFailure({
        checked: "the repository identity",
        found: `${JSON.stringify(nameWithOwner)} is not owner/name`,
        correction: "run from a checkout of the GitHub repository",
      }),
    );
  }
  const owner = nameWithOwner.slice(0, slash);
  const repo = nameWithOwner.slice(slash + 1);

  let appId;
  try {
    const result = gh(
      [
        "api",
        `repos/${owner}/${repo}/actions/variables/NPM_RELEASE_FLOW_APP_ID`,
      ],
      ctx,
    );
    appId = JSON.parse(result.stdout).value;
  } catch (err) {
    throw new CliError(
      describeFailure({
        checked: `the NPM_RELEASE_FLOW_APP_ID repository variable for ${owner}/${repo}`,
        found:
          err instanceof CommandError && err.status === 404
            ? "the variable is not set"
            : "the variable could not be read",
        correction:
          "declare NPM_RELEASE_FLOW_APP_ID as a repository variable with the release App's ID",
      }),
    );
  }
  if (typeof appId !== "string" || appId === "") {
    throw new CliError(
      describeFailure({
        checked: "the NPM_RELEASE_FLOW_APP_ID variable value",
        found: JSON.stringify(appId),
        correction: "set the variable to the release App's numeric ID",
      }),
    );
  }
  const privateKey = ctx.env.NPM_RELEASE_FLOW_APP_PRIVATE_KEY ?? "";
  if (privateKey === "") {
    throw new CliError(
      describeFailure({
        checked: "NPM_RELEASE_FLOW_APP_PRIVATE_KEY in the local environment",
        found: "the environment variable is not set or empty",
        correction:
          "export the release App's PEM private key (secrets are never API-readable)",
      }),
    );
  }
  try {
    return await mintAppToken({ appId, privateKey, owner, repo });
  } catch (err) {
    throw new CliError(
      describeFailure({
        checked: "minting the release App installation token",
        found: err instanceof Error ? err.message : String(err),
        correction:
          "verify the App ID variable, the private key, and that the App is installed on the repository",
      }),
    );
  }
}

/**
 * Execute the tag flow.
 *
 * @param {{ version: string, execute: boolean }} args
 * @param {TagOptions} [options]
 * @returns {Promise<number>} The exit code (0 on success; failures throw
 *   CliError carrying their exit code).
 */
export async function tag(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? consoleLog;
  const { version, execute } = args;
  const parsed = parseStableVersion(version);
  if (parsed === null) {
    throw new CliError(
      describeFailure({
        checked: "the requested version",
        found: JSON.stringify(version),
        correction:
          "use a stable X.Y.Z version (no leading zeros, no prerelease)",
      }),
    );
  }
  const ctx = { cwd, env };
  const tagRef = `refs/tags/v${version}`;
  /** @param {string} msg @returns {void} */
  const plan = (msg) => log(`${execute ? "[exec]" : "[dry-run]"} ${msg}`);

  plan(`Subcommand: tag`);
  plan(`Version: ${version}`);
  plan(`Tag: ${tagRef}`);

  if (!isCleanWorktree(ctx)) {
    throw new CliError(
      describeFailure({
        checked: "the working tree",
        found: "uncommitted changes (git status --porcelain is non-empty)",
        correction: "commit or stash them before tagging",
      }),
    );
  }

  // Read-only signing preflight before any mutation.
  const fingerprint = fingerprintPreflight(env, ctx);
  plan(`Signing preflight: secret key for ${fingerprint} available`);

  git(["fetch", "origin", "main"], ctx);
  const candidate = resolveReleaseMerge(version, ctx);
  plan(`Release-merge commit: ${candidate}`);

  // Boundary 4: observe the remote tag state before mutating.
  const remoteTag = remoteRefSha(tagRef, ctx);
  const localTag = localObjectSha(tagRef, ctx);

  if (remoteTag !== null) {
    // Fetch the remote tag object and fully verify it.
    git(["fetch", "origin", tagRef], ctx);
    const localTagAfterFetch = localObjectSha(tagRef, ctx);
    if (localTagAfterFetch === null || localTagAfterFetch !== remoteTag) {
      throw new CliError(
        describeFailure({
          checked: "the remote tag object against the local copy",
          found:
            localTagAfterFetch === null
              ? "the fetched tag is missing locally"
              : `local ${localTagAfterFetch.slice(0, 8)} != remote ${remoteTag.slice(0, 8)}`,
          correction: "delete the divergent local tag and re-fetch",
        }),
      );
    }
    verifyLocalTag(version, candidate, fingerprint, ctx);
    plan(`Remote tag v${version} present and valid; verified, no push`);
    return 0;
  }

  if (localTag !== null) {
    // Remote absent with a valid local tag: dry-run reports the push,
    // --execute pushes the existing tag with the App token.
    verifyLocalTag(version, candidate, fingerprint, ctx);
    plan(`Would push the existing tag v${version} to origin (App-authenticated)`);
    if (!execute) {
      return 0;
    }
    const token = await appTokenForPush(ctx);
    git(
      [
        "-c",
        `http.extraheader=Authorization: Bearer ${token}`,
        "push",
        "origin",
        tagRef,
      ],
      ctx,
    );
    const verified = remoteRefSha(tagRef, ctx);
    const localObject = localObjectSha(tagRef, ctx);
    if (verified === null || verified !== localObject) {
      throw new CliError(
        describeFailure({
          checked: "that the remote tag equals the local tag object",
          found:
            verified === null
              ? "the remote tag is absent"
              : `remote ${verified.slice(0, 8)} != local ${String(localObject).slice(0, 8)}`,
          correction: "resolve the remote tag state manually",
        }),
      );
    }
    plan(`Pushed existing tag v${version}; remote object verified`);
    return 0;
  }

  // Remote absent with no local tag: create, verify, push, verify.
  plan(`Would create annotated signed tag v${version} on ${candidate}`);
  plan(`Would verify the tag (object, target, subject, VALIDSIG ${fingerprint})`);
  plan("Would push the tag to origin (App-authenticated)");
  plan("Would verify the remote tag object equals the local one");
  if (!execute) {
    return 0;
  }

  git(
    [
      "tag",
      "-a",
      "-s",
      "-u",
      fingerprint,
      "-m",
      `Release v${version}`,
      `v${version}`,
      candidate,
    ],
    ctx,
  );
  try {
    verifyLocalTag(version, candidate, fingerprint, ctx);
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError(
        `${err.message} Created: local tag v${version}. Remaining manual: delete or fix the tag, then rerun.`,
        { exitCode: ExitCode.ERROR },
      );
    }
    throw err;
  }
  plan(`Created and verified local tag v${version}`);

  let token;
  try {
    token = await appTokenForPush(ctx);
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError(
        `${err.message} Created: local tag v${version}. Remaining manual: push refs/tags/v${version} to origin (or delete the local tag).`,
        { exitCode: ExitCode.ERROR },
      );
    }
    throw err;
  }
  try {
    git(
      [
        "-c",
        `http.extraheader=Authorization: Bearer ${token}`,
        "push",
        "origin",
        tagRef,
      ],
      ctx,
    );
  } catch (err) {
    const detail =
      err instanceof CommandError ? err.stderr.trim() : String(err);
    throw new CliError(
      `${describeFailure({
        checked: `pushing the tag v${version} to origin`,
        found: detail || "git push failed",
        correction: "push the tag manually with the release App token",
      })} Created: local tag v${version}. Remaining manual: push refs/tags/v${version} to origin.`,
    );
  }
  const verified = remoteRefSha(tagRef, ctx);
  const localObject = localObjectSha(tagRef, ctx);
  if (verified === null || verified !== localObject) {
    throw new CliError(
      describeFailure({
        checked: "that the remote tag equals the local tag object",
        found:
          verified === null
            ? "the remote tag is absent"
            : `remote ${verified.slice(0, 8)} != local ${String(localObject).slice(0, 8)}`,
        correction: "resolve the remote tag state manually",
      }),
    );
  }
  plan(`Pushed v${version}; remote object verified`);
  return 0;
}
