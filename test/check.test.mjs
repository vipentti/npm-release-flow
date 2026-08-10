import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { check } from "../src/commands/check.mjs";
import { git } from "../src/lib/repo-state.mjs";
import {
  createFixtureRepo,
  createSigningHome,
  envWithShim,
  setGhRepoState,
  setRepoSigningKey,
} from "./helpers/fixture.mjs";

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

/**
 * A fixture configured so every check passes.
 */
function goodCheckFixture() {
  // `check` never touches the git remote, so skip the bare remote + push.
  const fixture = createFixtureRepo({ remote: false });
  const signing = createSigningHome(fixture.base);
  setRepoSigningKey(fixture, signing.fingerprint);
  setGhRepoState(fixture, {
    repo: "example/fixture-consumer",
    secrets: ALL_SECRETS,
    variables: ALL_VARIABLES,
    appId: "12345",
    environments: ["release"],
    environmentRelease: {
      name: "release",
      protection_rules: [{ id: 1, type: "required_reviewers", reviewers: [] }],
    },
    installationId: 9876,
  });
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
    NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
    NPM_RELEASE_FLOW_APP_PRIVATE_KEY: "fixture-pem",
  };
  return { fixture, env, signing };
}

/**
 * @param {ReturnType<typeof goodCheckFixture>} ctx
 */
function run(ctx, execute = false) {
  return check(
    { execute },
    { cwd: ctx.fixture.consumer, env: ctx.env, log: () => {} },
  );
}

test("check passes when every prerequisite is in place", async () => {
  const ctx = goodCheckFixture();
  try {
    assert.equal(await run(ctx), 0);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check accepts --execute as a no-op", async () => {
  const ctx = goodCheckFixture();
  try {
    assert.equal(await run(ctx, true), 0);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags a missing CHANGELOG.md", async () => {
  const ctx = goodCheckFixture();
  try {
    rmSync(join(ctx.fixture.consumer, "CHANGELOG.md"));
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env: ctx.env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /Checked: the CHANGELOG\.md control file\./.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags a changelog without an [Unreleased] section", async () => {
  const ctx = goodCheckFixture();
  try {
    const changelog = readFileSync(join(ctx.fixture.consumer, "CHANGELOG.md"), "utf8");
    writeFileSync(
      join(ctx.fixture.consumer, "CHANGELOG.md"),
      changelog.replace("## [Unreleased]\n\n- Added a fixture feature.\n\n", ""),
    );
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env: ctx.env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /Checked: the ## \[Unreleased\] section in CHANGELOG\.md\./.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags a missing release:verify script", async () => {
  const ctx = goodCheckFixture();
  try {
    const pkg = JSON.parse(readFileSync(join(ctx.fixture.consumer, "package.json"), "utf8"));
    delete pkg.scripts;
    writeFileSync(
      join(ctx.fixture.consumer, "package.json"),
      JSON.stringify(pkg, null, 2) + "\n",
    );
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env: ctx.env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /Checked: the release:verify script in package\.json\./.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags an uncommitted lockfile", async () => {
  const ctx = goodCheckFixture();
  try {
    git(["rm", "--cached", "package-lock.json"], { cwd: ctx.fixture.consumer });
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env: ctx.env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /exists but is not tracked by git/.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags missing secrets by name", async () => {
  const ctx = goodCheckFixture();
  try {
    setGhRepoState(ctx.fixture, {
      secrets: ALL_SECRETS.filter((name) => name !== "NPM_RELEASE_FLOW_GPG_PASSPHRASE"),
    });
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env: ctx.env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /Checked: the NPM_RELEASE_FLOW_GPG_PASSPHRASE secret\./.test(p)));
    assert.ok(problems.some((p) => /Found: it is not set on the repository\./.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags missing variables by name", async () => {
  const ctx = goodCheckFixture();
  try {
    setGhRepoState(ctx.fixture, {
      variables: ALL_VARIABLES.filter((name) => name !== "NPM_RELEASE_FLOW_GIT_EMAIL"),
    });
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env: ctx.env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /Checked: the NPM_RELEASE_FLOW_GIT_EMAIL variable\./.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags a missing release Environment", async () => {
  const ctx = goodCheckFixture();
  try {
    setGhRepoState(ctx.fixture, { environments: [] });
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env: ctx.env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /Checked: the release Environment\./.test(p)));
    assert.ok(problems.some((p) => /no Environment named release exists/.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags a release Environment without required-reviewer protection", async () => {
  const ctx = goodCheckFixture();
  try {
    setGhRepoState(ctx.fixture, {
      environmentRelease: { name: "release", protection_rules: [] },
    });
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env: ctx.env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /has no required-reviewer protection/.test(p)));
    assert.ok(problems.some((p) => /no approval gate otherwise/.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags a missing App installation", async () => {
  const ctx = goodCheckFixture();
  try {
    setGhRepoState(ctx.fixture, { installationId: null });
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env: ctx.env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /the release GitHub App is installed/.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags a missing NPM_RELEASE_FLOW_APP_PRIVATE_KEY env value", async () => {
  const ctx = goodCheckFixture();
  try {
    const env = { ...ctx.env };
    delete env.NPM_RELEASE_FLOW_APP_PRIVATE_KEY;
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /Checked: NPM_RELEASE_FLOW_APP_PRIVATE_KEY in the local environment\./.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags failing gh authentication", async () => {
  const ctx = goodCheckFixture();
  try {
    setGhRepoState(ctx.fixture, { authOk: false });
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env: ctx.env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /Checked: gh authentication\./.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags a missing git identity", async () => {
  const ctx = goodCheckFixture();
  try {
    git(["config", "--unset-all", "user.name"], { cwd: ctx.fixture.consumer });
    git(["config", "--unset-all", "user.email"], { cwd: ctx.fixture.consumer });
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: ctx.fixture.consumer, env: ctx.env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /Checked: the git identity\./.test(p)));
  } finally {
    ctx.fixture.cleanup();
  }
});

test("check flags a missing commit-signing key", async () => {
  const fixture = createFixtureRepo({ remote: false });
  const signing = createSigningHome(fixture.base);
  setGhRepoState(fixture, {
    repo: "example/fixture-consumer",
    secrets: ALL_SECRETS,
    variables: ALL_VARIABLES,
    appId: "12345",
    environments: ["release"],
    environmentRelease: {
      name: "release",
      protection_rules: [{ id: 1, type: "required_reviewers", reviewers: [] }],
    },
    installationId: 9876,
  });
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
    NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
    NPM_RELEASE_FLOW_APP_PRIVATE_KEY: "fixture-pem",
  };
  try {
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: fixture.consumer, env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /Checked: git's configured commit-signing key \(user\.signingkey\)\./.test(p)));
  } finally {
    fixture.cleanup();
  }
});

test("check flags a missing NPM_RELEASE_FLOW_GPG_FINGERPRINT and its key", async () => {
  const fixture = createFixtureRepo({ remote: false });
  const signing = createSigningHome(fixture.base);
  setRepoSigningKey(fixture, signing.fingerprint);
  setGhRepoState(fixture, {
    repo: "example/fixture-consumer",
    secrets: ALL_SECRETS,
    variables: ALL_VARIABLES,
    appId: "12345",
    environments: ["release"],
    environmentRelease: {
      name: "release",
      protection_rules: [{ id: 1, type: "required_reviewers", reviewers: [] }],
    },
    installationId: 9876,
  });
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
    NPM_RELEASE_FLOW_APP_PRIVATE_KEY: "fixture-pem",
  };
  try {
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: fixture.consumer, env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.some((p) => /Checked: NPM_RELEASE_FLOW_GPG_FINGERPRINT\./.test(p)));
  } finally {
    fixture.cleanup();
  }
});

test("check lists every problem, not just the first", async () => {
  const fixture = createFixtureRepo({ remote: false });
  const signing = createSigningHome(fixture.base);
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
    NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
  };
  try {
    // Nothing configured: identity, secrets, variables, environment,
    // installation, App key, and signing key are all missing.
    const problems = [];
    const code = await check(
      { execute: false },
      { cwd: fixture.consumer, env, log: (line) => problems.push(line) },
    );
    assert.equal(code, 1);
    assert.ok(problems.length >= 6, `expected multiple problems, got ${problems.length}`);
    assert.match(problems.join("\n"), /Found \d+ problem\(s\)\./);
  } finally {
    fixture.cleanup();
  }
});
