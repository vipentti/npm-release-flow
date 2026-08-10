import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { prepare, compareUrlFromRepoUrl } from "../src/commands/prepare.mjs";
import { CliError, ExitCode } from "../src/lib/errors.mjs";
import {
  git,
  localRefSha,
  remoteRefSha,
  currentSha,
  isCleanWorktree,
} from "../src/lib/repo-state.mjs";
import {
  createFixtureRepo,
  createGitPushBlocker,
  createSigningHome,
  envWithShim,
  gpgFixtureUsable,
  ghCalls,
  readConsumerFile,
  setGhPrCreateUrl,
  setGhPrs,
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
 * Fixture with a signing key configured in the consumer repo.
 */
function signingFixture() {
  const fixture = createFixtureRepo();
  const signing = createSigningHome(fixture.base);
  git(["config", "user.signingkey", signing.fingerprint], {
    cwd: fixture.consumer,
  });
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
  };
  return { fixture, env };
}

function signedEnvFor(fixture, signing) {
  return { ...envWithShim(fixture), GNUPGHOME: signing.home };
}

test("compareUrlFromRepoUrl derives the compare URL from repository.url", () => {
  assert.equal(
    compareUrlFromRepoUrl("git+https://github.com/owner/repo.git"),
    "https://github.com/owner/repo/compare",
  );
  assert.equal(
    compareUrlFromRepoUrl("https://github.com/owner/repo"),
    "https://github.com/owner/repo/compare",
  );
  assert.equal(compareUrlFromRepoUrl("git@github.com:owner/repo.git"), null);
  assert.equal(compareUrlFromRepoUrl(undefined), null);
  assert.equal(compareUrlFromRepoUrl("https://gitlab.com/owner/repo.git"), null);
});

test("prepare rejects a non-stable version", async () => {
  const fixture = createFixtureRepo();
  try {
    const err = await expectCliError(
      prepare({ version: "1.2", execute: false }, { cwd: fixture.consumer }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: the requested version\./);
    assert.match(err.message, /Found: "1\.2"\./);
    assert.match(err.message, /Correction: use a stable X\.Y\.Z version/);
  } finally {
    fixture.cleanup();
  }
});

test("prepare dry-run prints every would-mutation and changes nothing", async () => {
  const { fixture, env } = signingFixture();
  try {
    const lines = [];
    const code = await prepare(
      { version: "1.2.3", execute: false },
      { cwd: fixture.consumer, env, log: (line) => lines.push(line) },
    );
    assert.equal(code, 0);
    const planText = lines.join("\n");
    assert.match(planText, /Signing preflight: commit-signing key [0-9a-fA-F]{40} available/);
    assert.match(planText, /Would cut the changelog for 1\.2\.3/);
    assert.match(planText, /Would set package\.json\.version = 1\.2\.3/);
    assert.match(planText, /Would set package-lock\.json\.version = 1\.2\.3/);
    assert.match(planText, /Would commit -S -m "release: 1\.2\.3"/);
    assert.match(planText, /Would push release\/v1\.2\.3 to origin/);
    assert.match(planText, /Would create the release PR/);
    // No mutations: clean tree, no branch, no remote ref, files unchanged.
    assert.equal(isCleanWorktree({ cwd: fixture.consumer }), true);
    assert.equal(
      localRefSha("refs/heads/release/v1.2.3", { cwd: fixture.consumer }),
      null,
    );
    assert.equal(
      remoteRefSha("refs/heads/release/v1.2.3", { cwd: fixture.consumer, env }),
      null,
    );
    assert.match(readConsumerFile(fixture, "package.json"), /"version": "1\.2\.2"/);
    assert.match(readConsumerFile(fixture, "CHANGELOG.md"), /## \[Unreleased\]/);
    // gh was only asked to list PRs, never to create one.
    const calls = ghCalls(fixture);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 4), ["pr", "list", "--head", "release/v1.2.3"]);
  } finally {
    fixture.cleanup();
  }
});

test(
  "prepare --execute creates the branch, signed commit, push, and PR, then returns to main",
  { skip: !hasGpg && "gpg is not available or ignores GNUPGHOME" },
  async () => {
    const { fixture, env } = signingFixture();
    setGhPrCreateUrl(fixture, "https://github.com/example/fixture-consumer/pull/42");
    try {
      const lines = [];
      const code = await prepare(
        { version: "1.2.3", execute: true },
        { cwd: fixture.consumer, env, log: (line) => lines.push(line) },
      );
      assert.equal(code, 0);

      // Back on main, which still carries the old version.
      assert.equal(git(["branch", "--show-current"], { cwd: fixture.consumer }).stdout.trim(), "main");
      assert.match(readConsumerFile(fixture, "package.json"), /"version": "1\.2\.2"/);

      // The release branch exists locally and remotely with the same SHA.
      const branchSha = localRefSha("refs/heads/release/v1.2.3", {
        cwd: fixture.consumer,
      });
      assert.ok(branchSha);
      const remoteSha = remoteRefSha("refs/heads/release/v1.2.3", {
        cwd: fixture.consumer,
        env,
      });
      assert.equal(remoteSha, branchSha);

      // The commit: message, one parent, signature, exact changed set.
      git(["checkout", "release/v1.2.3"], { cwd: fixture.consumer });
      assert.equal(
        git(["log", "-1", "--format=%s"], { cwd: fixture.consumer }).stdout.trim(),
        "release: 1.2.3",
      );
      const parents = git(["log", "-1", "--format=%P"], { cwd: fixture.consumer })
        .stdout.trim()
        .split(/\s+/)
        .filter(Boolean);
      assert.equal(parents.length, 1);
      assert.equal(parents[0], currentSha({ cwd: fixture.consumer, env }) ? git(["rev-parse", "main"], { cwd: fixture.consumer }).stdout.trim() : "");
      git(["verify-commit", "HEAD"], { cwd: fixture.consumer });
      const changed = git(
        ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
        { cwd: fixture.consumer },
      )
        .stdout.trim()
        .split("\n")
        .filter(Boolean);
      assert.deepEqual(changed.sort(), [
        "CHANGELOG.md",
        "package-lock.json",
        "package.json",
      ]);

      // The control files on the branch reflect the release.
      const branchChangelog = readConsumerFile(fixture, "CHANGELOG.md");
      assert.match(branchChangelog, /## \[1\.2\.3\] - \d{4}-\d{2}-\d{2}/);
      assert.match(branchChangelog, /- Added a fixture feature\./);
      assert.match(branchChangelog, /## \[Unreleased\]\n\n## \[1\.2\.3\]/);
      assert.match(readConsumerFile(fixture, "package.json"), /"version": "1\.2\.3"/);
      const branchLock = readConsumerFile(fixture, "package-lock.json");
      assert.match(branchLock, /"version": "1\.2\.3"/);
      git(["checkout", "main"], { cwd: fixture.consumer });

      // The PR was created with the kit-version skew marker in the body.
      const calls = ghCalls(fixture);
      const prCreate = calls.find((call) => call[1] === "create");
      assert.ok(prCreate, "gh pr create was called");
      assert.deepEqual(prCreate.slice(1, 5), ["create", "--title", "release: 1.2.3"]);
      const body = prCreate[prCreate.indexOf("--body") + 1];
      assert.match(body, /^Kit: @vipentti\/npm-release-flow@\d+\.\d+\.\d+$/);
    } finally {
      fixture.cleanup();
    }
  },
);

test("prepare exits 2 for an open PR even with local/remote branches present", async () => {
  const { fixture, env } = signingFixture();
  try {
    git(["checkout", "-b", "release/v1.2.3"], { cwd: fixture.consumer });
    git(["push", "-u", "origin", "release/v1.2.3"], { cwd: fixture.consumer, env });
    git(["checkout", "main"], { cwd: fixture.consumer });
    setGhPrs(fixture, "release/v1.2.3", [
      { number: 7, state: "OPEN", url: "https://github.com/example/fixture-consumer/pull/7" },
    ]);
    const err = await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.NOOP,
    );
    assert.match(err.message, /Found: an open release PR already exists/);
    assert.match(err.message, /Correction: nothing to do; the release is already prepared\./);
  } finally {
    fixture.cleanup();
  }
});

test("prepare exits 2 for a merged PR where main already has the requested version", async () => {
  const { fixture, env } = signingFixture();
  try {
    // Advance main to 1.2.3 without a release flow.
    const pkg = JSON.parse(readConsumerFile(fixture, "package.json"));
    pkg.version = "1.2.3";
    writeFileSync(join(fixture.consumer, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    const lock = JSON.parse(readConsumerFile(fixture, "package-lock.json"));
    lock.version = "1.2.3";
    lock.packages[""].version = "1.2.3";
    writeFileSync(join(fixture.consumer, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
    git(["add", "."], { cwd: fixture.consumer, env });
    git(["commit", "-m", "bump to 1.2.3"], { cwd: fixture.consumer, env });
    git(["push", "origin", "main"], { cwd: fixture.consumer, env });
    setGhPrs(fixture, "release/v1.2.3", [
      { number: 9, state: "MERGED", url: "https://github.com/example/fixture-consumer/pull/9" },
    ]);
    const err = await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.NOOP,
    );
    assert.match(err.message, /Found: a merged release PR already exists/);
    assert.match(err.message, /Correction: version already prepared; nothing to do\./);
  } finally {
    fixture.cleanup();
  }
});

test("prepare exits 2 for a merged PR even with retained branches", async () => {
  const { fixture, env } = signingFixture();
  try {
    git(["checkout", "-b", "release/v1.2.3"], { cwd: fixture.consumer });
    git(["push", "-u", "origin", "release/v1.2.3"], { cwd: fixture.consumer, env });
    git(["checkout", "main"], { cwd: fixture.consumer });
    setGhPrs(fixture, "release/v1.2.3", [
      { number: 9, state: "MERGED", url: "https://github.com/example/fixture-consumer/pull/9" },
    ]);
    const err = await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.NOOP,
    );
    assert.match(err.message, /version already prepared/);
  } finally {
    fixture.cleanup();
  }
});

test("prepare exits 1 for a closed-unmerged PR even with branches present", async () => {
  const { fixture, env } = signingFixture();
  try {
    git(["checkout", "-b", "release/v1.2.3"], { cwd: fixture.consumer });
    git(["checkout", "main"], { cwd: fixture.consumer });
    setGhPrs(fixture, "release/v1.2.3", [
      { number: 5, state: "CLOSED", url: "https://github.com/example/fixture-consumer/pull/5" },
    ]);
    const err = await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Found: a closed-unmerged release PR exists/);
    assert.match(err.message, /Correction: resolve it manually/);
  } finally {
    fixture.cleanup();
  }
});

test("prepare exits 1 for a conflicting local branch only", async () => {
  const { fixture, env } = signingFixture();
  try {
    git(["checkout", "-b", "release/v1.2.3"], { cwd: fixture.consumer });
    git(["checkout", "main"], { cwd: fixture.consumer });
    const err = await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: the local release branch release\/v1\.2\.3\./);
    assert.match(err.message, /Correction: delete or rename it, then rerun\./);
  } finally {
    fixture.cleanup();
  }
});

test("prepare exits 1 for a conflicting remote branch only", async () => {
  const { fixture, env } = signingFixture();
  try {
    git(["push", "origin", "main:refs/heads/release/v1.2.3"], {
      cwd: fixture.consumer,
      env,
    });
    const err = await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: the remote release branch release\/v1\.2\.3\./);
    assert.match(err.message, /Correction: resolve it manually/);
  } finally {
    fixture.cleanup();
  }
});

test("prepare exits 1 for a conflicting tag (local and remote)", async () => {
  const { fixture, env } = signingFixture();
  try {
    git(["tag", "v1.2.3"], { cwd: fixture.consumer });
    const localErr = await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(localErr.message, /Checked: the local tag v1\.2\.3\./);
    git(["push", "origin", "v1.2.3"], { cwd: fixture.consumer, env });
    git(["tag", "-d", "v1.2.3"], { cwd: fixture.consumer });
    const remoteErr = await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(remoteErr.message, /Checked: the remote tag v1\.2\.3\./);
  } finally {
    fixture.cleanup();
  }
});

test("prepare exits 1 when the version is not strictly greater", async () => {
  const { fixture, env } = signingFixture();
  try {
    const same = await expectCliError(
      prepare({ version: "1.2.2", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(same.message, /Found: package\.json\.version is "1\.2\.2"\./);
    const lower = await expectCliError(
      prepare({ version: "1.2.1", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(lower.message, /Correction: choose a higher stable version\./);
  } finally {
    fixture.cleanup();
  }
});

test("prepare exits 1 for a dirty worktree", async () => {
  const { fixture, env } = signingFixture();
  try {
    writeFileSync(join(fixture.consumer, "README.md"), "# changed\n");
    const err = await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: the working tree\./);
    assert.match(err.message, /Correction: commit or stash them before preparing a release\./);
  } finally {
    fixture.cleanup();
  }
});

test("prepare exits 1 when HEAD is not at origin/main", async () => {
  const { fixture, env } = signingFixture();
  try {
    writeFileSync(join(fixture.consumer, "README.md"), "# newer\n");
    git(["add", "."], { cwd: fixture.consumer, env });
    git(["commit", "-m", "unpushed change"], { cwd: fixture.consumer, env });
    const err = await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: HEAD against origin\/main\./);
    assert.match(err.message, /Correction: pull or rebase onto origin\/main, then rerun\./);
  } finally {
    fixture.cleanup();
  }
});

test("prepare exits 1 for a missing or empty [Unreleased] section", async () => {
  const fixture = createFixtureRepo();
  const env = envWithShim(fixture);
  try {
    const withoutUnreleased = readConsumerFile(fixture, "CHANGELOG.md").replace(
      "## [Unreleased]\n\n- Added a fixture feature.\n\n",
      "",
    );
    writeFileSync(join(fixture.consumer, "CHANGELOG.md"), withoutUnreleased);
    git(["add", "."], { cwd: fixture.consumer, env });
    git(["commit", "-m", "drop unreleased"], { cwd: fixture.consumer, env });
    git(["push", "origin", "main"], { cwd: fixture.consumer, env });
    const err = await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: the \[Unreleased\] changelog section\./);
    assert.match(err.message, /Correction: add release notes under ## \[Unreleased\]/);
  } finally {
    fixture.cleanup();
  }
});

test("prepare refuses without a configured signing key before any mutation", async () => {
  const fixture = createFixtureRepo();
  const env = envWithShim(fixture);
  try {
    const err = await expectCliError(
      prepare({ version: "1.2.3", execute: true }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: git's configured commit-signing key \(user\.signingkey\)\./);
    assert.match(err.message, /Found: no user\.signingkey is configured\./);
    // Nothing was mutated.
    assert.equal(isCleanWorktree({ cwd: fixture.consumer }), true);
    assert.equal(
      localRefSha("refs/heads/release/v1.2.3", { cwd: fixture.consumer }),
      null,
    );
  } finally {
    fixture.cleanup();
  }
});

test("prepare refuses when the configured signing key is not in the GPG keyring before any mutation", async () => {
  const fixture = createFixtureRepo();
  try {
    // A fresh, empty GNUPGHOME: the configured key cannot be there.
    const emptyHome = join(fixture.base, "empty-gnupghome");
    mkdirSync(emptyHome);
    git(["config", "user.signingkey", "f".repeat(40)], {
      cwd: fixture.consumer,
    });
    const env = { ...envWithShim(fixture), GNUPGHOME: emptyHome };
    const err = await expectCliError(
      prepare({ version: "1.2.3", execute: true }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
    assert.match(err.message, /Checked: that the configured signing key f{40} is locally available in the GPG keyring\./);
    assert.match(err.message, /Correction: import or restore the secret key in the local GPG home \(GNUPGHOME\)\./);
    assert.equal(isCleanWorktree({ cwd: fixture.consumer }), true);
  } finally {
    fixture.cleanup();
  }
});

test("prepare dry-run also refuses when the signing key is unusable (predictor semantics)", async () => {
  const fixture = createFixtureRepo();
  try {
    const emptyHome = join(fixture.base, "empty-gnupghome");
    mkdirSync(emptyHome);
    git(["config", "user.signingkey", "f".repeat(40)], {
      cwd: fixture.consumer,
    });
    const env = { ...envWithShim(fixture), GNUPGHOME: emptyHome };
    await expectCliError(
      prepare({ version: "1.2.3", execute: false }, { cwd: fixture.consumer, env }),
      ExitCode.ERROR,
    );
  } finally {
    fixture.cleanup();
  }
});

test(
  "prepare --execute reports partial state when the remote refuses the push",
  { skip: !hasGpg && "gpg is not available or ignores GNUPGHOME" },
  async () => {
  const { fixture, env } = signingFixture();
  try {
    // Block every git push via a PATH shim so the push step fails after the
    // branch and signed commit were created.
    const gitShim = createGitPushBlocker(fixture.base);
    const blockedEnv = {
      ...env,
      PATH:
        gitShim +
        (process.platform === "win32" ? ";" : ":") +
        env.PATH,
    };
    const err = await expectCliError(
      prepare(
        { version: "1.2.3", execute: true },
        { cwd: fixture.consumer, env: blockedEnv },
      ),
      ExitCode.ERROR,
    );
    // The failure message states what was created and what remains manual.
    assert.match(err.message, /Checked: pushing release\/v1\.2\.3 to origin\./);
    assert.match(err.message, /Created: branch release\/v1\.2\.3, signed commit "release: 1\.2\.3"\./);
    assert.match(err.message, /Remaining manual: push release\/v1\.2\.3 and create the release PR manually\./);
  } finally {
    fixture.cleanup();
  }
});
