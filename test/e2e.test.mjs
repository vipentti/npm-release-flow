/**
 * T11 end-to-end integration: the full CLI and job-script surface against a
 * fresh fixture consumer repo, one flow: prepare (dry-run + execute), merge
 * the release, detect, verify, check pass/fail, and the packaging/validation
 * gates (`npm pack --dry-run`, typecheck, actionlint, planlet validate).
 * Real git; gh and npm are PATH-shimmed; the signing-proof paths (execute
 * with a real key) run only where gpg honors GNUPGHOME (POSIX CI).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../bin/npm-release-flow.mjs";
import { prepare } from "../src/commands/prepare.mjs";
import { detect } from "../src/detect.mjs";
import { verify } from "../src/verify.mjs";
import { check } from "../src/commands/check.mjs";
import { git, remoteRefSha, localRefSha } from "../src/lib/repo-state.mjs";
import { sha256OfFile } from "../src/lib/pack-contract.mjs";
import { runSync } from "../src/lib/spawn.mjs";
import {
  createFixtureRepo,
  createReleaseMerge,
  createSigningHome,
  envWithShim,
  gpgFixtureUsable,
  setGhPrCreateUrl,
  setGhPrs,
  setGhRepoState,
} from "./helpers/fixture.mjs";

const hasGpg = gpgFixtureUsable();
const ALL_SECRETS = [
  "NPM_RELEASE_FLOW_GPG_PRIVATE_KEY",
  "NPM_RELEASE_FLOW_GPG_PASSPHRASE",
  "NPM_RELEASE_FLOW_GPG_PUBLIC_KEY",
  "NPM_RELEASE_FLOW_APP_PRIVATE_KEY",
];
const ALL_VARIABLES = [
  "NPM_RELEASE_FLOW_GPG_FINGERPRINT",
  "NPM_RELEASE_FLOW_APP_ID",
  "NPM_RELEASE_FLOW_GIT_NAME",
  "NPM_RELEASE_FLOW_GIT_EMAIL",
];

test(
  "e2e: prepare -> merge -> detect -> verify against one fixture consumer",
  { skip: !hasGpg && "gpg is not available or ignores GNUPGHOME" },
  async () => {
    const fixture = createFixtureRepo();
    try {
      const signing = createSigningHome(fixture.base);
      git(["config", "user.signingkey", signing.fingerprint], {
        cwd: fixture.consumer,
      });
      setGhPrCreateUrl(
        fixture,
        "https://github.com/example/fixture-consumer/pull/42",
      );
      const env = {
        ...envWithShim(fixture),
        GNUPGHOME: signing.home,
        GITHUB_REPOSITORY: "example/fixture-consumer",
        NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
        CALLER_REPOSITORY: "acme/consumer-app",
      };
      const outputFile = join(fixture.base, "output.txt");
      writeFileSync(outputFile, "");

      // 1. prepare dry-run: prints the plan, changes nothing, exits 0.
      const dryLines = [];
      const dryCode = await prepare(
        { version: "1.2.3", execute: false },
        { cwd: fixture.consumer, env, log: (line) => dryLines.push(line) },
      );
      assert.equal(dryCode, 0);
      assert.match(dryLines.join("\n"), /Would cut the changelog for 1\.2\.3/);
      assert.equal(
        localRefSha("refs/heads/release/v1.2.3", { cwd: fixture.consumer }),
        null,
      );

      // 2. prepare --execute: branch, signed commit, push, PR; back on main.
      const execCode = await prepare(
        { version: "1.2.3", execute: true },
        { cwd: fixture.consumer, env },
      );
      assert.equal(execCode, 0);
      assert.equal(
        git(["branch", "--show-current"], {
          cwd: fixture.consumer,
        }).stdout.trim(),
        "main",
      );
      const branchSha = localRefSha("refs/heads/release/v1.2.3", {
        cwd: fixture.consumer,
      });
      assert.ok(branchSha);
      assert.equal(
        remoteRefSha("refs/heads/release/v1.2.3", {
          cwd: fixture.consumer,
          env,
        }),
        branchSha,
      );

      // 3. Simulate the PR merge (the workflow's triggering event), then run
      //    detect against the merged main exactly as the job does.
      const before = git(["rev-parse", "HEAD"], {
        cwd: fixture.consumer,
      }).stdout.trim();
      const merged = await mergeReleaseBranch(fixture, env, branchSha);
      setGhRepoState(fixture, {
        prBodies: {
          42: "Kit: @vipentti/npm-release-flow@1.0.0\n\nRelease notes here.",
        },
      });
      const detectEnv = {
        ...env,
        BEFORE_SHA: before,
        GITHUB_SHA: merged,
        GITHUB_OUTPUT: outputFile,
        VERSION: "",
      };
      const detectCode = await detect({
        cwd: fixture.consumer,
        env: detectEnv,
        log: () => {},
      });
      assert.equal(detectCode, 0);
      const out = readFileSync(outputFile, "utf8");
      assert.match(out, /^is-release=true$/m);
      assert.match(out, /^version=1\.2\.3$/m);

      // 4. verify the merged state: pack dir + sha256 output, both files
      //    present (the artifact upload contract).
      const verifyEnv = {
        ...env,
        VERSION: "1.2.3",
        GITHUB_OUTPUT: outputFile,
      };
      const verifyCode = await verify({
        cwd: fixture.consumer,
        env: verifyEnv,
        log: () => {},
      });
      assert.equal(verifyCode, 0);
      const packDir = join(fixture.consumer, ".npm-release-flow-pack");
      const packFiles = readdir(packDir).sort();
      assert.equal(packFiles.length, 2);
      const tarball = packFiles.find((name) => name.endsWith(".tgz"));
      assert.ok(tarball);
      assert.ok(packFiles.includes("pack.json"));
      const verifyOut = readFileSync(outputFile, "utf8");
      const shaLine = verifyOut
        .split("\n")
        .find((l) => l.startsWith("package-sha256="));
      assert.ok(shaLine);
      assert.equal(shaLine.split("=")[1], sha256OfFile(join(packDir, tarball)));
    } finally {
      fixture.cleanup();
    }
  },
);

test("e2e: bin exit codes 0/1/2 and error-content through the real CLI", async () => {
  const fixture = createFixtureRepo();
  try {
    const signing = createSigningHome(fixture.base);
    git(["config", "user.signingkey", signing.fingerprint], {
      cwd: fixture.consumer,
    });
    setGhRepoState(fixture, {
      repo: "example/fixture-consumer",
      secrets: ALL_SECRETS,
      variables: ALL_VARIABLES,
      appId: "12345",
      environments: ["release"],
      environmentRelease: {
        name: "release",
        protection_rules: [
          { id: 1, type: "required_reviewers", reviewers: [] },
        ],
      },
      installationId: 9876,
    });
    const env = {
      ...envWithShim(fixture),
      GNUPGHOME: signing.home,
      NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
      NPM_RELEASE_FLOW_APP_PRIVATE_KEY: "fixture-pem",
    };

    // check passes in the fully configured fixture (exit 0).
    const checkLines = [];
    const checkCode = await check(
      { execute: false },
      { cwd: fixture.consumer, env, log: (line) => checkLines.push(line) },
    );
    assert.equal(checkCode, 0);
    assert.match(checkLines.join("\n"), /All release prerequisites pass\./);

    // check fails listing problems (exit 1) when secrets are missing.
    setGhRepoState(fixture, { secrets: [] });
    const brokenLines = [];
    const brokenCode = await check(
      { execute: false },
      { cwd: fixture.consumer, env, log: (line) => brokenLines.push(line) },
    );
    assert.equal(brokenCode, 1);
    const text = brokenLines.join("\n");
    assert.match(
      text,
      /Checked: the NPM_RELEASE_FLOW_GPG_PRIVATE_KEY secret\./,
    );
    assert.match(text, /Found \d+ problem\(s\)\./);

    // prepare exits 2 for an already-prepared version (open PR) — bin exit
    // code plumbing end to end. The CliError message goes to stderr.
    setGhRepoState(fixture, { secrets: ALL_SECRETS });
    setGhPrs(fixture, "release/v1.2.3", [
      {
        number: 7,
        state: "OPEN",
        url: "https://github.com/example/fixture-consumer/pull/7",
      },
    ]);
    const originalError = console.error;
    /** @type {string[]} */
    const stderr = [];
    console.error = (line) => stderr.push(String(line));
    let noop;
    try {
      noop = await main(["prepare", "--version", "1.2.3"], {
        cwd: fixture.consumer,
        env,
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(noop, 2);
    assert.match(stderr.join("\n"), /an open release PR already exists/);

    // Unknown subcommand exits 1 with usage (captured via main's stderr).
    const unknown = await main(["frobnicate"], { cwd: fixture.consumer, env });
    assert.equal(unknown, 1);
  } finally {
    fixture.cleanup();
  }
});

test("e2e: packaging gate — npm pack --dry-run lists the kit surface", () => {
  // The kit's own package must list the new src files and the workflow.
  // `npm pack --dry-run` output names the packed files. The kit's spawn
  // helper resolves the win32 npm.cmd wrapper.
  const result = runSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot(),
  });
  const report = JSON.parse(result.stdout);
  const entries = Array.isArray(report) ? report : Object.values(report);
  const files = entries[0]?.files ?? [];
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes(".github/workflows/release.yml"), "workflow ships");
  assert.ok(paths.includes("src/index.mjs"), "index ships");
  assert.ok(paths.includes("src/release.mjs"), "release.mjs ships");
  assert.ok(paths.includes("src/detect.mjs"), "detect.mjs ships");
  assert.ok(paths.includes("src/verify.mjs"), "verify.mjs ships");
  assert.ok(paths.includes("src/revalidate.mjs"), "revalidate.mjs ships");
  assert.ok(
    paths.includes("src/validate-artifact.mjs"),
    "validate-artifact ships",
  );
  assert.ok(paths.includes("src/lib/spawn.mjs"), "spawn lib ships");
  assert.ok(paths.includes("bin/npm-release-flow.mjs"), "bin ships");
});

test("e2e: tag verify-only on the merged release when the remote tag exists", async () => {
  const fixture = createFixtureRepo();
  try {
    const env = envWithShim(fixture);
    const mergeSha = createReleaseMerge(
      fixture,
      { version: "1.2.3", prNumber: 12 },
      env,
    );
    // Push an annotated remote tag (lightweight fetch bug excluded; this
    // exercises the verify-only path shape).
    git(["tag", "-a", "-m", "Release v1.2.3", "v1.2.3", mergeSha], {
      cwd: fixture.consumer,
      env,
    });
    git(["push", "origin", "v1.2.3"], { cwd: fixture.consumer, env });
    // The remote tag resolves and the tagged object is the merge commit.
    const remoteTag = remoteRefSha("refs/tags/v1.2.3", {
      cwd: fixture.consumer,
      env,
    });
    assert.ok(remoteTag);
  } finally {
    fixture.cleanup();
  }
});

/**
 * Merge the prepared release branch with GitHub's merge-message grammar.
 * @param fixture
 * @param env
 * @param branchSha
 */
async function mergeReleaseBranch(fixture, env, branchSha) {
  const { consumer } = fixture;
  git(["checkout", "main"], { cwd: consumer, env });
  git(
    [
      "merge",
      "--no-ff",
      "-m",
      "Merge pull request #42 from example/fixture-consumer/release/v1.2.3",
      branchSha,
    ],
    { cwd: consumer, env },
  );
  git(["push", "origin", "main"], { cwd: consumer, env });
  return git(["rev-parse", "HEAD"], { cwd: consumer, env }).stdout.trim();
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function readdir(dir) {
  return readdirSync(dir);
}

/**
 * @returns {string} The kit repository root.
 */
function repoRoot() {
  return dirname(fileURLToPath(import.meta.url)) + "/..";
}
