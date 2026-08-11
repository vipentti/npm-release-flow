/**
 * Fixture-repo integration harness: a temp consumer-style git repo with a
 * local bare remote, a PATH-shimmed `gh` recording invocations, and (on
 * request) a throwaway GPG home with a real unprotected signing key. Uses
 * real git/gpg; no network.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../src/lib/repo-state.mjs";
import { msysPath, runSync } from "../../src/lib/spawn.mjs";
import { cutChangelog } from "../../src/lib/changelog.mjs";

/**
 * Spawn `git` for fixture setup directly (no cmd.exe round-trip; Windows
 * CreateProcess resolves `git.exe` from PATH). Fixture setup never runs
 * with a git shim on PATH, so this is equivalent to the kit's shell-based
 * `git()` helper, just faster. Falls back to the kit helper when the bare
 * name does not resolve to an executable.
 *
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} ctx
 * @returns {{ status: number, stdout: string, stderr: string, signal: NodeJS.Signals | null }}
 */
function gitDirect(args, ctx) {
  const result = spawnSync("git", args, {
    cwd: ctx.cwd,
    env: ctx.env,
    encoding: "utf8",
  });
  if (result.error) {
    return git(args, ctx);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited with status ${String(result.status)}:\n${result.stderr}`,
    );
  }
  return {
    status: 0,
    stdout: result.stdout,
    stderr: result.stderr,
    signal: null,
  };
}

/**
 * Append `[user] signingkey` straight into the fixture repo's .git/config
 * (one file write instead of a `git config` subprocess spawn).
 *
 * @param {Fixture} fixture
 * @param {string} fingerprint
 */
export function setRepoSigningKey(fixture, fingerprint) {
  appendFileSync(
    join(fixture.consumer, ".git", "config"),
    `\n[user]\n\tsigningkey = ${fingerprint}\n`,
    "utf8",
  );
}

const CHANGELOG = `# Changelog

## [Unreleased]

- Added a fixture feature.

## [1.2.2] - 2026-07-01

- Previous fixture release.

[Unreleased]: https://github.com/example/fixture-consumer/compare/v1.2.2...HEAD
[1.2.2]: https://github.com/example/fixture-consumer/compare/v1.2.1...v1.2.2
`;

function packageJson(version = "1.2.2") {
  return {
    name: "fixture-consumer",
    version,
    description: "Fixture consumer for npm-release-flow tests",
    repository: {
      type: "git",
      url: "git+https://github.com/example/fixture-consumer.git",
    },
    scripts: { "release:verify": "echo verify" },
    bin: { "fixture-tool": "./bin/fixture-tool.mjs" },
  };
}

function packageLock(version = "1.2.2") {
  return {
    name: "fixture-consumer",
    version,
    lockfileVersion: 3,
    packages: { "": { name: "fixture-consumer", version } },
  };
}

const ghFixtureScript = `import { readFileSync, appendFileSync, existsSync } from "node:fs";

const statePath = process.env.GH_FIXTURE_STATE;
const callsPath = process.env.GH_FIXTURE_CALLS;
function log(line) {
  if (callsPath) appendFileSync(callsPath, line + "\\n");
}
const argv = process.argv.slice(2);
log(JSON.stringify(argv));
const state =
  statePath && existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {};
if (argv[0] === "pr" && argv[1] === "list") {
  const branch = argv[argv.indexOf("--head") + 1];
  const prs = state.prs?.[branch] ?? [];
  console.log(JSON.stringify(prs));
  process.exit(0);
}
if (argv[0] === "pr" && argv[1] === "create") {
  console.log(state.prCreateUrl ?? "https://github.com/example/fixture-consumer/pull/1");
  process.exit(0);
}
if (argv[0] === "repo" && argv[1] === "view") {
  const nameWithOwner = state.repo ?? "example/fixture-consumer";
  const jqIndex = argv.indexOf("--jq");
  if (jqIndex !== -1 && argv[jqIndex + 1] === ".nameWithOwner") {
    console.log(nameWithOwner);
  } else {
    console.log(JSON.stringify({ nameWithOwner }));
  }
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  if (state.authOk === false) {
    console.error("gh-fixture: not logged in");
    process.exit(1);
  }
  console.log("Logged in to github.com as fixture");
  process.exit(0);
}
if (argv[0] === "api") {
  const url = argv[1];
  const secretMatch = /^repos\\/[^/]+\\/[^/]+\\/actions\\/secrets\\/([^/]+)$/.exec(url);
  if (secretMatch) {
    const name = secretMatch[1];
    if ((state.secrets ?? []).includes(name)) {
      console.log(JSON.stringify({ name }));
      process.exit(0);
    }
    // Mirror gh api's 404 shape: exit 1 with the HTTP status on stderr.
    console.error("gh-fixture: HTTP 404: Not Found (https://api.github.com/" + url + ")");
    process.exit(1);
  }
  const variableMatch = /^repos\\/[^/]+\\/[^/]+\\/actions\\/variables\\/([^/]+)$/.exec(url);
  if (variableMatch) {
    const name = variableMatch[1];
    if (name === "NPM_RELEASE_FLOW_APP_ID") {
      if (typeof state.appId === "string" && state.appId !== "") {
        const jqIndex = argv.indexOf("--jq");
        if (jqIndex !== -1 && argv[jqIndex + 1] === ".value") {
          console.log(state.appId);
        } else {
          console.log(JSON.stringify({ value: state.appId }));
        }
        process.exit(0);
      }
      console.error("gh-fixture: HTTP 404: Not Found (https://api.github.com/" + url + ")");
      process.exit(1);
    }
    if ((state.variables ?? []).includes(name)) {
      console.log(JSON.stringify({ name }));
      process.exit(0);
    }
    console.error("gh-fixture: HTTP 404: Not Found (https://api.github.com/" + url + ")");
    process.exit(1);
  }
  if (url.endsWith("/environments/release")) {
    if (state.environmentRelease !== undefined && state.environmentRelease !== null) {
      console.log(JSON.stringify(state.environmentRelease));
      process.exit(0);
    }
    console.error("gh-fixture: HTTP 404: Not Found (https://api.github.com/" + url + ")");
    process.exit(1);
  }
  const pullsMatch = /^repos\\/[^/]+\\/[^/]+\\/pulls\\/([0-9]+)$/.exec(url);
  if (pullsMatch) {
    const body = state.prBodies?.[pullsMatch[1]];
    if (typeof body === "string") {
      const jqIndex = argv.indexOf("--jq");
      if (jqIndex !== -1 && argv[jqIndex + 1] === ".body") {
        console.log(body);
        process.exit(0);
      }
      console.log(JSON.stringify({ body }));
      process.exit(0);
    }
    console.error("gh-fixture: pull request not found");
    process.exit(1);
  }
  const commitPullsMatch = /^repos\\/[^/]+\\/[^/]+\\/commits\\/([0-9a-f]{40})\\/pulls$/.exec(url);
  if (commitPullsMatch) {
    const sha = commitPullsMatch[1];
    const pulls = state.commitPulls?.[sha];
    if (pulls === undefined) {
      console.error("gh-fixture: no pull requests recorded for commit " + sha);
      process.exit(1);
    }
    const jqIndex = argv.indexOf("--jq");
    if (jqIndex !== -1) {
      // Mirror detect's --jq projection of the REST response (no state
      // filter: GitHub reports merged PRs with state "closed").
      for (const pr of pulls) {
        console.log(
          JSON.stringify({
            number: pr.number,
            base: pr.base,
            head: pr.head,
            body: pr.body,
          }),
        );
      }
    } else {
      console.log(JSON.stringify(pulls));
    }
    process.exit(0);
  }
  if (/^repos\\/[^/]+\\/[^/]+\\/git\\/tags\\/[0-9a-f]{40}$/.test(url)) {
    const jqIndex = argv.indexOf("--jq");
    if (jqIndex !== -1 && argv[jqIndex + 1] === ".verification.verified") {
      console.log(state.tagVerification ?? "true");
      process.exit(0);
    }
    console.log(JSON.stringify({ verification: { verified: state.tagVerification ?? "true" } }));
    process.exit(0);
  }
  console.error("gh-fixture: unhandled api call: " + url);
  process.exit(1);
}
if (argv[0] === "release" && argv[1] === "view") {
  const tag = argv[2];
  if (state.releases?.[tag]) {
    console.log("present");
    process.exit(0);
  }
  console.error("gh-fixture: release not found");
  process.exit(1);
}
if (argv[0] === "release" && (argv[1] === "create" || argv[1] === "edit")) {
  console.log("https://github.com/example/fixture-consumer/releases/" + argv[2]);
  process.exit(0);
}
console.error("gh-fixture: unhandled invocation: " + argv.join(" "));
process.exit(1);
`;

/**
 * @typedef {object} Fixture
 * @property {string} base Temp base directory.
 * @property {string} consumer Consumer work repo.
 * @property {string} remote Bare remote path.
 * @property {string} shim gh shim directory.
 * @property {string} ghState State file path for the shim.
 * @property {string} callsFile Invocation log path.
 * @property {string} emptyGitConfig Empty config file for GIT_CONFIG_*.
 * @property {() => void} cleanup Remove the fixture.
 */

const gitPushBlockerScript = `import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args[0] === "push") {
  console.error("refused by fixture git shim (push blocked)");
  process.exit(1);
}
// Re-invoke the real git with this shim's directory removed from PATH so the
// resolution cannot loop back to the shim.
const shimDir = dirname(fileURLToPath(import.meta.url));
const pathSep = process.platform === "win32" ? ";" : ":";
const cleanPath = (process.env.PATH ?? "")
  .split(pathSep)
  .filter((p) => p !== shimDir)
  .join(pathSep);
const result = spawnSync("git", args, {
  stdio: "inherit",
  env: { ...process.env, PATH: cleanPath },
});
process.exit(result.status ?? 1);
`;

/**
 * Create a PATH shim for `git` that refuses every `git push` while delegating
 * everything else to the real git (used to exercise partial-failure paths).
 *
 * @param {string} baseDir
 * @returns {string} The shim directory (prepend to PATH).
 */
export function createGitPushBlocker(baseDir) {
  const dir = join(baseDir, "git-shim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "git-fixture.mjs"), gitPushBlockerScript, "utf8");
  if (process.platform === "win32") {
    writeFileSync(
      join(dir, "git.cmd"),
      '@echo off\r\nnode "%~dp0git-fixture.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n',
      "utf8",
    );
  } else {
    const gitShim = join(dir, "git");
    writeFileSync(
      gitShim,
      '#!/bin/sh\nexec node "$(dirname "$0")/git-fixture.mjs" "$@"\n',
      "utf8",
    );
    chmodSync(gitShim, 0o755);
  }
  return dir;
}

/**
 * A bare temp sandbox with a consumer-style directory (package.json only,
 * no git repo, no shims): for tests that only need scratch files and never
 * touch git/npm. Much cheaper than `createFixtureRepo`.
 *
 * @returns {{ base: string, consumer: string, cleanup: () => void }}
 */
export function createTempBase() {
  const base = mkdtempSync(join(tmpdir(), "npmrf-fixture-"));
  const consumer = join(base, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(packageJson(), null, 2) + "\n",
    "utf8",
  );
  return {
    base,
    consumer,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Create a fixture consumer repo (initial commit on main, pushed to a local
 * bare remote) plus the PATH-shimmed `gh`.
 *
 * @param {{ remote?: boolean }} [options] When `remote` is false, the bare
 *   remote and the initial push are skipped (commands that never touch the
 *   remote, e.g. `check`, still get a fully working local repo).
 * @returns {Fixture}
 */
export function createFixtureRepo({ remote = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "npmrf-fixture-"));
  const consumer = join(base, "consumer");
  const remotePath = join(base, "remote.git");
  const shim = join(base, "shim");
  const ghState = join(base, "gh-state.json");
  const callsFile = join(base, "gh-calls.log");
  mkdirSync(consumer, { recursive: true });
  mkdirSync(shim, { recursive: true });

  // Hermetic git config from the FIRST git call on: the fixture must never
  // inherit the host machine's global/system git config. A host
  // `commit.gpgSign = true` would otherwise sign every fixture commit with
  // the host's real key and hang on the passphrase prompt.
  const emptyGitConfig = join(base, "empty-gitconfig");
  writeFileSync(emptyGitConfig, "", "utf8");
  const hermeticEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_SYSTEM: emptyGitConfig,
  };
  const gitCtx = { cwd: consumer, env: hermeticEnv };

  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(packageJson(), null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    join(consumer, "package-lock.json"),
    JSON.stringify(packageLock(), null, 2) + "\n",
    "utf8",
  );
  writeFileSync(join(consumer, "CHANGELOG.md"), CHANGELOG, "utf8");
  writeFileSync(join(consumer, "README.md"), "# Fixture consumer\n", "utf8");
  // A declared bin entry: the verify job checks bin resolution from the pack.
  mkdirSync(join(consumer, "bin"), { recursive: true });
  writeFileSync(
    join(consumer, "bin", "fixture-tool.mjs"),
    '#!/usr/bin/env node\nconsole.log("fixture-tool");\n',
    "utf8",
  );
  // The guarded kit checkout the workflow creates at job time (detect reads
  // its version for the skew-marker comparison).
  mkdirSync(join(consumer, ".npm-release-flow"), { recursive: true });
  writeFileSync(
    join(consumer, ".npm-release-flow", "package.json"),
    JSON.stringify(
      { name: "@vipentti/npm-release-flow", version: "1.0.0" },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  gitDirect(["init", "-b", "main"], gitCtx);
  // The identity, line-ending policy, and origin remote are written straight
  // into .git/config (three fewer subprocess spawns per fixture; the bytes
  // match what `git config`/`git remote add` would write).
  appendFileSync(
    join(consumer, ".git", "config"),
    [
      "",
      "[user]",
      "\tname = Fixture",
      "\temail = fixture@example.com",
      // Deterministic line endings: fixture files are written with LF, so
      // the repo must not apply autocrlf conversions (the host's global git
      // config must not leak into checkout comparisons).
      "[core]",
      "\tautocrlf = false",
      ...(remote
        ? [
            '[remote "origin"]',
            `\turl = ${remotePath.replace(/\\/g, "\\\\")}`,
            "\tfetch = +refs/heads/*:refs/remotes/origin/*",
          ]
        : []),
      "",
    ].join("\n"),
    "utf8",
  );
  gitDirect(["add", "."], gitCtx);
  gitDirect(["commit", "-m", "initial fixture commit"], gitCtx);
  if (remote) {
    gitDirect(["init", "--bare", remotePath], { cwd: base, env: hermeticEnv });
    gitDirect(["push", "-u", "origin", "main"], gitCtx);
  }

  writeFileSync(join(shim, "gh-fixture.mjs"), ghFixtureScript, "utf8");
  if (process.platform === "win32") {
    writeFileSync(
      join(shim, "gh.cmd"),
      '@echo off\r\nnode "%~dp0gh-fixture.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n',
      "utf8",
    );
  } else {
    const ghShim = join(shim, "gh");
    writeFileSync(
      ghShim,
      '#!/bin/sh\nexec node "$(dirname "$0")/gh-fixture.mjs" "$@"\n',
      "utf8",
    );
    chmodSync(ghShim, 0o755);
  }

  writeFileSync(ghState, "{}", "utf8");
  return {
    base,
    consumer,
    remote: remotePath,
    shim,
    ghState,
    callsFile,
    emptyGitConfig,
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Environment with the gh shim first on PATH, the fixture state/calls files
 * wired up, and git's global/system config isolated from the host machine.
 *
 * @param {Fixture} fixture
 * @returns {NodeJS.ProcessEnv}
 */
export function envWithShim(fixture) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: fixture.emptyGitConfig,
    GIT_CONFIG_SYSTEM: fixture.emptyGitConfig,
    GH_FIXTURE_STATE: fixture.ghState,
    GH_FIXTURE_CALLS: fixture.callsFile,
    PATH:
      fixture.shim +
      (process.platform === "win32" ? ";" : ":") +
      process.env.PATH,
  };
}

/**
 * Script the shim's PR list response for a branch.
 *
 * @param {Fixture} fixture
 * @param {string} branch
 * @param {Array<{ number: number, state: string, url: string }>} prs
 */
export function setGhPrs(fixture, branch, prs) {
  const state = JSON.parse(readFileSync(fixture.ghState, "utf8"));
  state.prs = { ...(state.prs ?? {}), [branch]: prs };
  writeFileSync(fixture.ghState, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Script the shim's `pr create` response URL.
 *
 * @param {Fixture} fixture
 * @param {string} url
 */
export function setGhPrCreateUrl(fixture, url) {
  const state = JSON.parse(readFileSync(fixture.ghState, "utf8"));
  state.prCreateUrl = url;
  writeFileSync(fixture.ghState, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Script the shim's repository identity and App-ID variable.
 *
 * @param {Fixture} fixture
 * @param {{ repo?: string, appId?: string, secrets?: string[], variables?: string[], environments?: string[], environmentRelease?: Record<string, any> | null, authOk?: boolean, prBodies?: Record<string, string>, commitPulls?: Record<string, Array<{ number: number, state: string, base: string, head: string, body?: string | null }>>, releases?: Record<string, boolean>, tagVerification?: string }} values
 */
export function setGhRepoState(fixture, values) {
  const state = JSON.parse(readFileSync(fixture.ghState, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) state[key] = value;
  }
  writeFileSync(fixture.ghState, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Recorded gh invocations (JSON-encoded argv arrays, one per line).
 *
 * @param {Fixture} fixture
 * @returns {string[][]}
 */
export function ghCalls(fixture) {
  if (!existsSync(fixture.callsFile)) return [];
  return readFileSync(fixture.callsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Create a prepared release merge on the fixture's main, mirroring what the
 * automated flow produces: a `release/v<version>` branch carrying the
 * post-prepare control files, merged into main with the documented
 * merge-message grammar. Pushes main and cleans up the release branch.
 *
 * @param {Fixture} fixture
 * @param {{ version: string, prNumber: number, owner?: string }} options
 * @param {NodeJS.ProcessEnv} [env] Fixture env for git calls.
 * @returns {string} The merge commit SHA.
 */
export function createReleaseMerge(
  fixture,
  { version, prNumber, owner = "example/fixture-consumer" },
  env,
) {
  const ctx = { cwd: fixture.consumer, env };
  const branch = `release/v${version}`;
  const pkg = JSON.parse(
    readFileSync(join(fixture.consumer, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    readFileSync(join(fixture.consumer, "package-lock.json"), "utf8"),
  );
  const changelog = readFileSync(
    join(fixture.consumer, "CHANGELOG.md"),
    "utf8",
  );
  const compareUrl = "https://github.com/example/fixture-consumer/compare";
  const cut = cutChangelog(changelog, {
    previousVersion: pkg.version,
    version,
    date: "2026-08-01",
    compareUrl,
  });
  if (!cut.ok) throw new Error(`fixture cut failed: ${cut.reason}`);
  pkg.version = version;
  lock.version = version;
  lock.packages[""].version = version;

  gitDirect(["checkout", "-b", branch], ctx);
  writeFileSync(
    join(fixture.consumer, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    join(fixture.consumer, "package-lock.json"),
    JSON.stringify(lock, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    join(fixture.consumer, "CHANGELOG.md"),
    /** @type {string} */ (cut.content),
    "utf8",
  );
  // All three files are tracked and modified, so `commit -a` stages them
  // without a separate `git add` spawn.
  gitDirect(["commit", "-a", "-m", `release: ${version}`], ctx);
  gitDirect(["checkout", "main"], ctx);
  gitDirect(
    [
      "merge",
      "--no-ff",
      "-m",
      `Merge pull request #${prNumber} from ${owner}/release/v${version}`,
      branch,
    ],
    ctx,
  );
  gitDirect(["branch", "-D", branch], ctx);
  gitDirect(["push", "origin", "main"], ctx);
  return gitDirect(["rev-parse", "HEAD"], ctx).stdout.trim();
}

const gitRecorderScript = `import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const logPath = process.env.GIT_FIXTURE_CALLS;
if (logPath) appendFileSync(logPath, JSON.stringify(args) + "\\n");
const shimDir = dirname(fileURLToPath(import.meta.url));
const pathSep = process.platform === "win32" ? ";" : ":";
const cleanPath = (process.env.PATH ?? "")
  .split(pathSep)
  .filter((p) => p !== shimDir)
  .join(pathSep);
const result = spawnSync("git", args, {
  stdio: "inherit",
  env: { ...process.env, PATH: cleanPath },
});
process.exit(result.status ?? 1);
`;

const npmFixtureScript = `import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

const statePath = process.env.NPM_FIXTURE_STATE;
const callsPath = process.env.NPM_FIXTURE_CALLS;
function state() {
  if (statePath && existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}
function save(s) {
  if (statePath) writeFileSync(statePath, JSON.stringify(s, null, 2), "utf8");
}
const argv = process.argv.slice(2);
if (callsPath) appendFileSync(callsPath, JSON.stringify(argv) + "\\n");
if (argv[0] === "view") {
  const s = state();
  if (argv[2] === "versions") {
    console.log(JSON.stringify(s.versions ?? []));
    process.exit(0);
  }
  const key = argv[1]; // name@version
  const manifest = s.views?.[key];
  if (manifest !== undefined) {
    console.log(JSON.stringify(manifest));
    process.exit(0);
  }
  console.error("npm-fixture: E404 for " + key);
  process.exit(1);
}
if (argv[0] === "publish") {
  const s = state();
  const name = s.publishName;
  const version = s.publishVersion;
  if (name && version && s.publishManifest) {
    s.views = { ...(s.views ?? {}), [name + "@" + version]: s.publishManifest };
    save(s);
  }
  process.exit(0);
}
console.error("npm-fixture: unhandled invocation: " + argv.join(" "));
process.exit(1);
`;

/**
 * Create a PATH shim for `npm` that records every invocation (JSON argv per
 * line) and scripts `view`/`publish`/`versions` responses from a state file.
 *
 * @param {string} baseDir
 * @returns {{ dir: string, stateFile: string, callsFile: string }}
 */
export function createNpmShim(baseDir) {
  const dir = join(baseDir, "npm-shim");
  const stateFile = join(baseDir, "npm-state.json");
  const callsFile = join(baseDir, "npm-calls.log");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "npm-fixture.mjs"), npmFixtureScript, "utf8");
  if (process.platform === "win32") {
    writeFileSync(
      join(dir, "npm.cmd"),
      '@echo off\r\nnode "%~dp0npm-fixture.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n',
      "utf8",
    );
  } else {
    const npmShim = join(dir, "npm");
    writeFileSync(
      npmShim,
      '#!/bin/sh\nexec node "$(dirname "$0")/npm-fixture.mjs" "$@"\n',
      "utf8",
    );
    chmodSync(npmShim, 0o755);
  }
  writeFileSync(stateFile, "{}", "utf8");
  return { dir, stateFile, callsFile };
}

/**
 * Read recorded npm invocations from a shim.
 *
 * @param {string} callsFile
 * @returns {string[][]}
 */
export function npmCalls(callsFile) {
  if (!existsSync(callsFile)) return [];
  return readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Extend an env with extra PATH shim dirs (npm/git recorders) in front.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} dirs
 * @returns {NodeJS.ProcessEnv}
 */
export function prependPathDirs(env, dirs) {
  const separator = process.platform === "win32" ? ";" : ":";
  return {
    ...env,
    PATH: dirs.join(separator) + separator + env.PATH,
  };
}

/**
 * Create a PATH shim for `git` that records every invocation (JSON argv per
 * line) and delegates to the real git.
 *
 * @param {string} baseDir
 * @returns {{ dir: string, callsFile: string }}
 */
export function createGitRecorder(baseDir) {
  const dir = join(baseDir, "git-recorder");
  const callsFile = join(baseDir, "git-calls.log");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "git-fixture.mjs"), gitRecorderScript, "utf8");
  if (process.platform === "win32") {
    writeFileSync(
      join(dir, "git.cmd"),
      '@echo off\r\nnode "%~dp0git-fixture.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n',
      "utf8",
    );
  } else {
    const gitShim = join(dir, "git");
    writeFileSync(
      gitShim,
      '#!/bin/sh\nexec node "$(dirname "$0")/git-fixture.mjs" "$@"\n',
      "utf8",
    );
    chmodSync(gitShim, 0o755);
  }
  return { dir, callsFile };
}

/**
 * Read recorded git invocations from a recorder.
 *
 * @param {string} callsFile
 * @returns {string[][]}
 */
export function gitCalls(callsFile) {
  if (!existsSync(callsFile)) return [];
  return readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Create a throwaway GPG home with one unprotected ed25519 signing key.
 *
 * The home is cached module-level: every fixture in the test process shares
 * one identical throwaway keyring (the key is generated once per process in
 * its own temp directory, never inside a fixture base, so a fixture cleanup
 * cannot delete it). Key generation dominates the per-fixture signing cost
 * (~200ms of gpg work per home on Windows), and the keyring is only ever
 * read by the tests, so sharing is safe. The home is removed when the test
 * process exits.
 *
 * @param {string} _baseDir Accepted for call-site compatibility; the shared
 *   home does not live inside it.
 * @returns {{ home: string, fingerprint: string }}
 */
let sharedSigningHome = null;
function createSharedSigningHome() {
  if (sharedSigningHome === null) {
    const home = mkdtempSync(join(tmpdir(), "npmrf-gnupg-"));
    // The home stays native: the tests spread it into child envs exactly as
    // a Windows caller would, and the product boundary (git() and
    // gpgHomeArgs) normalizes it to the MSYS form for the Git-bundled gpg.
    // Only these direct fixture gpg calls convert, because they bypass the
    // kit's subprocess boundary.
    const gpgHome = msysPath(home);
    const params = [
      "%no-protection",
      "Key-Type: eddsa",
      "Key-Curve: ed25519",
      "Key-Usage: sign",
      "Name-Real: Fixture",
      "Name-Email: fixture@example.com",
      "Expire-Date: 0",
      "%commit",
      "",
    ].join("\n");
    runSync("gpg", ["--batch", "--homedir", gpgHome, "--gen-key"], {
      input: params,
    });
    const list = runSync("gpg", [
      "--batch",
      "--homedir",
      gpgHome,
      "--list-secret-keys",
      "--with-colons",
    ]);
    const fpr = list.stdout
      .split("\n")
      .find((line) => line.startsWith("fpr:"))
      ?.split(":")[9];
    if (!fpr)
      throw new Error("could not determine the fixture GPG fingerprint");
    sharedSigningHome = { home, fingerprint: fpr };
    process.on("exit", () => {
      rmSync(home, { recursive: true, force: true });
    });
  }
  return sharedSigningHome;
}

/**
 * @param {string} _baseDir Kept for caller compatibility; the signing home
 *   is shared per process (see `createSharedSigningHome`).
 * @returns {{ home: string, fingerprint: string }}
 */
export function createSigningHome(_baseDir) {
  return createSharedSigningHome();
}

/**
 * Whether a real `gpg` is available and honors the GNUPGHOME environment
 * variable. The execute-with-signing tests need both: git's `commit -S`
 * inherits GNUPGHOME, and some gpg builds (e.g. on Windows) ignore it, in
 * which case a fixture keyring cannot be isolated from the host's. CI runs
 * POSIX, where GNUPGHOME is honored. The result is cached.
 *
 * @returns {boolean}
 */
let gpgFixtureUsableResult = null;
export function gpgFixtureUsable() {
  if (gpgFixtureUsableResult !== null) return gpgFixtureUsableResult;
  try {
    const { home, fingerprint } = createSharedSigningHome();
    // The env-var path is what git commit -S uses; if gpg ignores it, the
    // fixture key is not signable and the execute tests cannot run.
    runSync("gpg", ["--batch", "--list-secret-keys", fingerprint], {
      env: { ...process.env, GNUPGHOME: msysPath(home) },
    });
    gpgFixtureUsableResult = true;
  } catch {
    gpgFixtureUsableResult = false;
  }
  return gpgFixtureUsableResult;
}

/**
 * Read a file from the fixture consumer.
 *
 * @param {Fixture} fixture
 * @param {string} relPath
 * @returns {string}
 */
export function readConsumerFile(fixture, relPath) {
  return readFileSync(join(fixture.consumer, relPath), "utf8");
}

/**
 * Pin the kit as the consumer's devDependency, installing from a local
 * vendor tarball (offline): the installed copy's version then drives the
 * pin-agreement check. The tarball is produced with a real `npm pack`;
 * the lockfile is written directly in npm's own shape instead of running
 * `npm install --package-lock-only` (~0.9s of npm resolution per call).
 *
 * @param {Fixture} fixture
 * @param {{ version: string }} options
 */
export function addKitDevDependency(fixture, { version }) {
  const vendor = join(fixture.base, "vendor");
  const kitDir = join(vendor, `kit-${version}`);
  mkdirSync(kitDir, { recursive: true });
  writeFileSync(
    join(kitDir, "package.json"),
    JSON.stringify({ name: "@vipentti/npm-release-flow", version }, null, 2) +
      "\n",
    "utf8",
  );
  runSync("npm", ["pack", "--pack-destination", vendor], { cwd: kitDir });
  const tgz = `vipentti-npm-release-flow-${version}.tgz`;
  const tgzPath = join(vendor, tgz);
  const pkgPath = join(fixture.consumer, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const fileSpec = `file:${tgzPath}`;
  pkg.devDependencies = {
    ...(pkg.devDependencies ?? {}),
    "@vipentti/npm-release-flow": fileSpec,
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  // Regenerate the lockfile so npm ci resolves the file: dependency offline:
  // mirror npm's exact lockfile shape (root entry carries the same file:
  // spec as package.json; the node_modules entry resolves relative to the
  // consumer with the tarball's integrity hash).
  const lockPath = join(fixture.consumer, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.requires = true;
  lock.packages[""].devDependencies = {
    ...(lock.packages[""].devDependencies ?? {}),
    "@vipentti/npm-release-flow": fileSpec,
  };
  lock.packages["node_modules/@vipentti/npm-release-flow"] = {
    version,
    resolved: `file:../vendor/${tgz}`,
    integrity: `sha512-${createHash("sha512").update(readFileSync(tgzPath)).digest("base64")}`,
    dev: true,
  };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
}
