import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  release,
  verifyOnlyTag,
  viewPublishedVersion,
  newerStableExists,
  publishedIdentityProblems,
  publishRelease,
  ensureGithubRelease,
  pollGithubSignatureVerification,
} from "../src/release.mjs";
import { CliError } from "../src/lib/errors.mjs";
import { git, remoteRefSha } from "../src/lib/repo-state.mjs";
import { integrityOfFile } from "../src/lib/pack-contract.mjs";
import {
  createFixtureRepo,
  createGitRecorder,
  createNpmShim,
  createSigningHome,
  envWithShim,
  gitCalls,
  gpgFixtureUsable,
  npmCalls,
  prependPathDirs,
  readConsumerFile,
  setGhRepoState,
} from "./helpers/fixture.mjs";

const hasGpg = gpgFixtureUsable();

/**
 * Fixture for the mutation-helper tests: consumer repo plus npm and gh
 * shims, wired env. The workspace manifest version is 1.2.2 (the fixture's
 * current version), so VERSION must be "1.2.2".
 */
function releaseFixture() {
  const fixture = createFixtureRepo();
  const npmShim = createNpmShim(fixture.base);
  setGhRepoState(fixture, {
    repo: "example/fixture-consumer",
    tagVerification: "true",
  });
  const env = prependPathDirs(envWithShim(fixture), [npmShim.dir]);
  const head = git(["rev-parse", "HEAD"], {
    cwd: fixture.consumer,
  }).stdout.trim();
  return {
    fixture,
    npmShim,
    env: {
      ...env,
      GH_TOKEN: "fixture-token",
      GITHUB_REPOSITORY: "example/fixture-consumer",
      GITHUB_SHA: head,
      VERSION: "1.2.2",
      TAG_EXISTS: "false",
      NPM_RELEASE_FLOW_APP_TOKEN: "fixture-app-token",
      NPM_RELEASE_FLOW_GPG_FINGERPRINT: "a".repeat(40),
      PACKAGE_TARBALL: join(fixture.base, "package.tgz"),
      NPM_FIXTURE_STATE: npmShim.stateFile,
      NPM_FIXTURE_CALLS: npmShim.callsFile,
    },
    head,
  };
}

/**
 * A dummy tarball file plus the npm state for a successful publish-then-
 * verify flow.
 * @param ctx
 * @param version
 */
function seedPublishState(ctx, version = "1.2.2") {
  const tarballPath = ctx.env.PACKAGE_TARBALL;
  writeFileSync(tarballPath, "dummy tarball bytes");
  const integrity = integrityOfFile(tarballPath);
  const manifest = {
    name: "fixture-consumer",
    version,
    repository: {
      type: "git",
      url: "git+https://github.com/example/fixture-consumer.git",
    },
    dist: { integrity },
    gitHead: ctx.head,
  };
  const state = {
    publishName: "fixture-consumer",
    publishVersion: version,
    publishManifest: manifest,
    views: {},
    versions: [],
  };
  writeFileSync(ctx.npmShim.stateFile, JSON.stringify(state, null, 2), "utf8");
  return manifest;
}

/**
 * @param {() => Promise<unknown> | unknown} fn
 * @returns {Promise<CliError>}
 */
async function expectCliError(fn) {
  try {
    await fn();
  } catch (err) {
    assert.ok(
      err instanceof CliError,
      `expected CliError, got ${err?.constructor?.name ?? err}`,
    );
    return err;
  }
  assert.fail("expected the command to throw CliError");
}

test("publishedIdentityProblems: name, version, repository, integrity, gitHead", () => {
  const tarballPath = join(tmpdir(), "npmrf-pid-probe.tgz");
  writeFileSync(tarballPath, "probe bytes");
  const integrity = integrityOfFile(tarballPath);
  const good = {
    published: {
      name: "fixture-consumer",
      version: "1.2.2",
      repository: {
        url: "git+https://github.com/example/fixture-consumer.git",
      },
      dist: { integrity },
      gitHead: "a".repeat(40),
    },
    name: "fixture-consumer",
    version: "1.2.2",
    repositoryUrl: "git+https://github.com/example/fixture-consumer.git",
    gitHead: "a".repeat(40),
    tarballPath,
  };
  assert.deepEqual(publishedIdentityProblems(good), []);

  const badName = publishedIdentityProblems({
    ...good,
    published: { ...good.published, name: "other" },
  });
  assert.ok(
    badName.some((p) =>
      /published name "other" does not match "fixture-consumer"/.test(p),
    ),
  );

  const badVersion = publishedIdentityProblems({
    ...good,
    published: { ...good.published, version: "9.9.9" },
  });
  assert.ok(
    badVersion.some((p) =>
      /published version "9\.9\.9" does not match "1\.2\.2"/.test(p),
    ),
  );

  const badRepo = publishedIdentityProblems({
    ...good,
    published: {
      ...good.published,
      repository: { url: "https://github.com/evil/repo.git" },
    },
  });
  assert.ok(badRepo.some((p) => /does not match the source/.test(p)));

  const badIntegrity = publishedIdentityProblems({
    ...good,
    published: { ...good.published, dist: { integrity: "sha512-AAAA" } },
  });
  assert.ok(
    badIntegrity.some((p) =>
      /dist\.integrity does not equal the packed integrity/.test(p),
    ),
  );

  // gitHead is checked only when present in the published manifest.
  const missingGitHead = publishedIdentityProblems({
    ...good,
    published: { ...good.published, gitHead: undefined },
  });
  assert.deepEqual(missingGitHead, []);

  const badGitHead = publishedIdentityProblems({
    ...good,
    published: { ...good.published, gitHead: "b".repeat(40) },
  });
  assert.ok(badGitHead.some((p) => /gitHead/.test(p)));
});

test("viewPublishedVersion: E404 is null, present returns the manifest", async () => {
  const ctx = releaseFixture();
  try {
    assert.equal(
      viewPublishedVersion({
        name: "fixture-consumer",
        version: "1.2.2",
        cwd: ctx.fixture.consumer,
        env: ctx.env,
      }),
      null,
      "unseeded view is E404",
    );
    const manifest = seedPublishState(ctx);
    // Seed the view directly (the shim's publish handler populates views;
    // this test exercises the read side only).
    const state = JSON.parse(readFileSync(ctx.npmShim.stateFile, "utf8"));
    state.views = { "fixture-consumer@1.2.2": manifest };
    writeFileSync(
      ctx.npmShim.stateFile,
      JSON.stringify(state, null, 2),
      "utf8",
    );
    const viewed = viewPublishedVersion({
      name: "fixture-consumer",
      version: "1.2.2",
      cwd: ctx.fixture.consumer,
      env: ctx.env,
    });
    assert.equal(viewed.name, manifest.name);
    assert.equal(viewed.version, "1.2.2");
    const calls = npmCalls(ctx.npmShim.callsFile);
    assert.ok(
      calls.every(
        (call) =>
          call.includes("--registry") &&
          call.includes("https://registry.npmjs.org"),
      ),
      "every npm view carries the pinned registry",
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("newerStableExists: true when a newer stable version exists, false otherwise", async () => {
  const ctx = releaseFixture();
  try {
    // A stable 1.2.4 exists; 1.2.5-beta is a prerelease and must not count.
    const state = { versions: ["1.2.0", "1.2.3", "1.2.4", "1.2.5-beta"] };
    writeFileSync(ctx.npmShim.stateFile, JSON.stringify(state), "utf8");
    assert.equal(
      newerStableExists({
        name: "fixture-consumer",
        current: "1.2.3",
        cwd: ctx.fixture.consumer,
        env: ctx.env,
      }),
      true,
    );
    assert.equal(
      newerStableExists({
        name: "fixture-consumer",
        current: "1.2.4",
        cwd: ctx.fixture.consumer,
        env: ctx.env,
      }),
      false,
      "prereleases do not count",
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("publishRelease: publish-then-verify when absent", async () => {
  const ctx = releaseFixture();
  try {
    seedPublishState(ctx);
    await publishRelease({
      version: "1.2.2",
      name: "fixture-consumer",
      repositoryUrl: "git+https://github.com/example/fixture-consumer.git",
      gitHead: ctx.head,
      tarballPath: ctx.env.PACKAGE_TARBALL,
      cwd: ctx.fixture.consumer,
      env: ctx.env,
    });
    const calls = npmCalls(ctx.npmShim.callsFile);
    const publish = calls.find((call) => call[0] === "publish");
    assert.ok(publish, "npm publish was invoked");
    assert.ok(
      publish.includes("--registry") &&
        publish.includes("https://registry.npmjs.org"),
      "the publish carries the pinned registry",
    );
    assert.ok(publish.includes("--provenance"));
    assert.ok(publish.includes("--ignore-scripts"));
    assert.ok(publish.includes("--access") && publish.includes("public"));
    // The visibility wait then verified the published manifest.
    const views = npmCalls(ctx.npmShim.callsFile).filter(
      (c) => c[0] === "view",
    );
    assert.ok(views.length >= 2, "view was called for E404 and visibility");
  } finally {
    ctx.fixture.cleanup();
  }
});

test("publishRelease: verify-or-idempotent when present (no publish)", async () => {
  const ctx = releaseFixture();
  try {
    seedPublishState(ctx);
    // Pre-seed the view: the version is already published and matches.
    const state = JSON.parse(readConsumerFile(ctx.fixture, "package.json"));
    writeFileSync(
      ctx.npmShim.stateFile,
      JSON.stringify({
        views: {
          "fixture-consumer@1.2.2": {
            ...state,
            dist: { integrity: integrityOfFile(ctx.env.PACKAGE_TARBALL) },
            gitHead: ctx.head,
          },
        },
        versions: [],
      }),
      "utf8",
    );
    await publishRelease({
      version: "1.2.2",
      name: "fixture-consumer",
      repositoryUrl: "git+https://github.com/example/fixture-consumer.git",
      gitHead: ctx.head,
      tarballPath: ctx.env.PACKAGE_TARBALL,
      cwd: ctx.fixture.consumer,
      env: ctx.env,
    });
    const calls = npmCalls(ctx.npmShim.callsFile);
    assert.equal(
      calls.some((call) => call[0] === "publish"),
      false,
      "no publish on the idempotent path",
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("publishRelease: refuses when a newer stable version exists", async () => {
  const ctx = releaseFixture();
  try {
    seedPublishState(ctx);
    const state = JSON.parse(readFileSync(ctx.npmShim.stateFile, "utf8"));
    state.versions = ["1.2.2", "1.2.3"];
    writeFileSync(ctx.npmShim.stateFile, JSON.stringify(state), "utf8");
    const err = await expectCliError(() =>
      publishRelease({
        version: "1.2.2",
        name: "fixture-consumer",
        repositoryUrl: "git+https://github.com/example/fixture-consumer.git",
        gitHead: ctx.head,
        tarballPath: ctx.env.PACKAGE_TARBALL,
        cwd: ctx.fixture.consumer,
        env: ctx.env,
      }),
    );
    assert.match(
      err.message,
      /Checked: whether a newer stable version of fixture-consumer exists on the registry\./,
    );
    assert.match(
      err.message,
      /Found: a newer stable version is already published\./,
    );
    assert.equal(
      npmCalls(ctx.npmShim.callsFile).some((call) => call[0] === "publish"),
      false,
      "no publish when a newer stable version exists",
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("publishRelease: a consumer .npmrc pointing elsewhere cannot redirect the registry", async () => {
  const ctx = releaseFixture();
  try {
    seedPublishState(ctx);
    writeFileSync(
      join(ctx.fixture.consumer, ".npmrc"),
      "registry=https://evil.example.com/registry/\n",
      "utf8",
    );
    await publishRelease({
      version: "1.2.2",
      name: "fixture-consumer",
      repositoryUrl: "git+https://github.com/example/fixture-consumer.git",
      gitHead: ctx.head,
      tarballPath: ctx.env.PACKAGE_TARBALL,
      cwd: ctx.fixture.consumer,
      env: ctx.env,
    });
    const calls = npmCalls(ctx.npmShim.callsFile);
    assert.ok(calls.length > 0, "npm was invoked");
    for (const call of calls) {
      assert.ok(
        call.includes("https://registry.npmjs.org"),
        `every protected npm call pins the registry (got ${JSON.stringify(call)})`,
      );
    }
    assert.equal(
      calls.some((call) => call.includes("evil.example.com")),
      false,
      "no call reaches the consumer-configured registry",
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("ensureGithubRelease: creates with --verify-tag when absent, edits when present", async () => {
  const ctx = releaseFixture();
  try {
    setGhRepoState(ctx.fixture, { releases: {} });
    await ensureGithubRelease({
      version: "1.2.2",
      notes: "- Released 1.2.2.",
      cwd: ctx.fixture.consumer,
      env: ctx.env,
    });
    let calls = [];
    // gh calls go through the shim's own calls file (GH_FIXTURE_CALLS).
    calls = readGhCalls(ctx.fixture);
    const create = calls.find((call) => call[1] === "create");
    assert.ok(create, "gh release create was invoked");
    assert.ok(create.includes("--verify-tag"));
    assert.ok(create.includes("--title") && create.includes("Release v1.2.2"));
    assert.ok(create.includes("--notes"));

    // Second run: the release now exists -> edit, idempotent.
    setGhRepoState(ctx.fixture, { releases: { "v1.2.2": true } });
    await ensureGithubRelease({
      version: "1.2.2",
      notes: "- Released 1.2.2.",
      cwd: ctx.fixture.consumer,
      env: ctx.env,
    });
    calls = readGhCalls(ctx.fixture);
    const edit = calls.filter((call) => call[1] === "edit");
    assert.equal(edit.length, 1, "exactly one gh release edit");
    assert.equal(
      calls.filter((call) => call[1] === "create").length,
      1,
      "create ran exactly once",
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

/**
 * @param {ReturnType<typeof createFixtureRepo>} fixture
 * @returns {string[][]}
 */
function readGhCalls(fixture) {
  const file = fixture.callsFile;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("pollGithubSignatureVerification: succeeds when verified, fails on timeout", async () => {
  const ctx = releaseFixture();
  try {
    setGhRepoState(ctx.fixture, { tagVerification: "true" });
    await pollGithubSignatureVerification({
      owner: "example",
      repo: "fixture-consumer",
      tagObject: "a".repeat(40),
      cwd: ctx.fixture.consumer,
      env: ctx.env,
    });
    setGhRepoState(ctx.fixture, { tagVerification: "null" });
    const err = await expectCliError(() =>
      pollGithubSignatureVerification({
        owner: "example",
        repo: "fixture-consumer",
        tagObject: "a".repeat(40),
        cwd: ctx.fixture.consumer,
        env: ctx.env,
        attempts: 1,
        delayMs: 1,
      }),
    );
    assert.match(
      err.message,
      /Checked: that GitHub reports the tag signature verified\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("verifyOnlyTag: a divergent (wrong-target, lightweight) remote tag is a hard fail", async () => {
  const ctx = releaseFixture();
  try {
    // A lightweight remote tag: the fetch+verify must refuse it (not
    // annotated, not signed) — divergent-state hard fail without gpg.
    git(["push", "origin", "HEAD:refs/tags/v1.2.2"], {
      cwd: ctx.fixture.consumer,
      env: ctx.env,
    });
    const err = await expectCliError(() =>
      verifyOnlyTag({
        version: "1.2.2",
        targetSha: ctx.head,
        fingerprint: "a".repeat(40),
        cwd: ctx.fixture.consumer,
        env: ctx.env,
      }),
    );
    assert.match(
      err.message,
      /Checked: that v1\.2\.2 is an annotated tag object\./,
    );
    assert.match(err.message, /Found: it is a commit object\./);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("release: refuses without the App token when tag-exists=false (before any mutation)", async () => {
  const ctx = releaseFixture();
  try {
    seedPublishState(ctx);
    const env = { ...ctx.env, NPM_RELEASE_FLOW_APP_TOKEN: "" };
    const problems = [];
    const code = await release({
      cwd: ctx.fixture.consumer,
      env,
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(problems.join("\n"), /Checked: NPM_RELEASE_FLOW_APP_TOKEN\./);
    // No tag was created.
    assert.equal(
      remoteRefSha("refs/tags/v1.2.2", {
        cwd: ctx.fixture.consumer,
        env: ctx.env,
      }),
      null,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("release: refuses a missing VERSION env value", async () => {
  const ctx = releaseFixture();
  try {
    const problems = [];
    const code = await release({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, VERSION: "" },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(problems.join("\n"), /Checked: VERSION\./);
  } finally {
    ctx.fixture.cleanup();
  }
});

test(
  "release: full happy path (tag create+push, API poll, publish, GitHub Release) end to end",
  { skip: !hasGpg && "gpg is not available or ignores GNUPGHOME" },
  async () => {
    const ctx = releaseFixture();
    try {
      seedPublishState(ctx);
      const signing = createSigningHome(ctx.fixture.base);
      git(["config", "user.signingkey", signing.fingerprint], {
        cwd: ctx.fixture.consumer,
        env: ctx.env,
      });
      const env = {
        ...ctx.env,
        GNUPGHOME: signing.home,
        NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
      };
      const problems = [];
      const code = await release({
        cwd: ctx.fixture.consumer,
        env,
        log: (line) => problems.push(line),
      });
      assert.equal(code, 0, problems.join("\n"));
      // The tag was pushed and verified.
      const remote = remoteRefSha("refs/tags/v1.2.2", {
        cwd: ctx.fixture.consumer,
        env,
      });
      assert.ok(remote);
      // npm publish ran with the pinned registry.
      assert.ok(
        npmCalls(ctx.npmShim.callsFile).some((call) => call[0] === "publish"),
      );
      // The GitHub Release was created with --verify-tag.
      assert.ok(
        readGhCalls(ctx.fixture).some(
          (call) => call[1] === "create" && call.includes("--verify-tag"),
        ),
      );
    } finally {
      ctx.fixture.cleanup();
    }
  },
);

test(
  "release: tag push uses Basic x-access-token auth, not Bearer",
  { skip: !hasGpg && "gpg is not available or ignores GNUPGHOME" },
  async () => {
    const ctx = releaseFixture();
    const recorder = createGitRecorder(ctx.fixture.base);
    const recordedEnv = {
      ...ctx.env,
      PATH:
        recorder.dir +
        (process.platform === "win32" ? ";" : ":") +
        ctx.env.PATH,
      GIT_FIXTURE_CALLS: recorder.callsFile,
    };
    try {
      seedPublishState(ctx);
      const signing = createSigningHome(ctx.fixture.base);
      git(["config", "user.signingkey", signing.fingerprint], {
        cwd: ctx.fixture.consumer,
        env: recordedEnv,
      });
      const env = {
        ...recordedEnv,
        GNUPGHOME: signing.home,
        NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
      };
      const code = await release({
        cwd: ctx.fixture.consumer,
        env,
        log: () => {},
      });
      assert.equal(code, 0);
      const expected = `http.extraheader=Authorization: Basic ${Buffer.from(`x-access-token:${env.NPM_RELEASE_FLOW_APP_TOKEN}`).toString("base64")}`;
      const calls = gitCalls(recorder.callsFile);
      const push = calls.find((call) => call.includes("push"));
      assert.ok(push, "a git push was recorded");
      assert.ok(
        push.includes(expected),
        `push must use Basic x-access-token auth (expected ${expected}, got ${JSON.stringify(push)})`,
      );
      assert.ok(
        push.every((arg) => !arg.includes("Authorization: Bearer")),
        `push must not use Bearer auth (got ${JSON.stringify(push)})`,
      );
    } finally {
      ctx.fixture.cleanup();
    }
  },
);
