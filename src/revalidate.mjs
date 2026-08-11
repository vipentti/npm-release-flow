/**
 * Revalidation script: runs twice in the protected job — once after
 * the tag probe and artifact validation (before any secret loads), once
 * immediately before tag creation (TOCTOU guard). Requires the triggering
 * SHA still reachable from `origin/main` and the three control files at
 * `origin/main` still identical to the triggering commit. `GH_TOKEN` only;
 * no secrets on this path.
 */

import { describeFailure } from "./lib/errors.mjs";
import { git } from "./lib/repo-state.mjs";
import { runAsScript } from "./lib/run-script.mjs";

const RELEASE_FILES = ["CHANGELOG.md", "package.json", "package-lock.json"];

/**
 * @typedef {object} RevalidateOptions
 * @property {string} [cwd] Repository root (the consumer workspace).
 * @property {NodeJS.ProcessEnv} [env] Environment (GITHUB_SHA, GH_TOKEN).
 * @property {(line: string) => void} [log] Output sink.
 */

/**
 * @param {string} line
 * @returns {void}
 */
function consoleError(line) {
  console.error(line);
}

/**
 * Run the revalidation script.
 *
 * @param {RevalidateOptions} [options]
 * @returns {Promise<number>} 0 when the release is still valid, 1 otherwise.
 */
export async function revalidate(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? consoleError;
  const ctx = { cwd, env };

  const afterSha = env.GITHUB_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(afterSha)) {
    log(
      describeFailure({
        checked: "GITHUB_SHA",
        found:
          afterSha === ""
            ? "the environment variable is not set"
            : `${JSON.stringify(afterSha)} is not a 40-character SHA`,
        correction: "run in the GitHub Actions workflow context",
      }),
    );
    return 1;
  }

  try {
    git(["fetch", "origin", "main"], ctx);
  } catch {
    log(
      describeFailure({
        checked: "origin/main",
        found: "git fetch origin main failed",
        correction: "ensure the workflow token can read the default branch",
      }),
    );
    return 1;
  }

  // Ancestry: the triggering SHA must still be reachable from origin/main.
  try {
    git(["merge-base", "--is-ancestor", afterSha, "origin/main"], ctx);
  } catch {
    log(
      describeFailure({
        checked:
          "that the triggering commit is still reachable from origin/main",
        found: `${afterSha.slice(0, 8)} is not an ancestor of origin/main`,
        correction:
          "re-run on a fresh push; the release request was superseded",
      }),
    );
    return 1;
  }

  // Control-file equality: the three files at origin/main must still match
  // the triggering commit exactly.
  try {
    git(
      ["diff", "--quiet", afterSha, "origin/main", "--", ...RELEASE_FILES],
      ctx,
    );
  } catch {
    log(
      describeFailure({
        checked: `that the three control files at origin/main still equal the triggering commit (${afterSha.slice(0, 8)})`,
        found: `git diff --quiet ${afterSha.slice(0, 8)} origin/main -- ${RELEASE_FILES.join(" ")} is non-empty`,
        correction:
          "re-run on a fresh push; the release state changed since the merge",
      }),
    );
    return 1;
  }

  return 0;
}

runAsScript(import.meta.url, revalidate);
