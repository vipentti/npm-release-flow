/**
 * `check` command (blueprint §8): non-mutating setup validation of the
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

import { describeFailure } from "../lib/errors.mjs";
import { CommandError } from "../lib/errors.mjs";
import { git, gh } from "../lib/repo-state.mjs";
import { hasUnreleasedSection } from "../lib/changelog.mjs";
import {
  commitSigningState,
  fingerprintSigningState,
} from "../lib/tag-verify.mjs";

/**
 * Secrets the release workflow requires (names only, §5).
 * @type {readonly string[]}
 */
const REQUIRED_SECRETS = Object.freeze([
  "NPM_RELEASE_FLOW_GPG_PRIVATE_KEY",
  "NPM_RELEASE_FLOW_GPG_PASSPHRASE",
  "NPM_RELEASE_FLOW_GPG_PUBLIC_KEY",
  "NPM_RELEASE_FLOW_APP_PRIVATE_KEY",
]);

/**
 * Variables the release workflow requires (names only, §6/§10).
 * @type {readonly string[]}
 */
const REQUIRED_VARIABLES = Object.freeze([
  "NPM_RELEASE_FLOW_GPG_FINGERPRINT",
  "NPM_RELEASE_FLOW_APP_ID",
  "NPM_RELEASE_FLOW_GIT_NAME",
  "NPM_RELEASE_FLOW_GIT_EMAIL",
]);

/**
 * @typedef {Object} CheckOptions
 * @property {string} [cwd] Repository root the command operates on.
 * @property {NodeJS.ProcessEnv} [env] Environment.
 * @property {(line: string) => void} [log] Output sink.
 */

/**
 * @param {string} line
 * @returns {void}
 */
function consoleLog(line) {
  console.log(line);
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
 * Run `gh api` for the current repository and return the parsed JSON, or
 * null when the call fails.
 *
 * @param {string} endpoint
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {Record<string, any> | null}
 */
function ghApi(endpoint, ctx) {
  try {
    const result = gh(["api", endpoint], ctx);
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
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

  // --- The three control files (§4) ---

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

  let lockfileCommitted = false;
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
      lockfileCommitted = true;
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
            correction: "ensure this is a git repository with a committed lockfile",
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
    const detail =
      err instanceof CommandError ? err.stderr.trim() : String(err);
    problems.push(
      describeFailure({
        checked: "the repository identity via gh repo view",
        found: detail || "gh repo view failed",
        correction: "check gh auth and that the current directory is a GitHub repository",
      }),
    );
  }

  if (nameWithOwner !== null) {
    const secrets = ghApi(`repos/${nameWithOwner}/actions/secrets`, ctx);
    if (secrets === null) {
      problems.push(
        describeFailure({
          checked: `the actions secrets of ${nameWithOwner}`,
          found: "the secrets list could not be read",
          correction: "check gh permissions on the repository",
        }),
      );
    } else {
          const present = new Set(
            (/** @type {Array<{ name: string }>} */ (secrets.secrets ?? [])).map(
              (entry) => entry.name,
            ),
          );
      for (const required of REQUIRED_SECRETS) {
        if (!present.has(required)) {
          problems.push(
            describeFailure({
              checked: `the ${required} secret`,
              found: "it is not set on the repository",
              correction:
                "set it as an Actions secret (values are never read by this command)",
            }),
          );
        }
      }
    }

    const variables = ghApi(`repos/${nameWithOwner}/actions/variables`, ctx);
    if (variables === null) {
      problems.push(
        describeFailure({
          checked: `the actions variables of ${nameWithOwner}`,
          found: "the variables list could not be read",
          correction: "check gh permissions on the repository",
        }),
      );
    } else {
      const present = new Set(
        (/** @type {Array<{ name: string }>} */ (variables.variables ?? [])).map(
          (entry) => entry.name,
        ),
      );
      for (const required of REQUIRED_VARIABLES) {
        if (!present.has(required)) {
          problems.push(
            describeFailure({
              checked: `the ${required} variable`,
              found: "it is not set on the repository",
              correction:
                "declare it as an Actions variable (values are never read by this command)",
            }),
          );
        }
      }
    }

    const environments = ghApi(
      `repos/${nameWithOwner}/environments`,
      ctx,
    );
    const environmentNames = new Set(
      (/** @type {Array<{ name: string }>} */ (environments?.environments ?? [])).map(
        (entry) => entry.name,
      ),
    );
    if (!environmentNames.has("release")) {
      problems.push(
        describeFailure({
          checked: "the release Environment",
          found: "no Environment named release exists",
          correction:
            "create a release Environment with a required reviewer",
        }),
      );
    } else {
      const releaseEnv = ghApi(
        `repos/${nameWithOwner}/environments/release`,
        ctx,
      );
      const rules = /** @type {Array<{ type?: string }>} */ (
        releaseEnv?.protection_rules ?? []
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

    const installation = ghApi(
      `repos/${nameWithOwner}/installation`,
      ctx,
    );
    if (installation === null) {
      problems.push(
        describeFailure({
          checked: `that the release GitHub App is installed on ${nameWithOwner}`,
          found: "the App installation could not be resolved",
          correction:
            "install the release GitHub App on the repository with contents: write",
        }),
      );
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

  /** @param {string} key @returns {string} */
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

  const appPrivateKey = env.NPM_RELEASE_FLOW_APP_PRIVATE_KEY ?? "";
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
