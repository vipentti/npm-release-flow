/**
 * Detect job script: classifies a push to main. Env-driven:
 * `BEFORE_SHA` (the previous push tip), `GITHUB_SHA` (the triggering commit),
 * `GITHUB_REPOSITORY` (owner/name), `GH_TOKEN` (gh auth). Binds HEAD to
 * `GITHUB_SHA`, validates the mandatory consumer prerequisites (CHANGELOG
 * release-intent signal, `release:verify` script, committed lockfile) before
 * any verdict, classifies per the release-state enumeration, performs the
 * skew-marker read only on the valid-release branch, and writes the declared
 * outputs (`is-release`, `version`) to `GITHUB_OUTPUT`.
 *
 * Exit codes: 0 ordinary push or valid release, 1 hard fail. Ordinary pushes
 * never touch the PR API.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CommandError,
  commandFailureDetail,
  describeFailure,
} from "./lib/errors.mjs";
import { git, gh, localRefSha } from "./lib/repo-state.mjs";
import { parseStableVersion } from "./lib/versions.mjs";
import { classifyRelease } from "./lib/release-state.mjs";
import { mandatoryPrerequisiteProblem } from "./lib/control-files.mjs";
import { runAsScript } from "./lib/run-script.mjs";

const zeroSha = "0000000000000000000000000000000000000000";
const shaPattern = /^[0-9a-f]{40}$/;

/**
 * @typedef {object} DetectOptions
 * @property {string} [cwd] Repository root (the consumer tree).
 * @property {NodeJS.ProcessEnv} [env] Environment (BEFORE_SHA, GITHUB_SHA,
 *   GITHUB_REPOSITORY, GH_TOKEN, GITHUB_OUTPUT...).
 * @property {(line: string) => void} [log] Output sink (diagnostics).
 */

/**
 * @param {string} line
 * @returns {void}
 */
function consoleError(line) {
  console.error(line);
}

/**
 * @param {string} cwd
 * @param {string} name
 * @returns {string | null}
 */
function tryReadFile(cwd, name) {
  try {
    return readFileSync(resolve(cwd, name), "utf8");
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd
 * @param {string} name
 * @returns {Record<string, any> | null}
 */
function tryReadJson(cwd, name) {
  const text = tryReadFile(cwd, name);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd
 * @param {string} rev
 * @param {string} path
 * @returns {string | null}
 */
function showFile(cwd, rev, path) {
  try {
    return git(["show", `${rev}:${path}`], { cwd }).stdout;
  } catch (err) {
    if (err instanceof CommandError && err.status === 128) return null;
    throw err;
  }
}

/**
 * @param {string} cwd
 * @param {string} rev
 * @param {string} path
 * @returns {Record<string, any> | null}
 */
function showJson(cwd, rev, path) {
  const text = showFile(cwd, rev, path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Write a GITHUB_OUTPUT entry (workflow convention: `name=value` lines).
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {string} value
 */
function writeOutput(env, name, value) {
  const outputPath = env.GITHUB_OUTPUT;
  const line = `${name}=${value}\n`;
  if (outputPath) {
    appendFileSync(outputPath, line, "utf8");
  } else {
    // Direct invocation (tests): fall back to stdout.
    process.stdout.write(line);
  }
}

/**
 * Validate the mandatory consumer prerequisites (CHANGELOG release-intent
 * signal, `release:verify` script, committed lockfile) before any verdict.
 * (Shared implementation lives in control-files.mjs.)
 */

/**
 * The skew-marker read: resolve the pull requests associated with the
 * triggering commit via `gh api .../commits/{sha}/pulls`, select the one
 * whose head is the expected `release/v<version>` branch (base main), read
 * its body, extract the `Kit: @vipentti/npm-release-flow@<version>` marker,
 * and compare it with the kit checkout's version at
 * `.npm-release-flow/package.json`. Release identity comes from the release
 * classification, not the commit message; the PR association is needed only
 * for the skew marker. Any failure is a hard fail (fail closed).
 *
 * @param {string} version The released version.
 * @param {string} afterSha The triggering commit SHA.
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | null} The problem, or null when the marker agrees.
 */
function skewMarkerProblem(version, afterSha, cwd, env) {
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    return describeFailure({
      checked: "GITHUB_REPOSITORY",
      found: JSON.stringify(repository),
      correction: "the workflow must run in the consumer repository",
    });
  }
  const expectedHead = `release/v${version}`;
  /** @type {Array<{ number: number, state: string, base: string, head: string, body: string | null }>} */
  let pulls;
  try {
    const result = gh(
      [
        "api",
        `repos/${repository}/commits/${afterSha}/pulls`,
        "--paginate",
        "--jq",
        `.[] | {number, base: .base.ref, head: .head.ref, body}`,
      ],
      { cwd, env },
    );
    pulls =
      result.stdout.trim() === ""
        ? []
        : result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
  } catch (err) {
    const detail = commandFailureDetail(err);
    return describeFailure({
      checked: `the pull requests associated with the triggering commit ${afterSha.slice(0, 8)} via gh api`,
      found: detail || "gh api failed",
      correction:
        "ensure the commit's pull requests are readable with the pull-requests-read token",
    });
  }
  const releasePulls = pulls.filter(
    (pr) => pr.head === expectedHead && pr.base === "main",
  );
  if (releasePulls.length === 0) {
    return describeFailure({
      checked: `the pull request for ${expectedHead} among the commits associated with ${afterSha.slice(0, 8)}`,
      found:
        pulls.length === 0
          ? "no pull request is associated with the triggering commit"
          : `no associated pull request has head ${expectedHead} on base main`,
      correction:
        "merge the release branch release/v<version> into main via a pull request",
    });
  }
  const body = releasePulls[0].body ?? "";
  const marker = /^Kit: @vipentti\/npm-release-flow@(\d+\.\d+\.\d+)$/m.exec(
    body,
  );
  if (!marker) {
    return describeFailure({
      checked: "the Kit skew marker in the release PR body",
      found: "no 'Kit: @vipentti/npm-release-flow@<version>' line is present",
      correction:
        "prepare the release with a current kit version so the marker is stamped",
    });
  }
  const kitPackage = tryReadJson(cwd, ".npm-release-flow/package.json");
  const kitVersion =
    kitPackage !== null && typeof kitPackage.version === "string"
      ? kitPackage.version
      : null;
  if (kitVersion === null) {
    return describeFailure({
      checked: "the kit checkout version at .npm-release-flow/package.json",
      found: "the kit package.json is missing or has no version",
      correction:
        "check out the kit at the pinned workflow SHA into .npm-release-flow",
    });
  }
  if (marker[1] !== kitVersion) {
    return describeFailure({
      checked:
        "that the kit version that prepared the release equals the kit checkout version",
      found: `PR body stamps ${marker[1]}, but .npm-release-flow/package.json is ${kitVersion}`,
      correction:
        "move both pins (CLI devDependency and workflow SHA) in a single upgrade PR",
    });
  }
  return null;
}

/**
 * Run the detect job script.
 *
 * @param {DetectOptions} [options]
 * @returns {Promise<number>} 0 ordinary/valid, 1 hard fail.
 */
export async function detect(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? consoleError;
  const ctx = { cwd, env };

  /**
   * @param {string} message
   * @returns {number}
   */
  const fail = (message) => {
    log(message);
    return 1;
  };

  // --- Input validation (fail closed) ---

  const afterSha = env.GITHUB_SHA ?? "";
  if (!shaPattern.test(afterSha)) {
    return fail(
      describeFailure({
        checked: "GITHUB_SHA",
        found:
          afterSha === ""
            ? "the environment variable is not set"
            : `${JSON.stringify(afterSha)} is not a 40-character SHA`,
        correction: "run in a GitHub Actions workflow context",
      }),
    );
  }
  const beforeSha = env.BEFORE_SHA ?? "";
  if (!shaPattern.test(beforeSha) || beforeSha === zeroSha) {
    return fail(
      describeFailure({
        checked: "the previous push SHA (github.event.before)",
        found:
          beforeSha === ""
            ? "BEFORE_SHA is not set"
            : `${JSON.stringify(beforeSha)} is malformed or all-zero`,
        correction: "run on a push event with a resolvable previous SHA",
      }),
    );
  }

  // Bind HEAD to the triggering SHA; an unresolvable SHA is a hard fail.
  let headSha;
  try {
    headSha = git(["rev-parse", "HEAD"], ctx).stdout.trim();
  } catch {
    return fail(
      describeFailure({
        checked: "HEAD",
        found: "HEAD could not be resolved",
        correction: "run inside the consumer git checkout",
      }),
    );
  }
  if (headSha !== afterSha) {
    try {
      git(["checkout", "--detach", afterSha], ctx);
    } catch (err) {
      const detail = commandFailureDetail(err);
      return fail(
        describeFailure({
          checked: "binding HEAD to the triggering SHA",
          found: detail || "git checkout failed",
          correction: "ensure the triggering SHA is present in the checkout",
        }),
      );
    }
  }

  // Mandatory prerequisites (CHANGELOG release-intent signal, `release:verify`
  // script, committed lockfile) before any verdict.
  const prerequisite = mandatoryPrerequisiteProblem(ctx);
  if (prerequisite !== null) {
    return fail(prerequisite);
  }

  // --- Release-state classification ---

  const afterPkg = tryReadJson(cwd, "package.json");
  const afterVersion =
    afterPkg !== null && typeof afterPkg.version === "string"
      ? afterPkg.version
      : null;
  const tagTarget =
    afterVersion !== null && parseStableVersion(afterVersion) !== null
      ? localRefSha(`refs/tags/v${afterVersion}`, ctx)
      : null;

  const verdict = classifyRelease({
    beforeResolved: true,
    headMatchesTrigger: true,
    beforePkg: showJson(cwd, beforeSha, "package.json"),
    afterPkg,
    beforeLock: showJson(cwd, beforeSha, "package-lock.json"),
    afterLock: tryReadJson(cwd, "package-lock.json"),
    changedFiles: git(["diff", "--name-only", beforeSha, afterSha], ctx)
      .stdout.trim()
      .split("\n")
      .filter(Boolean),
    changelog: tryReadFile(cwd, "CHANGELOG.md"),
    tagTarget,
    afterSha,
  });

  if (verdict.verdict === "ordinary") {
    writeOutput(env, "is-release", "false");
    writeOutput(env, "version", "");
    return 0;
  }
  if (verdict.verdict === "valid") {
    const skewProblem = skewMarkerProblem(
      /** @type {string} */ (verdict.version),
      afterSha,
      cwd,
      env,
    );
    if (skewProblem !== null) {
      return fail(skewProblem);
    }
    writeOutput(env, "is-release", "true");
    writeOutput(env, "version", /** @type {string} */ (verdict.version));
    return 0;
  }
  return fail(verdict.reasons[0] ?? "the push is not a valid release");
}

runAsScript(import.meta.url, detect);
