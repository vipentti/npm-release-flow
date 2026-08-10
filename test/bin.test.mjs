import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { main } from "../bin/npm-release-flow.mjs";
import { ExitCode } from "../src/lib/errors.mjs";
import { runSync } from "../src/lib/spawn.mjs";
import {
  createFixtureRepo,
  createSigningHome,
  envWithShim,
  setGhPrs,
  setGhRepoState,
  setRepoSigningKey,
} from "./helpers/fixture.mjs";

const binPath = fileURLToPath(
  new URL("../bin/npm-release-flow.mjs", import.meta.url),
);

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
 * Run the bin as a subprocess and capture status/stdout/stderr.
 * @param args
 * @param root0
 * @param root0.cwd
 * @param root0.env
 */
function runBin(args, { cwd, env }) {
  try {
    const result = runSync(process.execPath, [binPath, ...args], { cwd, env });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    return { status: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

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
  return { fixture, env };
}

function prepareFixture() {
  const fixture = createFixtureRepo();
  const signing = createSigningHome(fixture.base);
  setRepoSigningKey(fixture, signing.fingerprint);
  const env = {
    ...envWithShim(fixture),
    GNUPGHOME: signing.home,
  };
  return { fixture, env };
}

test("bin: no subcommand exits 1 with usage on stderr", () => {
  const fixture = createFixtureRepo({ remote: false });
  try {
    const result = runBin([], {
      cwd: fixture.consumer,
      env: envWithShim(fixture),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing subcommand/);
    assert.match(
      result.stderr,
      /usage: npm-release-flow <prepare\|tag\|check>/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("bin: unknown subcommand exits 1 with usage on stderr", () => {
  const fixture = createFixtureRepo({ remote: false });
  try {
    const result = runBin(["frobnicate"], {
      cwd: fixture.consumer,
      env: envWithShim(fixture),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown subcommand "frobnicate"/);
    assert.match(result.stderr, /usage: npm-release-flow/);
  } finally {
    fixture.cleanup();
  }
});

test("bin: unknown flag exits 1 with usage on stderr", () => {
  const fixture = createFixtureRepo({ remote: false });
  try {
    const result = runBin(["check", "--bogus"], {
      cwd: fixture.consumer,
      env: envWithShim(fixture),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option '--bogus'/);
    assert.match(result.stderr, /usage: npm-release-flow/);
  } finally {
    fixture.cleanup();
  }
});

test("bin: --help prints usage on stdout and exits 0", () => {
  const fixture = createFixtureRepo({ remote: false });
  try {
    const result = runBin(["--help"], {
      cwd: fixture.consumer,
      env: envWithShim(fixture),
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /usage: npm-release-flow/);
  } finally {
    fixture.cleanup();
  }
});

test("bin: prepare without --version exits 1 with usage", () => {
  const fixture = createFixtureRepo({ remote: false });
  try {
    const result = runBin(["prepare"], {
      cwd: fixture.consumer,
      env: envWithShim(fixture),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--version X\.Y\.Z is required for prepare/);
  } finally {
    fixture.cleanup();
  }
});

test("bin: check exits 0 in a fully configured fixture", () => {
  const { fixture, env } = goodCheckFixture();
  try {
    const result = runBin(["check"], { cwd: fixture.consumer, env });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /All release prerequisites pass\./);
  } finally {
    fixture.cleanup();
  }
});

test("bin: check exits 1 listing problems in a broken fixture", () => {
  const fixture = createFixtureRepo({ remote: false });
  try {
    const signing = createSigningHome(fixture.base);
    const env = {
      ...envWithShim(fixture),
      GNUPGHOME: signing.home,
      NPM_RELEASE_FLOW_GPG_FINGERPRINT: signing.fingerprint,
    };
    const result = runBin(["check"], { cwd: fixture.consumer, env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Checked:/);
    assert.match(result.stderr, /Found \d+ problem\(s\)\./);
  } finally {
    fixture.cleanup();
  }
});

test("bin: prepare dry-run prints the plan and exits 0", () => {
  const { fixture, env } = prepareFixture();
  try {
    const result = runBin(["prepare", "--version", "1.2.3"], {
      cwd: fixture.consumer,
      env,
    });
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /\[dry-run\] Would cut the changelog for 1\.2\.3/,
    );
    assert.match(result.stdout, /Signing preflight: commit-signing key/);
  } finally {
    fixture.cleanup();
  }
});

test("bin: exit code 2 is plumbed for an already-prepared release", () => {
  const { fixture, env } = prepareFixture();
  try {
    setGhPrs(fixture, "release/v1.2.3", [
      {
        number: 7,
        state: "OPEN",
        url: "https://github.com/example/fixture-consumer/pull/7",
      },
    ]);
    const result = runBin(["prepare", "--version", "1.2.3"], {
      cwd: fixture.consumer,
      env,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /an open release PR already exists/);
  } finally {
    fixture.cleanup();
  }
});

test("bin: main() programmatic entry returns the exit code", async () => {
  const fixture = createFixtureRepo({ remote: false });
  try {
    const lines = [];
    const code = await main(["check"], {
      cwd: fixture.consumer,
      env: envWithShim(fixture),
      log: (line) => lines.push(line),
    });
    assert.equal(code, ExitCode.ERROR);
    assert.ok(lines.length > 0, "problems were logged through the sink");
  } finally {
    fixture.cleanup();
  }
});
