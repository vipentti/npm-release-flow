import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detect } from "../src/detect.mjs";
import { git } from "../src/lib/repo-state.mjs";
import { cutChangelog } from "../src/lib/changelog.mjs";
import {
  createFixtureRepo,
  createReleaseMerge,
  envWithShim,
  ghCalls,
  readConsumerFile,
  setGhRepoState,
} from "./helpers/fixture.mjs";

const KIT_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/**
 * Script the gh shim's PR association for a triggering commit (the
 * `commits/{sha}/pulls` read detect performs on the valid-release branch).
 *
 * @param {ReturnType<typeof detectFixture>} ctx
 * @param {string} sha
 * @param {{ version?: string, body?: string, state?: string, number?: number }} [options]
 */
function setCommitPull(
  ctx,
  sha,
  {
    version = "1.2.3",
    body = `Kit: @vipentti/npm-release-flow@${KIT_VERSION}`,
    // REST pull-request state: a merged PR reports "closed".
    state = "closed",
    number = 12,
  } = {},
) {
  setGhRepoState(ctx.fixture, {
    commitPulls: {
      [sha]: [
        { number, state, base: "main", head: `release/v${version}`, body },
      ],
    },
  });
}

/**
 * Fixture wired for detect runs: GITHUB_OUTPUT to a temp file and repository
 * identity set. The kit checkout version is resolved via import.meta.url.
 */
function detectFixture() {
  const fixture = createFixtureRepo();
  const outputFile = join(fixture.base, "output.txt");
  writeFileSync(outputFile, "", "utf8");
  const env = {
    ...envWithShim(fixture),
    GITHUB_REPOSITORY: "example/fixture-consumer",
    GITHUB_OUTPUT: outputFile,
  };
  const output = () => readFileSync(outputFile, "utf8");
  return { fixture, env, output };
}

/**
 * @param {ReturnType<typeof detectFixture>} ctx
 * @param {string} beforeSha
 * @param {string} afterSha
 * @param {NodeJS.ProcessEnv} [envOverrides]
 */
function runDetect(ctx, beforeSha, afterSha, envOverrides = {}) {
  return detect({
    cwd: ctx.fixture.consumer,
    env: {
      ...ctx.env,
      BEFORE_SHA: beforeSha,
      GITHUB_SHA: afterSha,
      ...envOverrides,
    },
    log: () => {},
  });
}

/**
 * Commit a prepared-release state on the current branch (version bump +
 * lockfile + cut changelog), returning the commit SHA.
 *
 * @param {ReturnType<typeof detectFixture>} ctx
 * @param {{ version: string, lock?: boolean, changelog?: "cut" | "broken", extra?: string[] }} options
 */
function releaseCommit(
  ctx,
  { version, lock = true, changelog = "cut", extra = [] },
) {
  const { fixture } = ctx;
  const env = ctx.env;
  const pkg = JSON.parse(readConsumerFile(fixture, "package.json"));
  pkg.version = version;
  writeFileSync(
    join(fixture.consumer, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
  if (lock) {
    const lockData = JSON.parse(readConsumerFile(fixture, "package-lock.json"));
    lockData.version = version;
    lockData.packages[""].version = version;
    writeFileSync(
      join(fixture.consumer, "package-lock.json"),
      JSON.stringify(lockData, null, 2) + "\n",
    );
  }
  const changelogText = readConsumerFile(fixture, "CHANGELOG.md");
  if (changelog === "cut") {
    const cut = cutChangelog(changelogText, {
      previousVersion: "1.2.2",
      version,
      date: "2026-08-01",
      compareUrl: "https://github.com/example/fixture-consumer/compare",
    });
    assert.equal(cut.ok, true, cut.reason);
    writeFileSync(
      join(fixture.consumer, "CHANGELOG.md"),
      /** @type {string} */ (cut.content),
    );
  } else {
    // Broken changelog: notes remain under [Unreleased].
    writeFileSync(
      join(fixture.consumer, "CHANGELOG.md"),
      changelogText.replace(
        "## [Unreleased]\n\n- Added a fixture feature.\n\n## [1.2.2]",
        "## [Unreleased]\n\n- Still unreleased.\n\n## [1.2.2]",
      ),
    );
  }
  for (const name of extra) {
    const content = name === "README.md" ? "# changed too\n" : `# ${name}\n`;
    writeFileSync(join(fixture.consumer, name), content);
  }
  git(["add", "."], { cwd: fixture.consumer, env });
  git(["commit", "-m", `state for ${version}`], { cwd: fixture.consumer, env });
  return git(["rev-parse", "HEAD"], { cwd: fixture.consumer }).stdout.trim();
}

/**
 * Commit a modified control file (used for the mandatory-prerequisite
 * failure cases).
 * @param ctx
 * @param mutate
 */
function commitChange(ctx, mutate) {
  const { fixture } = ctx;
  mutate(fixture);
  git(["add", "."], { cwd: fixture.consumer, env: ctx.env });
  git(["commit", "-m", "state change"], {
    cwd: fixture.consumer,
    env: ctx.env,
  });
  return git(["rev-parse", "HEAD"], { cwd: fixture.consumer }).stdout.trim();
}

test("detect: ordinary push exits 0 with is-release=false and zero PR API calls", async () => {
  const ctx = detectFixture();
  try {
    const before = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = commitChange(ctx, (fixture) => {
      writeFileSync(join(fixture.consumer, "README.md"), "# ordinary change\n");
    });
    const code = await runDetect(ctx, before, after);
    assert.equal(code, 0);
    const out = ctx.output();
    assert.match(out, /^is-release=false$/m);
    assert.match(out, /^version=$/m);
    assert.equal(
      ghCalls(ctx.fixture).length,
      0,
      "ordinary pushes never touch the PR API",
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: valid release with the kit marker exits 0 and writes the version", async () => {
  const ctx = detectFixture();
  try {
    const mergeSha = createReleaseMerge(
      ctx.fixture,
      { version: "1.2.3", prNumber: 12 },
      ctx.env,
    );
    const before = git(["rev-parse", `${mergeSha}^`], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    setCommitPull(ctx, mergeSha, {
      body: `Kit: @vipentti/npm-release-flow@${KIT_VERSION}\n\nRelease notes here.`,
    });
    const code = await runDetect(ctx, before, mergeSha);
    assert.equal(code, 0);
    const out = ctx.output();
    assert.match(out, /^is-release=true$/m);
    assert.match(out, /^version=1\.2\.3$/m);
    const calls = ghCalls(ctx.fixture);
    assert.equal(
      calls.length,
      1,
      "exactly one PR API call on the valid-release branch",
    );
    assert.deepEqual(calls[0].slice(0, 3), [
      "api",
      `repos/example/fixture-consumer/commits/${mergeSha}/pulls`,
      "--paginate",
    ]);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: skew-marker mismatch is a hard fail", async () => {
  const ctx = detectFixture();
  try {
    const mergeSha = createReleaseMerge(
      ctx.fixture,
      { version: "1.2.3", prNumber: 12 },
      ctx.env,
    );
    const before = git(["rev-parse", `${mergeSha}^`], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    setCommitPull(ctx, mergeSha, {
      body: "Kit: @vipentti/npm-release-flow@2.0.0\n",
    });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: mergeSha },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    const text = problems.join("\n");
    assert.match(
      text,
      /Checked: that the kit version that prepared the release equals the kit checkout version\./,
    );
    assert.match(
      text,
      new RegExp(
        `Found: PR body stamps 2\\.0\\.0, but the kit package\\.json is ${KIT_VERSION.replace(/\./g, "\\.")}\\.`,
      ),
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: missing skew marker is a hard fail", async () => {
  const ctx = detectFixture();
  try {
    const mergeSha = createReleaseMerge(
      ctx.fixture,
      { version: "1.2.3", prNumber: 12 },
      ctx.env,
    );
    const before = git(["rev-parse", `${mergeSha}^`], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    setCommitPull(ctx, mergeSha, { body: "Just some notes.\n" });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: mergeSha },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /no 'Kit: @vipentti\/npm-release-flow@<version>' line is present/,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: unreadable PR association is a hard fail", async () => {
  const ctx = detectFixture();
  try {
    const mergeSha = createReleaseMerge(
      ctx.fixture,
      { version: "1.2.3", prNumber: 12 },
      ctx.env,
    );
    const before = git(["rev-parse", `${mergeSha}^`], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    // No commitPulls entry: the shim's gh api call fails.
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: mergeSha },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the pull requests associated with the triggering commit .* via gh api\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: squash-merged release with the kit marker exits 0", async () => {
  const ctx = detectFixture();
  try {
    const { fixture } = ctx;
    // A squash merge writes the release state straight onto main as a single
    // commit; detect must classify it without any merge-message grammar.
    const before = git(["rev-parse", "HEAD"], {
      cwd: fixture.consumer,
    }).stdout.trim();
    const after = releaseCommit(ctx, { version: "1.2.3" });
    git(["push", "origin", "main"], { cwd: fixture.consumer, env: ctx.env });
    setCommitPull(ctx, after, {
      state: "closed",
      body: `Kit: @vipentti/npm-release-flow@${KIT_VERSION}\n\nSquashed release.`,
    });
    const code = await runDetect(ctx, before, after);
    assert.equal(code, 0);
    const out = ctx.output();
    assert.match(out, /^is-release=true$/m);
    assert.match(out, /^version=1\.2\.3$/m);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: valid release with no associated release PR is a hard fail", async () => {
  const ctx = detectFixture();
  try {
    const mergeSha = createReleaseMerge(
      ctx.fixture,
      { version: "1.2.3", prNumber: 12 },
      ctx.env,
    );
    const before = git(["rev-parse", `${mergeSha}^`], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    // Associated PRs exist but none is the expected release/v1.2.3 head.
    setGhRepoState(ctx.fixture, {
      commitPulls: {
        [mergeSha]: [
          {
            number: 99,
            state: "closed",
            base: "main",
            head: "feature/other",
            body: "unrelated",
          },
        ],
      },
    });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: mergeSha },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    const text = problems.join("\n");
    assert.match(
      text,
      /Checked: the pull request for release\/v1\.2\.3 among the commits associated with/,
    );
    assert.match(
      text,
      /Found: no associated pull request has head release\/v1\.2\.3 on base main\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: missing or all-zero before SHA is a hard fail", async () => {
  const ctx = detectFixture();
  try {
    const head = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const zero = "0000000000000000000000000000000000000000";
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: zero, GITHUB_SHA: head },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the previous push SHA \(github\.event\.before\)\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: new version not stable is a hard fail", async () => {
  const ctx = detectFixture();
  try {
    const before = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = releaseCommit(ctx, { version: "1.2.3-beta" });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: after },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the new package\.json\.version\./,
    );
    assert.equal(ghCalls(ctx.fixture).length, 0);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: version decrease is ordinary with is-release=false and zero PR calls (revert regression 0.1.0 -> 0.0.0)", async () => {
  const ctx = detectFixture();
  try {
    const before = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = releaseCommit(ctx, { version: "1.2.1" });
    const code = await runDetect(ctx, before, after);
    assert.equal(code, 0);
    const out = ctx.output();
    assert.match(out, /^is-release=false$/m);
    assert.match(out, /^version=$/m);
    assert.equal(ghCalls(ctx.fixture).length, 0);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: lockfile mismatch vs version is a hard fail", async () => {
  const ctx = detectFixture();
  try {
    const before = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = releaseCommit(ctx, { version: "1.2.3", lock: false });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: after },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: package-lock\.json version fields against the release version\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: diff with extra files is a hard fail", async () => {
  const ctx = detectFixture();
  try {
    const before = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = releaseCommit(ctx, {
      version: "1.2.3",
      extra: ["README.md"],
    });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: after },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the changed-file set against the release-diff allowlist\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: changelog not a valid released version is a hard fail", async () => {
  const ctx = detectFixture();
  try {
    const before = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = releaseCommit(ctx, { version: "1.2.3", changelog: "broken" });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: after },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the changelog as a valid released version\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: tag at a commit other than the release commit is a hard fail", async () => {
  const ctx = detectFixture();
  try {
    const before = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = releaseCommit(ctx, { version: "1.2.3" });
    git(["tag", "v1.2.3", before], { cwd: ctx.fixture.consumer, env: ctx.env });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: after },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: refs\/tags\/v1\.2\.3 target against the release commit\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: missing CHANGELOG.md is a hard fail before any verdict, with zero PR calls", async () => {
  const ctx = detectFixture();
  try {
    const before = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = commitChange(ctx, (fixture) => {
      rmSync(join(fixture.consumer, "CHANGELOG.md"));
    });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: after },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the CHANGELOG\.md control file\./,
    );
    assert.equal(ghCalls(ctx.fixture).length, 0);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: malformed [Unreleased] heading is a hard fail with zero PR calls", async () => {
  const ctx = detectFixture();
  try {
    const before = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = commitChange(ctx, (fixture) => {
      const changelog = readConsumerFile(fixture, "CHANGELOG.md");
      writeFileSync(
        join(fixture.consumer, "CHANGELOG.md"),
        changelog.replace("## [Unreleased]", "## [Unreleased] - 2026-08-01"),
      );
    });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: after },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the ## \[Unreleased\] section in CHANGELOG\.md\./,
    );
    assert.equal(ghCalls(ctx.fixture).length, 0);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: missing release:verify script is a hard fail with zero PR calls", async () => {
  const ctx = detectFixture();
  try {
    const before = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = commitChange(ctx, (fixture) => {
      const pkg = JSON.parse(readConsumerFile(fixture, "package.json"));
      delete pkg.scripts;
      writeFileSync(
        join(fixture.consumer, "package.json"),
        JSON.stringify(pkg, null, 2) + "\n",
      );
    });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: after },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the release:verify script in package\.json\./,
    );
    assert.equal(ghCalls(ctx.fixture).length, 0);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: missing lockfile is a hard fail with zero PR calls", async () => {
  const ctx = detectFixture();
  try {
    const before = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = commitChange(ctx, (fixture) => {
      rmSync(join(fixture.consumer, "package-lock.json"));
    });
    const problems = [];
    const code = await detect({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, BEFORE_SHA: before, GITHUB_SHA: after },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the package-lock\.json lockfile\./,
    );
    assert.equal(ghCalls(ctx.fixture).length, 0);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("detect: binds HEAD to the triggering SHA", async () => {
  const ctx = detectFixture();
  try {
    const initial = git(["rev-parse", "HEAD"], {
      cwd: ctx.fixture.consumer,
    }).stdout.trim();
    const after = commitChange(ctx, (fixture) => {
      writeFileSync(
        join(fixture.consumer, "README.md"),
        "# change for binding\n",
      );
    });
    // Detach HEAD to the initial commit: the script must bind to GITHUB_SHA.
    git(["checkout", "--detach", initial], { cwd: ctx.fixture.consumer });
    const code = await runDetect(ctx, initial, after);
    assert.equal(code, 0);
    assert.equal(
      git(["rev-parse", "HEAD"], { cwd: ctx.fixture.consumer }).stdout.trim(),
      after,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});
