/**
 * Fixture-repo integration harness: a temp consumer-style git repo with a
 * local bare remote, a PATH-shimmed `gh` recording invocations, and (on
 * request) a throwaway GPG home with a real unprotected signing key. Uses
 * real git/gpg; no network.
 */

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
import { runSync } from "../../src/lib/spawn.mjs";

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
console.error("gh-fixture: unhandled invocation: " + argv.join(" "));
process.exit(1);
`;

/**
 * @typedef {Object} Fixture
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
 * Create a fixture consumer repo (initial commit on main, pushed to a local
 * bare remote) plus the PATH-shimmed `gh`.
 *
 * @returns {Fixture}
 */
export function createFixtureRepo() {
  const base = mkdtempSync(join(tmpdir(), "npmrf-fixture-"));
  const consumer = join(base, "consumer");
  const remote = join(base, "remote.git");
  const shim = join(base, "shim");
  const ghState = join(base, "gh-state.json");
  const callsFile = join(base, "gh-calls.log");
  mkdirSync(consumer, { recursive: true });
  mkdirSync(shim, { recursive: true });

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

  git(["init", "-b", "main"], { cwd: consumer });
  git(["config", "user.name", "Fixture"], { cwd: consumer });
  git(["config", "user.email", "fixture@example.com"], { cwd: consumer });
  git(["add", "."], { cwd: consumer });
  git(["commit", "-m", "initial fixture commit"], { cwd: consumer });
  git(["init", "--bare", remote], { cwd: base });
  git(["remote", "add", "origin", remote], { cwd: consumer });
  git(["push", "-u", "origin", "main"], { cwd: consumer });

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
  // Hermetic git config: the fixture must never inherit the host machine's
  // global/system git config (e.g. a real user.signingkey).
  const emptyGitConfig = join(base, "empty-gitconfig");
  writeFileSync(emptyGitConfig, "", "utf8");
  return {
    base,
    consumer,
    remote,
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
      fixture.shim + (process.platform === "win32" ? ";" : ":") + process.env.PATH,
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
 * Create a throwaway GPG home with one unprotected ed25519 signing key.
 *
 * @param {string} baseDir
 * @returns {{ home: string, fingerprint: string }}
 */
export function createSigningHome(baseDir) {
  const home = join(baseDir, "gnupghome");
  mkdirSync(home, { recursive: true });
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
  runSync("gpg", ["--batch", "--homedir", home, "--gen-key"], {
    input: params,
  });
  const list = runSync("gpg", [
    "--batch",
    "--homedir",
    home,
    "--list-secret-keys",
    "--with-colons",
  ]);
  const fpr = list.stdout
    .split("\n")
    .find((line) => line.startsWith("fpr:"))
    ?.split(":")[9];
  if (!fpr) throw new Error("could not determine the fixture GPG fingerprint");
  return { home, fingerprint: fpr };
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
    const base = mkdtempSync(join(tmpdir(), "npmrf-gpgcheck-"));
    try {
      const { home, fingerprint } = createSigningHome(base);
      // The env-var path is what git commit -S uses; if gpg ignores it, the
      // fixture key is not signable and the execute tests cannot run.
      runSync("gpg", ["--batch", "--list-secret-keys", fingerprint], {
        env: { ...process.env, GNUPGHOME: home },
      });
      gpgFixtureUsableResult = true;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
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
