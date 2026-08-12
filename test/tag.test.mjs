import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The App-token minting signs a real App JWT, so the fixture must carry a
// real (throwaway) RSA private key rather than a placeholder string.
const APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

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
import { cutChangelog } from "../src/lib/changelog.mjs";

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
 * @param root0
 * @param root0.version
 * @param root0.prNumber
 * @param root0.merge
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

function withAppMaterial(
  fixture,
  env,
  { appId = "12345", privateKey = APP_PRIVATE_KEY } = {},
) {
  setGhRepoState(fixture, { repo: "example/fixture-consumer", appId });
  return {
    ...env,
    ...(privateKey === null
      ? {}
      : { NPM_RELEASE_FLOW_APP_PRIVATE_KEY: privateKey }),
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
    const env = {
      ...envWithShim(fixture),
      GNUPGHOME: join(fixture.base, "home"),
    };
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
    assert.match(
      err.message,
      /Checked: that a usable secret key for a{40} exists in the GPG keyring\./,
    );
    assert.match(
      err.message,
      /Correction: import or restore the release secret key/,
    );
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
    assert.match(
      planText,
      /Signing preflight: secret key for [0-9a-fA-F]{40} available/,
    );
    assert.match(planText, new RegExp(`Release-merge commit: ${mergeSha}`));
    assert.match(planText, /Would create annotated signed tag v1\.2\.3 on /);
    assert.match(
      planText,
      /Would push the tag to origin \(App-authenticated\)/,
    );
    assert.equal(
      localObjectSha("refs/tags/v1.2.3", { cwd: fixture.consumer }),
      null,
    );
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
    assert.match(
      err.message,
      /Found: no first-parent commit is a valid release for this version\./,
    );
  } finally {
    fixture.cleanup();
  }
});

test("tag resolves the release on a squash-merged history", async () => {
  const fixture = createFixtureRepo();
  const signing = createSigningHome(fixture.base);
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
    NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
  };
  try {
    // A squash merge writes the release state straight onto main as a single
    // commit; tag must locate it by classification and version, not by a
    // merge-message grammar.
    const pkg = JSON.parse(readConsumerFile(fixture, "package.json"));
    pkg.version = "1.2.3";
    writeFileSync(
      join(fixture.consumer, "package.json"),
      JSON.stringify(pkg, null, 2) + "\n",
    );
    const lock = JSON.parse(readConsumerFile(fixture, "package-lock.json"));
    lock.version = "1.2.3";
    lock.packages[""].version = "1.2.3";
    writeFileSync(
      join(fixture.consumer, "package-lock.json"),
      JSON.stringify(lock, null, 2) + "\n",
    );
    const cut = cutChangelog(readConsumerFile(fixture, "CHANGELOG.md"), {
      previousVersion: "1.2.2",
      version: "1.2.3",
      date: "2026-08-01",
      compareUrl: "https://github.com/example/fixture-consumer/compare",
    });
    assert.equal(cut.ok, true, cut.reason);
    writeFileSync(
      join(fixture.consumer, "CHANGELOG.md"),
      /** @type {string} */ (cut.content),
    );
    git(["add", "."], { cwd: fixture.consumer, env });
    git(["commit", "-m", "Release v1.2.3 (#12)"], {
      cwd: fixture.consumer,
      env,
    });
    git(["push", "origin", "main"], { cwd: fixture.consumer, env });
    const squashSha = git(["rev-parse", "HEAD"], {
      cwd: fixture.consumer,
    }).stdout.trim();
    const lines = [];
    const code = await tag(
      { version: "1.2.3", execute: false },
      { cwd: fixture.consumer, env, log: (line) => lines.push(line) },
    );
    assert.equal(code, 0);
    assert.match(
      lines.join("\n"),
      new RegExp(`Release-merge commit: ${squashSha}`),
    );
  } finally {
    fixture.cleanup();
  }
});

test("tag refuses a release-like commit whose diff is not a valid release", async () => {
  const fixture = createFixtureRepo();
  const signing = createSigningHome(fixture.base);
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
    NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
  };
  try {
    // A version bump to 1.2.3 whose diff carries an extra file: the commit
    // is the version match, but classification rejects it as a release.
    const branch = "release/v1.2.3";
    git(["checkout", "-b", branch], { cwd: fixture.consumer, env });
    const pkg = JSON.parse(readConsumerFile(fixture, "package.json"));
    pkg.version = "1.2.3";
    writeFileSync(
      join(fixture.consumer, "package.json"),
      JSON.stringify(pkg, null, 2) + "\n",
    );
    const lock = JSON.parse(readConsumerFile(fixture, "package-lock.json"));
    lock.version = "1.2.3";
    lock.packages[""].version = "1.2.3";
    writeFileSync(
      join(fixture.consumer, "package-lock.json"),
      JSON.stringify(lock, null, 2) + "\n",
    );
    writeFileSync(join(fixture.consumer, "README.md"), "# changed too\n");
    git(["add", "."], { cwd: fixture.consumer, env });
    git(["commit", "-m", "release: 1.2.3"], { cwd: fixture.consumer, env });
    git(["checkout", "main"], { cwd: fixture.consumer, env });
    git(["merge", "--no-ff", "-m", "Merge branch 'release/v1.2.3'", branch], {
      cwd: fixture.consumer,
      env,
    });
    git(["branch", "-D", branch], { cwd: fixture.consumer, env });
    git(["push", "origin", "main"], { cwd: fixture.consumer, env });

    const err = await expectCliError(
      tag({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(
      err.message,
      /Checked: the release merge of v1\.2\.3 as a valid release\./,
    );
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
    assert.match(
      lines.join("\n"),
      new RegExp(`Release-merge commit: ${mergeSha}`),
    );
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
      GIT_FIXTURE_CALLS: recorder.callsFile,
      PATH:
        recorder.dir + (process.platform === "win32" ? ";" : ":") + blockedPath,
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
      assert.equal(
        localObjectSha("refs/tags/v1.2.3", { cwd: fixture.consumer }) !== null,
        true,
      );
      assert.equal(
        git(["rev-parse", "refs/tags/v1.2.3^{commit}"], {
          cwd: fixture.consumer,
        }).stdout.trim(),
        mergeSha,
      );
      // The remote tag equals the local tag object.
      const remoteSha = remoteRefSha("refs/tags/v1.2.3", {
        cwd: fixture.consumer,
        env,
      });
      assert.equal(
        remoteSha,
        localObjectSha("refs/tags/v1.2.3", { cwd: fixture.consumer }),
      );
      // The push carried the App token in the extraheader as Basic x-access-token.
      const calls = gitCalls(recorder.callsFile);
      const push = calls.find((call) => call.includes("push"));
      assert.ok(push, "a git push was recorded");
      const expected =
        "http.extraheader=Authorization: Basic " +
        Buffer.from("x-access-token:fixture-app-token").toString("base64");
      const extraheaderIndex = push.indexOf(expected);
      assert.ok(
        extraheaderIndex !== -1,
        `push carried the Basic x-access-token extraheader (expected ${expected})`,
      );
      assert.ok(
        push.indexOf("-c") < extraheaderIndex,
        "-c precedes the extraheader",
      );
      assert.ok(
        push.every((arg) => !arg.includes("Authorization: Bearer")),
        "push must not use Bearer auth",
      );
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
        GIT_FIXTURE_CALLS: recorder.callsFile,
        PATH:
          recorder.dir +
          (process.platform === "win32" ? ";" : ":") +
          firstEnv.PATH,
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
      GIT_FIXTURE_CALLS: recorder.callsFile,
      PATH:
        recorder.dir + (process.platform === "win32" ? ";" : ":") + appEnv.PATH,
    };
    const restore = stubAppToken();
    try {
      // First run creates and pushes the tag; delete the remote tag so the
      // rerun exercises the local-only-tag push path.
      await tag(
        { version: "1.2.3", execute: true },
        { cwd: fixture.consumer, env: appEnv },
      );
      git(["push", "origin", ":refs/tags/v1.2.3"], {
        cwd: fixture.consumer,
        env,
      });
      const lines = [];
      const code = await tag(
        { version: "1.2.3", execute: true },
        { cwd: fixture.consumer, env: runEnv, log: (line) => lines.push(line) },
      );
      assert.equal(code, 0);
      assert.match(
        lines.join("\n"),
        /Pushed existing tag v1\.2\.3; remote object verified/,
      );
      const remoteSha = remoteRefSha("refs/tags/v1.2.3", {
        cwd: fixture.consumer,
        env,
      });
      assert.equal(
        remoteSha,
        localObjectSha("refs/tags/v1.2.3", { cwd: fixture.consumer }),
      );
      const push = gitCalls(recorder.callsFile).find((call) =>
        call.includes("push"),
      );
      assert.ok(push);
      const expectedBasic =
        "http.extraheader=Authorization: Basic " +
        Buffer.from("x-access-token:fixture-app-token").toString("base64");
      assert.ok(
        push.includes(expectedBasic),
        `rerun push carried the Basic x-access-token extraheader (expected ${expectedBasic})`,
      );
      assert.ok(
        push.every((arg) => !arg.includes("Authorization: Bearer")),
        "rerun push must not use Bearer auth",
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
      assert.match(
        err.message,
        /Checked: NPM_RELEASE_FLOW_APP_PRIVATE_KEY in the local environment\./,
      );
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
      assert.match(
        err.message,
        /Checked: the NPM_RELEASE_FLOW_APP_ID repository variable/,
      );
      assert.match(err.message, /Created: local tag v1\.2\.3\./);
    } finally {
      fixture.cleanup();
    }
  },
);
