/**
 * `check` command: non-mutating setup validation of the
 * consumer's release prerequisites. Exits 0 when everything passes; exits 1
 * listing every problem with the error-content contract; never mutates.
 * `--execute` is accepted as a no-op for surface uniformity.
 *
 * Checks: the three control files (CHANGELOG.md with `## [Unreleased]`, a
 * `release:verify` script, a committed lockfile), secrets and variables
 * presence by name via `gh api` (names only, never values), the `release`
 * Environment with required-reviewer protection, App-tag path readiness,
 * local git/gh state, and both signing preflights (`prepare` and `tag` gate
 * on the same checks).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { commandFailureDetail, describeFailure } from "../lib/errors.mjs";
import { CommandError } from "../lib/errors.mjs";
import { git, gh } from "../lib/repo-state.mjs";
import { hasUnreleasedSection } from "../lib/changelog.mjs";
import {
  commitSigningState,
  fingerprintSigningState,
} from "../lib/tag-verify.mjs";
import { resolveInstallation } from "../lib/app-token.mjs";

/**
 * Secrets the release workflow requires (names only).
 * @type {readonly string[]}
 */
const REQUIRED_SECRETS = Object.freeze([
  "NPM_RELEASE_FLOW_GPG_PRIVATE_KEY",
  "NPM_RELEASE_FLOW_GPG_PASSPHRASE",
  "NPM_RELEASE_FLOW_GPG_PUBLIC_KEY",
  "NPM_RELEASE_FLOW_APP_PRIVATE_KEY",
]);

/**
 * Variables the release workflow requires (names only).
 * @type {readonly string[]}
 */
const REQUIRED_VARIABLES = Object.freeze([
  "NPM_RELEASE_FLOW_GPG_FINGERPRINT",
  "NPM_RELEASE_FLOW_APP_ID",
  "NPM_RELEASE_FLOW_GIT_NAME",
  "NPM_RELEASE_FLOW_GIT_EMAIL",
]);

/**
 * @typedef {object} CheckOptions
 * @property {string} [cwd] Repository root the command operates on.
 * @property {NodeJS.ProcessEnv} [env] Environment.
 * @property {(line: string) => void} [log] Output sink.
 */

/**
 * @param {string} line
 * @returns {void}
 */
function consoleLog(line) {
  // Problems are diagnostics: stderr, like every other failure message.
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
 * Whether a gh api failure means the resource is absent. `gh api` exits 1
 * for every HTTP error; a 404 is recognizable from gh's stderr (and from a
 * numeric exit status when a direct probe is used).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isNotFound(err) {
  if (!(err instanceof CommandError)) return false;
  if (err.status === 404) return true;
  return /(?:^|\D)404(?:\D|$)/.test(err.stderr);
}

/**
 * Execute the check flow.
 *
 * @param {{ version?: string, execute: boolean }} args (`version` is unused;
 *   `execute` is accepted as a no-op).
 * @param {CheckOptions} [options]
 * @returns {Promise<number>} 0 when everything passes, 1 when any problem
 *   was found (all problems are listed).
 */
export async function check(args, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? consoleLog;
  const ctx = { cwd, env };
  /** @type {string[]} */
  const problems = [];

  // --- The three control files (CHANGELOG.md, package.json, lockfile) ---

  const changelog = tryReadFile(cwd, "CHANGELOG.md");
  if (changelog === null) {
    problems.push(
      describeFailure({
        checked: "the CHANGELOG.md control file",
        found: "CHANGELOG.md is missing",
        correction:
          "add a CHANGELOG.md with a ## [Unreleased] section before releasing",
      }),
    );
  } else if (!hasUnreleasedSection(changelog)) {
    problems.push(
      describeFailure({
        checked: "the ## [Unreleased] section in CHANGELOG.md",
        found:
          "the changelog has no bare ## [Unreleased] heading (or it has more than one)",
        correction: "declare exactly one ## [Unreleased] section",
      }),
    );
  }

  const pkg = tryReadJson(cwd, "package.json");
  const verifyScript =
    pkg !== null &&
    typeof pkg.scripts === "object" &&
    pkg.scripts !== null &&
    typeof pkg.scripts["release:verify"] === "string" &&
    pkg.scripts["release:verify"] !== "";
  if (!verifyScript) {
    problems.push(
      describeFailure({
        checked: "the release:verify script in package.json",
        found:
          pkg === null
            ? "package.json is missing or not valid JSON"
            : "no non-empty scripts.release:verify is declared",
        correction:
          "declare the consumer's release verification under scripts.release:verify",
      }),
    );
  }

  const lockfileText = tryReadFile(cwd, "package-lock.json");
  if (lockfileText === null) {
    problems.push(
      describeFailure({
        checked: "the package-lock.json lockfile",
        found: "package-lock.json is missing",
        correction: "generate and commit a lockfile",
      }),
    );
  } else {
    try {
      git(["ls-files", "--error-unmatch", "package-lock.json"], ctx);
    } catch (err) {
      if (err instanceof CommandError && err.status === 1) {
        problems.push(
          describeFailure({
            checked: "that the lockfile is committed",
            found: "package-lock.json exists but is not tracked by git",
            correction: "git add package-lock.json and commit it",
          }),
        );
      } else {
        problems.push(
          describeFailure({
            checked: "that the lockfile is committed",
            found: "git ls-files failed",
            correction:
              "ensure this is a git repository with a committed lockfile",
          }),
        );
      }
    }
  }

  // --- Repository identity and GitHub-side state (gh api, names only) ---

  let nameWithOwner = null;
  try {
    nameWithOwner = gh(
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      ctx,
    ).stdout.trim();
  } catch (err) {
    const detail = commandFailureDetail(err);
    problems.push(
      describeFailure({
        checked: "the repository identity via gh repo view",
        found: detail || "gh repo view failed",
        correction:
          "check gh auth and that the current directory is a GitHub repository",
      }),
    );
  }

  const appPrivateKey = env.NPM_RELEASE_FLOW_APP_PRIVATE_KEY ?? "";

  if (nameWithOwner !== null) {
    // Secrets: each required secret by its exact resource endpoint (404 =
    // not set; no collection listing, so pagination cannot hide an item).
    for (const name of REQUIRED_SECRETS) {
      try {
        gh(["api", `repos/${nameWithOwner}/actions/secrets/${name}`], ctx);
      } catch (err) {
        if (isNotFound(err)) {
          problems.push(
            describeFailure({
              checked: `the ${name} secret`,
              found: "it is not set on the repository",
              correction:
                "set it as an Actions secret (values are never read by this command)",
            }),
          );
        } else {
          problems.push(
            describeFailure({
              checked: `the ${name} secret`,
              found: "the secret could not be read",
              correction: "check gh permissions on the repository",
            }),
          );
        }
      }
    }

    // Variables: each required variable by its exact resource endpoint. The
    // App ID value is read (public) to authenticate the installation probe.
    /** @type {string | null} */
    let appId = null;
    for (const name of REQUIRED_VARIABLES) {
      try {
        if (name === "NPM_RELEASE_FLOW_APP_ID") {
          const result = gh(
            [
              "api",
              `repos/${nameWithOwner}/actions/variables/${name}`,
              "--jq",
              ".value",
            ],
            ctx,
          );
          appId = result.stdout.trim();
        } else {
          gh(["api", `repos/${nameWithOwner}/actions/variables/${name}`], ctx);
        }
      } catch (err) {
        if (isNotFound(err)) {
          problems.push(
            describeFailure({
              checked: `the ${name} variable`,
              found: "it is not set on the repository",
              correction:
                "declare it as an Actions variable (only the App ID value is read by this command)",
            }),
          );
        } else {
          problems.push(
            describeFailure({
              checked: `the ${name} variable`,
              found: "the variable could not be read",
              correction: "check gh permissions on the repository",
            }),
          );
        }
      }
    }

    // release Environment: direct resource query.
    let releaseEnv = null;
    try {
      const result = gh(
        ["api", `repos/${nameWithOwner}/environments/release`],
        ctx,
      );
      releaseEnv = JSON.parse(result.stdout);
    } catch (err) {
      problems.push(
        describeFailure({
          checked: "the release Environment",
          found: isNotFound(err)
            ? "no Environment named release exists"
            : "the Environment could not be read",
          correction: "create a release Environment with a required reviewer",
        }),
      );
    }
    if (releaseEnv !== null) {
      const rules = /** @type {Array<{ type?: string }>} */ (
        releaseEnv.protection_rules ?? []
      );
      const hasReviewerGate = rules.some(
        (rule) =>
          rule.type === "required_reviewers" ||
          rule.type === "required_deployment_reviews",
      );
      if (!hasReviewerGate) {
        problems.push(
          describeFailure({
            checked: "the release Environment's protection rules",
            found:
              "the Environment exists but has no required-reviewer protection",
            correction:
              "add a required reviewer to the release Environment (no approval gate otherwise)",
          }),
        );
      }
    }

    // App installation: App-JWT authenticated lookup (the endpoint is
    // documented as App-only; user tokens cannot read it). Skipped when the
    // App ID variable or the private key is already reported missing.
    const slashIndex = nameWithOwner.indexOf("/");
    if (
      appId !== null &&
      appId !== "" &&
      appPrivateKey !== "" &&
      slashIndex > 0 &&
      slashIndex < nameWithOwner.length - 1
    ) {
      const owner = nameWithOwner.slice(0, slashIndex);
      const repo = nameWithOwner.slice(slashIndex + 1);
      try {
        const installation = await resolveInstallation({
          appId,
          privateKey: appPrivateKey,
          owner,
          repo,
        });
        const contentsPermission = installation.permissions?.contents;
        if (contentsPermission !== "write") {
          problems.push(
            describeFailure({
              checked: `that the release GitHub App has contents: write on ${nameWithOwner}`,
              found:
                contentsPermission === undefined
                  ? "the installation response carries no contents permission"
                  : `the App has contents: ${contentsPermission}`,
              correction:
                "grant the release App contents: write (required for the tag push and GitHub Release)",
            }),
          );
        }
      } catch (err) {
        problems.push(
          describeFailure({
            checked: `that the release GitHub App is installed on ${nameWithOwner}`,
            found: err instanceof Error ? err.message : String(err),
            correction:
              "install the release GitHub App on the repository with contents: write",
          }),
        );
      }
    }
  }

  // --- Local git/gh state and signing preflights ---

  try {
    gh(["auth", "status"], ctx);
  } catch {
    problems.push(
      describeFailure({
        checked: "gh authentication",
        found: "gh auth status failed",
        correction: "run gh auth login",
      }),
    );
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  const getConfig = (key) => {
    try {
      return git(["config", "--get", key], ctx).stdout.trim();
    } catch {
      return "";
    }
  };
  const userName = getConfig("user.name");
  const userEmail = getConfig("user.email");
  if (userName === "" || userEmail === "") {
    problems.push(
      describeFailure({
        checked: "the git identity",
        found:
          userName === "" && userEmail === ""
            ? "neither user.name nor user.email is configured"
            : userName === ""
              ? "user.name is not configured"
              : "user.email is not configured",
        correction: "set git config user.name and user.email",
      }),
    );
  }

  const commitSigning = commitSigningState(ctx);
  if (!commitSigning.ok) {
    problems.push(commitSigning.message);
  }

  const fingerprintSigning = fingerprintSigningState(ctx);
  if (!fingerprintSigning.ok) {
    problems.push(fingerprintSigning.message);
  }

  if (appPrivateKey === "") {
    problems.push(
      describeFailure({
        checked: "NPM_RELEASE_FLOW_APP_PRIVATE_KEY in the local environment",
        found: "the environment variable is not set or empty",
        correction:
          "export the release App's PEM private key (secrets are never API-readable)",
      }),
    );
  }

  // --- Report ---

  if (problems.length > 0) {
    for (const problem of problems) {
      log(problem);
    }
    log(`Found ${problems.length} problem(s).`);
    return 1;
  }
  log("All release prerequisites pass.");
  return 0;
}
