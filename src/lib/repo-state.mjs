/**
 * Local git/gh state helpers shared by the CLI commands (prepare/tag/check).
 * All subprocess execution goes through the single spawn helper (blueprint
 * §8); this module only shapes git/gh invocations.
 */

import { runSync, refProbeSync } from "./spawn.mjs";
import { CommandError } from "./errors.mjs";

/**
 * @typedef {Object} ExecOptions
 * @property {string} [cwd] Working directory for the child.
 * @property {NodeJS.ProcessEnv} [env] Environment for the child.
 */

/**
 * Run git, capturing stdout/stderr. Non-zero exits raise CommandError.
 *
 * @param {string[]} args
 * @param {ExecOptions} [options]
 * @returns {import("./spawn.mjs").SpawnResult}
 */
export function git(args, options = {}) {
  return runSync("git", args, options);
}

/**
 * Run gh (the GitHub CLI), capturing stdout/stderr. Non-zero exits raise
 * CommandError; the win32 `.cmd` wrapper resolves in the spawn helper.
 *
 * @param {string[]} args
 * @param {ExecOptions} [options]
 * @returns {import("./spawn.mjs").SpawnResult}
 */
export function gh(args, options = {}) {
  return runSync("gh", args, options);
}

/**
 * Whether the worktree is clean (`git status --porcelain` is empty).
 *
 * @param {ExecOptions} [options]
 * @returns {boolean}
 */
export function isCleanWorktree(options = {}) {
  return git(["status", "--porcelain"], options).stdout.trim() === "";
}

/**
 * The current HEAD SHA.
 *
 * @param {ExecOptions} [options]
 * @returns {string}
 */
export function currentSha(options = {}) {
  return git(["rev-parse", "HEAD"], options).stdout.trim();
}

/**
 * The SHA of a local ref, or null when the ref does not exist. Only the
 * `rev-parse --verify --quiet` missing-ref outcome (exit status 1) counts as
 * absent; other failures propagate.
 *
 * @param {string} ref
 * @param {ExecOptions} [options]
 * @returns {string | null}
 */
export function localRefSha(ref, options = {}) {
  let result;
  try {
    result = runSync(
      "git",
      ["rev-parse", "--verify", "--quiet", ref + "^{commit}"],
      options,
    );
  } catch (err) {
    if (err instanceof CommandError && err.status === 1) return null;
    throw err;
  }
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * The SHA a remote ref points at, or null when the ref is absent. Ref-probe
 * semantics: only exit status 2 means "absent"; auth/network failures
 * propagate as errors, never as absent.
 *
 * @param {string} ref
 * @param {ExecOptions} [options]
 * @returns {string | null}
 */
export function remoteRefSha(ref, options = {}) {
  const probe = refProbeSync("git", ["ls-remote", "origin", ref], options);
  if (!probe.present) return null;
  const sha = probe.stdout.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * The SHA of `origin/main`, or null when the remote has no `main` branch.
 *
 * @param {ExecOptions} [options]
 * @returns {string | null}
 */
export function remoteMainSha(options = {}) {
  return remoteRefSha("refs/heads/main", options);
}

/**
 * The configured `user.signingkey`, or null when unset.
 *
 * @param {ExecOptions} [options]
 * @returns {string | null}
 */
export function configuredSigningKey(options = {}) {
  let result;
  try {
    result = git(["config", "--get", "user.signingkey"], options);
  } catch (err) {
    // `git config --get` exits 1 when the key is unset: treated as absent.
    if (err instanceof CommandError && err.status === 1) return null;
    throw err;
  }
  return result.stdout.trim() || null;
}

/**
 * The configured `gpg.program`, or "gpg" when unset (git's default).
 *
 * @param {ExecOptions} [options]
 * @returns {string}
 */
export function gpgProgram(options = {}) {
  let result;
  try {
    result = git(["config", "--get", "gpg.program"], options);
  } catch (err) {
    // `git config --get` exits 1 when the program is unset.
    if (err instanceof CommandError && err.status === 1) return "gpg";
    throw err;
  }
  return result.stdout.trim() || "gpg";
}
