import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tag } from "../src/commands/tag.mjs";
import { CliError, ExitCode } from "../src/lib/errors.mjs";
import {
  git,
  localObjectSha,
  remoteRefSha,
  isCleanWorktree,
} from "../src/lib/repo-state.mjs";
import {
  createFixtureRepo,
  createGitRecorder,
  createReleaseMerge,
  createSigningHome,
  envWithShim,
  gpgFixtureUsable,
  gitCalls,
  readConsumerFile,
  setGhRepoState,
} from "./helpers/fixture.mjs";

const hasGpg = gpgFixtureUsable();

/**
 * @param {Promise<unknown>} promise
 * @param {number} expectedExitCode
 * @returns {Promise<CliError>}
 */
async function expectCliError(promise, expectedExitCode) {
  try {
    await promise;
  } catch (err) {
    assert.ok(
      err instanceof CliError,
      `expected CliError, got ${err?.constructor?.name ?? err}`,
    );
    assert.equal(err.exitCode, expectedExitCode);
    return err;
  }
  assert.fail("expected the command to throw CliError");
}

/**
 * Fixture with a release merge on main and the tag signing material.
 */
function tagFixture({ version = "1.2.3", prNumber = 12, merge = true } = {}) {
  const fixture = createFixtureRepo();
  const signing = createSigningHome(fixture.base);
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
    NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
  };
  const mergeSha = merge
    ? createReleaseMerge(fixture, { version, prNumber }, env)
    : null;
  return { fixture, env, signing, mergeSha };
}

function withAppMaterial(fixture, env, { appId = "12345", privateKey = "fixture-pem" } = {}) {
  setGhRepoState(fixture, { repo: "example/fixture-consumer", appId });
  return {
    ...env,
    ...(privateKey === null ? {} : { NPM_RELEASE_FLOW_APP_PRIVATE_KEY: privateKey }),
  };
}

/**
 * Stub the App-token exchange (installation + access token).
 *
 * @returns {() => void}
 */
function stubAppToken() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/installation")) {
      return { ok: true, status: 200, json: async () => ({ id: 9876 }) };
    }
    if (u.endsWith("/access_tokens")) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: "fixture-app-token" }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return () => {
    globalThis.fetch = original;
  };
}

test("tag refuses a non-stable version", async () => {
  const fixture = createFixtureRepo();
  try {
    const err = await expectCliError(
      tag({ version: "1.2", execute: false }, { cwd: fixture.consumer }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: the requested version\./);
  } finally {
    fixture.cleanup();
  }
});

test("tag refuses a missing NPM_RELEASE_FLOW_GPG_FINGERPRINT", async () => {
  const fixture = createFixtureRepo();
  try {
    const env = { ...envWithShim(fixture), GNUPGHOME: join(fixture.base, "home") };
    const err = await expectCliError(
      tag({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: NPM_RELEASE_FLOW_GPG_FINGERPRINT\./);
    assert.match(err.message, /Found: the environment variable is not set\./);
  } finally {
    fixture.cleanup();
  }
});

test("tag refuses a malformed NPM_RELEASE_FLOW_GPG_FINGERPRINT", async () => {
  const fixture = createFixtureRepo();
  try {
    const env = {
      ...envWithShim(fixture),
      GNUPGHOME: join(fixture.base, "home"),
      NPM_RELEASE_FLOW_GPG_FINGERPRINT: "xyz",
    };
    const err = await expectCliError(
      tag({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /not 40 hexadecimal characters/);
  } finally {
    fixture.cleanup();
  }
});

test("tag refuses when the fingerprint's secret key is not in the keyring", async () => {
  const fixture = createFixtureRepo();
  try {
    const emptyHome = join(fixture.base, "empty-home");
    mkdirSync(emptyHome);
    const env = {
      ...envWithShim(fixture),
      GNUPGHOME: emptyHome,
      NPM_RELEASE_FLOW_GPG_FINGERPRINT: "a".repeat(40),
    };
    const err = await expectCliError(
      tag({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: that a usable secret key for a{40} exists in the GPG keyring\./);
    assert.match(err.message, /Correction: import or restore the release secret key/);
  } finally {
    fixture.cleanup();
  }
});

test("tag dry-run resolves the release merge, prints the plan, and mutates nothing", async () => {
  const { fixture, env, mergeSha } = tagFixture();
  try {
    const lines = [];
    const code = await tag(
      { version: "1.2.3", execute: false },
      { cwd: fixture.consumer, env, log: (line) => lines.push(line) },
    );
    assert.equal(code, 0);
    const planText = lines.join("\n");
    assert.match(planText, /Signing preflight: secret key for [0-9a-fA-F]{40} available/);
    assert.match(planText, new RegExp(`Release-merge commit: ${mergeSha}`));
    assert.match(planText, /Would create annotated signed tag v1\.2\.3 on /);
    assert.match(planText, /Would push the tag to origin \(App-authenticated\)/);
    assert.equal(localObjectSha("refs/tags/v1.2.3", { cwd: fixture.consumer }), null);
    assert.equal(isCleanWorktree({ cwd: fixture.consumer }), true);
  } finally {
    fixture.cleanup();
  }
});

test("tag refuses when no release merge matches (zero candidates)", async () => {
  const fixture = createFixtureRepo();
  const signing = createSigningHome(fixture.base);
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
    NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
  };
  try {
    const err = await expectCliError(
      tag({ version: "9.9.9", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Found: no commit matches the release-merge message grammar\./);
  } finally {
    fixture.cleanup();
  }
});

test("tag refuses when multiple release merges match", async () => {
  const fixture = createFixtureRepo();
  const signing = createSigningHome(fixture.base);
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
    NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
  };
  try {
    createReleaseMerge(fixture, { version: "1.2.3", prNumber: 12 }, env);
    // A second merge whose message claims release/v1.2.3 (wrong version in
    // the message) makes two candidates for the v1.2.3 pattern.
    const branch = "release/v1.2.4";
    git(["checkout", "-b", branch], { cwd: fixture.consumer, env });
    const pkg = JSON.parse(
      readConsumerFile(fixture, "package.json"),
    );
    pkg.version = "1.2.4";
    writeFileSync(
      join(fixture.consumer, "package.json"),
      JSON.stringify(pkg, null, 2) + "\n",
    );
    git(["add", "."], { cwd: fixture.consumer, env });
    git(["commit", "-m", "release: 1.2.4"], { cwd: fixture.consumer, env });
    git(["checkout", "main"], { cwd: fixture.consumer, env });
    git(
      [
        "merge",
        "--no-ff",
        "-m",
        "Merge pull request #13 from example/fixture-consumer/release/v1.2.3",
        branch,
      ],
      { cwd: fixture.consumer, env },
    );
    git(["branch", "-D", branch], { cwd: fixture.consumer, env });
    git(["push", "origin", "main"], { cwd: fixture.consumer, env });

    const err = await expectCliError(
      tag({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Found: 2 commits match the release-merge message grammar\./);
  } finally {
    fixture.cleanup();
  }
});

test("tag refuses a release-like merge whose diff is not a valid release", async () => {
  const fixture = createFixtureRepo();
  const signing = createSigningHome(fixture.base);
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
    NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
  };
  try {
    // Merge with the release grammar but only a README change.
    const branch = "release/v1.2.3";
    git(["checkout", "-b", branch], { cwd: fixture.consumer, env });
    writeFileSync(join(fixture.consumer, "README.md"), "# only a doc change\n");
    git(["add", "."], { cwd: fixture.consumer, env });
    git(["commit", "-m", "docs"], { cwd: fixture.consumer, env });
    git(["checkout", "main"], { cwd: fixture.consumer, env });
    git(
      [
        "merge",
        "--no-ff",
        "-m",
        "Merge pull request #12 from example/fixture-consumer/release/v1.2.3",
        branch,
      ],
      { cwd: fixture.consumer, env },
    );
    git(["branch", "-D", branch], { cwd: fixture.consumer, env });
    git(["push", "origin", "main"], { cwd: fixture.consumer, env });

    const err = await expectCliError(
      tag({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: the release merge of v1\.2\.3 as a valid release\./);
  } finally {
    fixture.cleanup();
  }
});

test("tag resolves the release merge after later ordinary commits on main", async () => {
  const { fixture, env, mergeSha } = tagFixture();
  try {
    writeFileSync(join(fixture.consumer, "README.md"), "# later work\n");
    git(["add", "."], { cwd: fixture.consumer, env });
    git(["commit", "-m", "ordinary follow-up"], { cwd: fixture.consumer, env });
    git(["push", "origin", "main"], { cwd: fixture.consumer, env });
    const lines = [];
    const code = await tag(
      { version: "1.2.3", execute: false },
      { cwd: fixture.consumer, env, log: (line) => lines.push(line) },
    );
    assert.equal(code, 0);
    assert.match(lines.join("\n"), new RegExp(`Release-merge commit: ${mergeSha}`));
  } finally {
    fixture.cleanup();
  }
});

test("tag exits 1 for a divergent remote tag", async () => {
  const { fixture, env } = tagFixture();
  try {
    // A remote lightweight tag pointing at main's tip (not the release merge).
    git(["push", "origin", "main:refs/tags/v1.2.3"], {
      cwd: fixture.consumer,
      env,
    });
    const err = await expectCliError(
      tag({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(
      err.message,
      /the remote tag object against the local copy|not an annotated tag object|points at|it is a commit object/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("tag refuses a dirty worktree", async () => {
  const { fixture, env } = tagFixture();
  try {
    writeFileSync(join(fixture.consumer, "README.md"), "# dirty\n");
    const err = await expectCliError(
      tag({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: the working tree\./);
  } finally {
    fixture.cleanup();
  }
});

test(
  "tag --execute creates, verifies, and App-token-pushes the tag",
  { skip: !hasGpg && "gpg is not available or ignores GNUPGHOME" },
  async () => {
    const { fixture, env, mergeSha } = tagFixture();
    const recorder = createGitRecorder(fixture.base);
    const appEnv = withAppMaterial(fixture, env);
    const blockedPath = appEnv.PATH;
    const runEnv = {
      ...appEnv,
      PATH: recorder.dir + (process.platform === "win32" ? ";" : ":") + blockedPath,
    };
    const restore = stubAppToken();
    try {
      const lines = [];
      const code = await tag(
        { version: "1.2.3", execute: true },
        { cwd: fixture.consumer, env: runEnv, log: (line) => lines.push(line) },
      );
      assert.equal(code, 0);
      assert.match(lines.join("\n"), /Created and verified local tag v1\.2\.3/);
      assert.match(lines.join("\n"), /Pushed v1\.2\.3; remote object verified/);

      // The local tag exists, is annotated, points at the merge, and verifies.
      assert.equal(localObjectSha("refs/tags/v1.2.3", { cwd: fixture.consumer }) !== null, true);
      assert.equal(
        git(["rev-parse", "refs/tags/v1.2.3^{commit}"], { cwd: fixture.consumer }).stdout.trim(),
        mergeSha,
      );
      // The remote tag equals the local tag object.
      const remoteSha = remoteRefSha("refs/tags/v1.2.3", { cwd: fixture.consumer, env });
      assert.equal(remoteSha, localObjectSha("refs/tags/v1.2.3", { cwd: fixture.consumer }));
      // The push carried the App token in the extraheader.
      const calls = gitCalls(recorder.callsFile);
      const push = calls.find((call) => call.includes("push"));
      assert.ok(push, "a git push was recorded");
      const extraheaderIndex = push.indexOf("http.extraheader=Authorization: Bearer fixture-app-token");
      assert.ok(extraheaderIndex !== -1, "push carried the App token extraheader");
      assert.ok(push.indexOf("-c") < extraheaderIndex, "-c precedes the extraheader");
    } finally {
      restore();
      fixture.cleanup();
    }
  },
);

test(
  "tag --execute with a valid remote tag verifies without pushing",
  { skip: !hasGpg && "gpg is not available or ignores GNUPGHOME" },
  async () => {
    const { fixture, env } = tagFixture();
    const restore = stubAppToken();
    try {
      // First run creates and pushes the tag.
      const firstEnv = withAppMaterial(fixture, env);
      await tag(
        { version: "1.2.3", execute: true },
        { cwd: fixture.consumer, env: firstEnv },
      );
      // Second run: remote tag present -> fetch + verify, no push.
      const recorder = createGitRecorder(fixture.base);
      const runEnv = {
        ...firstEnv,
        PATH: recorder.dir + (process.platform === "win32" ? ";" : ":") + firstEnv.PATH,
      };
      const lines = [];
      const code = await tag(
        { version: "1.2.3", execute: true },
        { cwd: fixture.consumer, env: runEnv, log: (line) => lines.push(line) },
      );
      assert.equal(code, 0);
      assert.match(lines.join("\n"), /present and valid; verified, no push/);
      const calls = gitCalls(recorder.callsFile);
      assert.equal(
        calls.some((call) => call.includes("push")),
        false,
        "no push on the verify-only rerun",
      );
    } finally {
      restore();
      fixture.cleanup();
    }
  },
);

test(
  "tag --execute pushes an existing local tag when the remote has none",
  { skip: !hasGpg && "gpg is not available or ignores GNUPGHOME" },
  async () => {
    const { fixture, env } = tagFixture();
    const recorder = createGitRecorder(fixture.base);
    const appEnv = withAppMaterial(fixture, env);
    const runEnv = {
      ...appEnv,
      PATH: recorder.dir + (process.platform === "win32" ? ";" : ":") + appEnv.PATH,
    };
    const restore = stubAppToken();
    try {
      // First run creates and pushes the tag; delete the remote tag so the
      // rerun exercises the local-only-tag push path.
      await tag(
        { version: "1.2.3", execute: true },
        { cwd: fixture.consumer, env: appEnv },
      );
      git(["push", "origin", ":refs/tags/v1.2.3"], { cwd: fixture.consumer, env });
      const lines = [];
      const code = await tag(
        { version: "1.2.3", execute: true },
        { cwd: fixture.consumer, env: runEnv, log: (line) => lines.push(line) },
      );
      assert.equal(code, 0);
      assert.match(lines.join("\n"), /Pushed existing tag v1\.2\.3; remote object verified/);
      const remoteSha = remoteRefSha("refs/tags/v1.2.3", { cwd: fixture.consumer, env });
      assert.equal(remoteSha, localObjectSha("refs/tags/v1.2.3", { cwd: fixture.consumer }));
      const push = gitCalls(recorder.callsFile).find((call) => call.includes("push"));
      assert.ok(push);
      assert.ok(
        push.includes("http.extraheader=Authorization: Bearer fixture-app-token"),
        "rerun push carried the App token extraheader",
      );
    } finally {
      restore();
      fixture.cleanup();
    }
  },
);

test(
  "tag --execute refuses without the App private key and reports partial state",
  { skip: !hasGpg && "gpg is not available or ignores GNUPGHOME" },
  async () => {
    const { fixture, env } = tagFixture();
    const appEnv = withAppMaterial(fixture, env, { privateKey: null });
    try {
      const err = await expectCliError(
        tag(
          { version: "1.2.3", execute: true },
          { cwd: fixture.consumer, env: appEnv },
        ),
        ExitCode.ERROR,
      );
      assert.match(err.message, /Checked: NPM_RELEASE_FLOW_APP_PRIVATE_KEY in the local environment\./);
      assert.match(err.message, /Created: local tag v1\.2\.3\./);
    } finally {
      fixture.cleanup();
    }
  },
);

test(
  "tag --execute refuses without the App ID variable and reports partial state",
  { skip: !hasGpg && "gpg is not available or ignores GNUPGHOME" },
  async () => {
    const { fixture, env } = tagFixture();
    const appEnv = withAppMaterial(fixture, env, { appId: "" });
    try {
      const err = await expectCliError(
        tag(
          { version: "1.2.3", execute: true },
          { cwd: fixture.consumer, env: appEnv },
        ),
        ExitCode.ERROR,
      );
      assert.match(err.message, /Checked: the NPM_RELEASE_FLOW_APP_ID repository variable/);
      assert.match(err.message, /Created: local tag v1\.2\.3\./);
    } finally {
      fixture.cleanup();
    }
  },
);
