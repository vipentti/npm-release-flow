/**
 * `prepare` command (blueprint §8, §9 boundaries 1-2, concept-doc flow):
 * cut a release branch for `--version X.Y.Z` and open the release PR.
 *
 * Dry-run is the default; `--execute` performs the mutations. Rerun
 * semantics: an open or merged release PR for `release/vX.Y.Z` exits 2
 * (no-op / already done) even when `main` already carries the version or
 * matching branches exist; a closed-unmerged PR exits 1 (manual action);
 * conflicting local/remote branches or tags exit 1.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CliError,
  CommandError,
  ExitCode,
  describeFailure,
} from "../lib/errors.mjs";
import { runSync } from "../lib/spawn.mjs";
import {
  git,
  gh,
  isCleanWorktree,
  currentSha,
  remoteMainSha,
  remoteRefSha,
  localRefSha,
  configuredSigningKey,
  gpgProgram,
} from "../lib/repo-state.mjs";
import { parseStableVersion, isStrictIncrease } from "../lib/versions.mjs";
import {
  cutChangelog,
  unreleasedState,
  todayUtc,
  validReleasedChangelog,
} from "../lib/changelog.mjs";
import {
  RELEASE_FILES,
  isReleaseDiff,
  lockfileVersionMismatch,
  packageIdentityMismatch,
} from "../lib/control-files.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const kitRoot = resolve(moduleDir, "..", "..");
/** @type {string} */
const kitVersion = JSON.parse(
  readFileSync(resolve(kitRoot, "package.json"), "utf8"),
).version;

/**
 * @param {string} line
 * @returns {void}
 */
function consoleLog(line) {
  console.log(line);
}

/**
 * Derive the compare URL from `package.json` `repository.url`
 * (e.g. "git+https://github.com/owner/repo.git" ->
 * "https://github.com/owner/repo/compare"), or null when the URL is not a
 * GitHub URL.
 *
 * @param {unknown} repoUrl
 * @returns {string | null}
 */
export function compareUrlFromRepoUrl(repoUrl) {
  if (typeof repoUrl !== "string") return null;
  let url = repoUrl.trim();
  if (url.startsWith("git+")) url = url.slice(4);
  if (url.endsWith(".git")) url = url.slice(0, -4);
  if (url.startsWith("https://github.com/")) {
    return `${url.replace(/\/+$/, "")}/compare`;
  }
  return null;
}

/**
 * @typedef {Object} PrepareOptions
 * @property {string} [cwd] Repository root the command operates on.
 * @property {NodeJS.ProcessEnv} [env] Environment (PATH shims, GNUPGHOME...).
 * @property {(line: string) => void} [log] Plan-line sink (defaults to
 *   console.log) so tests can capture output.
 */

/**
 * Read a JSON file from the repository root.
 *
 * @param {string} cwd
 * @param {string} name
 * @returns {Record<string, any>}
 */
function readJson(cwd, name) {
  const path = resolve(cwd, name);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CliError(
      describeFailure({
        checked: `the ${name} control file`,
        found:
          err instanceof Error && "code" in err && err.code === "ENOENT"
            ? `${name} is missing`
            : `${name} is not valid JSON`,
        correction: `commit a readable ${name}`,
      }),
    );
  }
}

/**
 * Read the changelog from the repository root.
 *
 * @param {string} cwd
 * @returns {string}
 */
function readChangelog(cwd) {
  const path = resolve(cwd, "CHANGELOG.md");
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new CliError(
      describeFailure({
        checked: "the CHANGELOG.md control file",
        found:
          err instanceof Error && "code" in err && err.code === "ENOENT"
            ? "CHANGELOG.md is missing"
            : "CHANGELOG.md could not be read",
        correction: "commit a readable CHANGELOG.md with an [Unreleased] section",
      }),
    );
  }
}

/**
 * Read-only signing preflight: prove Git's configured commit-signing key is
 * configured and locally available in the (GNUPGHOME-scoped) keyring before
 * the first mutation. `git commit -S` later uses the same keyring; the check
 * goes through the same gpg program (`gpg.program`, default `gpg`) and the
 * same keyring (`--homedir` mirrors git's GNUPGHOME inheritance, explicit
 * because some gpg builds ignore the env var).
 *
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} The configured signing key fingerprint.
 */
function signingPreflight(cwd, env) {
  const key = configuredSigningKey({ cwd, env });
  if (!key) {
    throw new CliError(
      describeFailure({
        checked: "git's configured commit-signing key (user.signingkey)",
        found: "no user.signingkey is configured",
        correction:
          "configure user.signingkey with the fingerprint of the key that must sign release commits",
      }),
    );
  }
  const program = gpgProgram({ cwd, env });
  const args = ["--batch"];
  if (env.GNUPGHOME) {
    args.push("--homedir", env.GNUPGHOME);
  }
  args.push("--list-secret-keys", key);
  try {
    runSync(program, args, { cwd, env });
  } catch (err) {
    const detail =
      err instanceof CommandError
        ? err.stderr.trim() || err.message
        : String(err);
    throw new CliError(
      describeFailure({
        checked: `that the configured signing key ${key} is locally available in the GPG keyring`,
        found: detail,
        correction:
          "import or restore the secret key in the local GPG home (GNUPGHOME)",
      }),
    );
  }
  return key;
}

/**
 * Build a CliError with the error-content contract plus partial-failure
 * state (what was created, what remains manual).
 *
 * @param {string} checked
 * @param {string} found
 * @param {string} correction
 * @param {string} created
 * @param {string} manual
 * @returns {CliError}
 */
function mutationError(checked, found, correction, created, manual) {
  return new CliError(
    `${describeFailure({ checked, found, correction })} Created: ${created}. Remaining manual: ${manual}.`,
  );
}

/**
 * Execute the prepare flow.
 *
 * @param {{ version: string, execute: boolean }} args
 * @param {PrepareOptions} [options]
 * @returns {Promise<number>} The exit code (0 on success; failures throw
 *   CliError carrying their exit code).
 */
export async function prepare(args, options = {}) {
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
  const branchName = `release/v${version}`;
  const date = todayUtc();

  /** @param {string} msg @returns {void} */
  const plan = (msg) => log(`${execute ? "[exec]" : "[dry-run]"} ${msg}`);

  plan(`Subcommand: prepare`);
  plan(`Version: ${version}`);
  plan(`Branch: ${branchName}`);
  plan(`Release date: ${date}`);

  // --- Guards (read-only) ---

  if (!isCleanWorktree({ cwd, env })) {
    throw new CliError(
      describeFailure({
        checked: "the working tree",
        found: "uncommitted changes (git status --porcelain is non-empty)",
        correction: "commit or stash them before preparing a release",
      }),
    );
  }
  const headSha = currentSha({ cwd, env });
  const remoteMain = remoteMainSha({ cwd, env });
  if (remoteMain === null) {
    throw new CliError(
      describeFailure({
        checked: "origin/main",
        found: "the remote has no main branch",
        correction: "push a main branch to origin, then rerun",
      }),
    );
  }
  if (headSha !== remoteMain) {
    throw new CliError(
      describeFailure({
        checked: "HEAD against origin/main",
        found: `HEAD (${headSha.slice(0, 8)}) does not match origin/main (${remoteMain.slice(0, 8)})`,
        correction: "pull or rebase onto origin/main, then rerun",
      }),
    );
  }

  // Release PR state is resolved BEFORE any strict-increase rejection and
  // wins over matching local/remote branch presence (§9 boundaries 1-2).
  /** @type {Array<{ number: number, state: string, url: string }>} */
  let prs = [];
  try {
    const result = gh(
      [
        "pr",
        "list",
        "--head",
        branchName,
        "--base",
        "main",
        "--state",
        "all",
        "--json",
        "number,state,url",
      ],
      { cwd, env },
    );
    prs = JSON.parse(result.stdout || "[]");
  } catch (err) {
    const detail = err instanceof CommandError ? err.stderr.trim() : String(err);
    throw new CliError(
      describeFailure({
        checked: "release PR state for " + branchName,
        found: detail || "gh pr list failed",
        correction: "check gh auth and network, then rerun",
      }),
    );
  }
  const open = prs.filter((pr) => pr.state === "OPEN");
  const merged = prs.filter((pr) => pr.state === "MERGED");
  const closed = prs.filter((pr) => pr.state === "CLOSED");
  if (open.length > 0) {
    throw new CliError(
      describeFailure({
        checked: `release PR state for ${branchName}`,
        found: `an open release PR already exists (${open.map((pr) => pr.url).join(", ")})`,
        correction: "nothing to do; the release is already prepared",
      }),
      { exitCode: ExitCode.NOOP },
    );
  }
  if (merged.length > 0) {
    throw new CliError(
      describeFailure({
        checked: `release PR state for ${branchName}`,
        found: `a merged release PR already exists (${merged.map((pr) => pr.url).join(", ")})`,
        correction: "version already prepared; nothing to do",
      }),
      { exitCode: ExitCode.NOOP },
    );
  }
  if (closed.length > 0) {
    throw new CliError(
      describeFailure({
        checked: `release PR state for ${branchName}`,
        found: `a closed-unmerged release PR exists (${closed.map((pr) => pr.url).join(", ")})`,
        correction: "resolve it manually (reopen or delete it), then rerun",
      }),
    );
  }

  // Only with no matching PR: version strict-increase, branches, tags.
  const pkg = readJson(cwd, "package.json");
  const currentVersion =
    typeof pkg.version === "string" ? pkg.version : null;
  if (currentVersion === null) {
    throw new CliError(
      describeFailure({
        checked: "package.json.version",
        found: "the version field is missing or not a string",
        correction: "commit a package.json with a string version",
      }),
    );
  }
  const currentParsed = parseStableVersion(currentVersion);
  if (currentParsed === null || !isStrictIncrease(currentParsed, parsed)) {
    throw new CliError(
      describeFailure({
        checked: `whether ${version} strictly increases the current version`,
        found: `package.json.version is ${JSON.stringify(currentVersion)}`,
        correction: "choose a higher stable version",
      }),
    );
  }
  const localBranch = localRefSha(`refs/heads/${branchName}`, { cwd, env });
  if (localBranch !== null) {
    throw new CliError(
      describeFailure({
        checked: `the local release branch ${branchName}`,
        found: `it already exists (${localBranch.slice(0, 8)})`,
        correction: "delete or rename it, then rerun",
      }),
    );
  }
  const remoteBranch = remoteRefSha(`refs/heads/${branchName}`, { cwd, env });
  if (remoteBranch !== null) {
    throw new CliError(
      describeFailure({
        checked: `the remote release branch ${branchName}`,
        found: `it already exists (${remoteBranch.slice(0, 8)})`,
        correction: "resolve it manually (delete or merge it), then rerun",
      }),
    );
  }
  const tagRef = `refs/tags/v${version}`;
  const localTag = localRefSha(tagRef, { cwd, env });
  if (localTag !== null) {
    throw new CliError(
      describeFailure({
        checked: `the local tag v${version}`,
        found: `it already exists (${localTag.slice(0, 8)})`,
        correction: "delete or move it, or choose another version",
      }),
    );
  }
  const remoteTag = remoteRefSha(tagRef, { cwd, env });
  if (remoteTag !== null) {
    throw new CliError(
      describeFailure({
        checked: `the remote tag v${version}`,
        found: `it already exists (${remoteTag.slice(0, 8)})`,
        correction: "delete or move it, or choose another version",
      }),
    );
  }

  const changelog = readChangelog(cwd);
  const unreleased = unreleasedState(changelog);
  if (!unreleased.ok) {
    throw new CliError(
      describeFailure({
        checked: "the [Unreleased] changelog section",
        found: unreleased.reason ?? "the [Unreleased] section is invalid",
        correction:
          "add release notes under ## [Unreleased] before preparing a release",
      }),
    );
  }
  const repoUrl = pkg.repository?.url;
  const compareUrl = compareUrlFromRepoUrl(repoUrl);
  if (compareUrl === null) {
    throw new CliError(
      describeFailure({
        checked: "package.json repository.url",
        found: JSON.stringify(repoUrl ?? null),
        correction:
          "set repository.url to the GitHub repository (e.g. git+https://github.com/owner/repo.git)",
      }),
    );
  }

  // Read-only signing preflight: dry-run reports it, --execute refuses
  // without it. Failing here predicts the later `git commit -S` failure.
  const signingKey = signingPreflight(cwd, env);
  plan(`Signing preflight: commit-signing key ${signingKey} available`);

  plan(`Would cut the changelog for ${version} (${date})`);
  plan(`Would set package.json.version = ${version}`);
  plan(`Would set package-lock.json.version = ${version}`);
  plan(`Would set package-lock.json.packages[""].version = ${version}`);
  plan(`Would commit -S -m "release: ${version}" on branch ${branchName}`);
  plan("Would verify the commit (message, single parent, signature, changed files)");
  plan(`Would push ${branchName} to origin`);
  plan("Would verify the remote ref equals the pushed SHA");
  plan("Would create the release PR (base main) with the kit-version skew marker");
  plan("Would return to main");

  if (!execute) {
    return 0;
  }

  // --- Execute (mutations) ---

  /** @type {string[]} */
  const created = [];
  /** @type {string[]} */
  const manual = [];

  try {
    const cut = cutChangelog(changelog, {
      previousVersion: currentVersion,
      version,
      date,
      compareUrl,
    });
    if (!cut.ok) {
      throw new CliError(
        describeFailure({
          checked: "cutting the changelog",
          found: cut.reason ?? "the changelog could not be cut",
          correction: "resolve the changelog state, then rerun",
        }),
      );
    }
    writeFileSync(
      resolve(cwd, "CHANGELOG.md"),
      /** @type {string} */ (cut.content),
      "utf8",
    );

    const nextPkg = { ...pkg, version };
    writeFileSync(
      resolve(cwd, "package.json"),
      JSON.stringify(nextPkg, null, 2) + "\n",
      "utf8",
    );

    const lock = readJson(cwd, "package-lock.json");
    const nextLock = structuredClone(lock);
    nextLock.version = version;
    if (nextLock.packages?.[""]) nextLock.packages[""].version = version;
    writeFileSync(
      resolve(cwd, "package-lock.json"),
      JSON.stringify(nextLock, null, 2) + "\n",
      "utf8",
    );

    // Revalidate the resulting release state before creating anything.
    const writtenChangelog = readFileSync(resolve(cwd, "CHANGELOG.md"), "utf8");
    const changelogCheck = validReleasedChangelog(writtenChangelog, version);
    const writtenLock = readJson(cwd, "package-lock.json");
    const lockMismatch = lockfileVersionMismatch(writtenLock, version);
    const identityMismatch = packageIdentityMismatch(nextPkg, writtenLock);
    if (!changelogCheck.ok || lockMismatch || identityMismatch) {
      throw new CliError(
        describeFailure({
          checked: "the release state after the version bump",
          found:
            [changelogCheck.ok ? null : changelogCheck.reason, lockMismatch, identityMismatch]
              .filter(Boolean)
              .join("; ") || "unknown",
          correction: "fix the control files, then rerun",
        }),
      );
    }

    const checkout = git(["checkout", "-b", branchName], { cwd, env });
    if (checkout.status !== 0) {
      throw mutationError(
        "creating the release branch",
        checkout.stderr.trim() || "git checkout failed",
        "resolve the branch conflict, then rerun",
        created.join(", ") || "nothing",
        "cut control files are modified in the worktree",
      );
    }
    created.push(`branch ${branchName}`);

    git(["add", ...RELEASE_FILES], { cwd, env });
    const commit = git(["commit", "-S", "-m", `release: ${version}`], {
      cwd,
      env,
    });
    if (commit.status !== 0) {
      throw mutationError(
        "creating the signed release commit",
        commit.stderr.trim() || "git commit -S failed",
        "ensure the signing key is available (see the signing preflight), then commit manually",
        created.join(", ") || "nothing",
        `the staged control-file changes on ${branchName} are uncommitted`,
      );
    }
    created.push(`signed commit "release: ${version}"`);

    // Post-commit verification: message, one parent, signature, changed set.
    const message = git(["log", "-1", "--format=%s"], { cwd, env }).stdout.trim();
    if (message !== `release: ${version}`) {
      throw mutationError(
        "the release commit message",
        JSON.stringify(message),
        "amend the commit message to 'release: <version>'",
        created.join(", ") || "nothing",
        "verify and fix the commit manually",
      );
    }
    const parents = git(["log", "-1", "--format=%P"], { cwd, env })
      .stdout.trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parents.length !== 1) {
      throw mutationError(
        "that the release commit has exactly one parent",
        `${parents.length} parent(s) found`,
        "create a single-parent release commit",
        created.join(", ") || "nothing",
        "verify and fix the commit manually",
      );
    }
    const verifyCommit = git(["verify-commit", "HEAD"], { cwd, env });
    if (verifyCommit.status !== 0) {
      throw mutationError(
        "the release commit signature",
        verifyCommit.stderr.trim() || "git verify-commit failed",
        "re-sign the commit with the configured key",
        created.join(", ") || "nothing",
        "verify and fix the commit manually",
      );
    }
    const changedFiles = git(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
      { cwd, env },
    )
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    if (!isReleaseDiff(changedFiles)) {
      throw mutationError(
        "that the release commit changed exactly the three control files",
        changedFiles.length === 0 ? "no files changed" : changedFiles.join(", "),
        `a release commit may only change ${RELEASE_FILES.join(", ")}`,
        created.join(", ") || "nothing",
        "verify and fix the commit manually",
      );
    }

    const pushed = git(["push", "-u", "origin", branchName], { cwd, env });
    if (pushed.status !== 0) {
      throw mutationError(
        `pushing ${branchName} to origin`,
        pushed.stderr.trim() || "git push failed",
        "push the branch manually, then create the PR",
        created.join(", ") || "nothing",
        `push ${branchName} and create the release PR manually`,
      );
    }
    created.push(`remote ref refs/heads/${branchName}`);

    const branchSha = localRefSha(`refs/heads/${branchName}`, { cwd, env });
    const verifiedRemote = remoteRefSha(`refs/heads/${branchName}`, { cwd, env });
    if (branchSha === null || verifiedRemote !== branchSha) {
      throw mutationError(
        "that the remote release branch equals the pushed SHA",
        verifiedRemote === null
          ? "the remote ref is absent"
          : `remote ${String(verifiedRemote).slice(0, 8)} != local ${String(branchSha).slice(0, 8)}`,
        "resolve the remote branch state manually",
        created.join(", ") || "nothing",
        "verify the remote branch and create the PR manually",
      );
    }

    const prBody = `Kit: @vipentti/npm-release-flow@${kitVersion}`;
    let prUrl;
    try {
      const pr = gh(
        [
          "pr",
          "create",
          "--title",
          `release: ${version}`,
          "--head",
          branchName,
          "--base",
          "main",
          "--body",
          prBody,
        ],
        { cwd, env },
      );
      prUrl = pr.stdout.trim();
    } catch (err) {
      const detail = err instanceof CommandError ? err.stderr.trim() : String(err);
      throw mutationError(
        "creating the release PR",
        detail || "gh pr create failed",
        "create the PR manually with gh pr create",
        created.join(", ") || "nothing",
        `create the PR for ${branchName} manually (body must carry "${prBody}")`,
      );
    }
    created.push(`release PR ${prUrl}`);

    const backToMain = git(["checkout", "main"], { cwd, env });
    if (backToMain.status !== 0) {
      throw mutationError(
        "returning to the main branch",
        backToMain.stderr.trim() || "git checkout main failed",
        "check out main manually",
        created.join(", ") || "nothing",
        "nothing; the release is prepared (check out main at your convenience)",
      );
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      describeFailure({
        checked: "the prepare mutation sequence",
        found: err instanceof Error ? err.message : String(err),
        correction: "inspect the repository state, resolve, then rerun from the start",
      }),
    );
  }

  plan(`Created: branch, signed commit, pushed ref, release PR; returned to main`);
  return 0;
}
