import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { revalidate } from "../src/revalidate.mjs";
import { git } from "../src/lib/repo-state.mjs";
import {
  createFixtureRepo,
  createReleaseMerge,
  envWithShim,
  readConsumerFile,
} from "./helpers/fixture.mjs";

function revalidateFixture() {
  const fixture = createFixtureRepo();
  const env = { ...envWithShim(fixture), GH_TOKEN: "fixture-token" };
  return { fixture, env };
}

test("revalidate passes for a valid release merge", async () => {
  const { fixture, env } = revalidateFixture();
  try {
    const mergeSha = createReleaseMerge(
      fixture,
      { version: "1.2.3", prNumber: 12 },
      env,
    );
    const code = await revalidate({
      cwd: fixture.consumer,
      env: { ...env, GITHUB_SHA: mergeSha },
      log: () => {},
    });
    assert.equal(code, 0);
  } finally {
    fixture.cleanup();
  }
});

test("revalidate passes when only non-control files changed after the merge", async () => {
  const { fixture, env } = revalidateFixture();
  try {
    const mergeSha = createReleaseMerge(
      fixture,
      { version: "1.2.3", prNumber: 12 },
      env,
    );
    writeFileSync(join(fixture.consumer, "README.md"), "# follow-up\n");
    git(["add", "."], { cwd: fixture.consumer, env });
    git(["commit", "-m", "ordinary follow-up"], { cwd: fixture.consumer, env });
    git(["push", "origin", "main"], { cwd: fixture.consumer, env });
    const code = await revalidate({
      cwd: fixture.consumer,
      env: { ...env, GITHUB_SHA: mergeSha },
      log: () => {},
    });
    assert.equal(code, 0);
  } finally {
    fixture.cleanup();
  }
});

test("revalidate fails when a control file changed after the merge", async () => {
  const { fixture, env } = revalidateFixture();
  try {
    const mergeSha = createReleaseMerge(
      fixture,
      { version: "1.2.3", prNumber: 12 },
      env,
    );
    const pkg = JSON.parse(readConsumerFile(fixture, "package.json"));
    pkg.description = "tampered";
    writeFileSync(
      join(fixture.consumer, "package.json"),
      JSON.stringify(pkg, null, 2) + "\n",
    );
    git(["add", "."], { cwd: fixture.consumer, env });
    git(["commit", "-m", "tamper"], { cwd: fixture.consumer, env });
    git(["push", "origin", "main"], { cwd: fixture.consumer, env });
    const problems = [];
    const code = await revalidate({
      cwd: fixture.consumer,
      env: { ...env, GITHUB_SHA: mergeSha },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: that the three control files at origin\/main still equal the triggering commit/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("revalidate fails when the triggering SHA is not reachable from origin/main", async () => {
  const { fixture, env } = revalidateFixture();
  try {
    // A commit on a side branch that is never merged: not reachable.
    git(["checkout", "-b", "side"], { cwd: fixture.consumer, env });
    writeFileSync(join(fixture.consumer, "README.md"), "# side work\n");
    git(["add", "."], { cwd: fixture.consumer, env });
    git(["commit", "-m", "side commit"], { cwd: fixture.consumer, env });
    const sideSha = git(["rev-parse", "HEAD"], {
      cwd: fixture.consumer,
    }).stdout.trim();
    const problems = [];
    const code = await revalidate({
      cwd: fixture.consumer,
      env: { ...env, GITHUB_SHA: sideSha },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: that the triggering commit is still reachable from origin\/main\./,
    );
  } finally {
    fixture.cleanup();
  }
});

test("revalidate fails on a missing GITHUB_SHA", async () => {
  const { fixture, env } = revalidateFixture();
  try {
    const problems = [];
    // Hermetic: a CI host exports GITHUB_SHA, which the fixture would
    // otherwise inherit and turn this into a different failure path.
    const missingShaEnv = { ...env };
    delete missingShaEnv.GITHUB_SHA;
    const code = await revalidate({
      cwd: fixture.consumer,
      env: missingShaEnv,
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(problems.join("\n"), /Checked: GITHUB_SHA\./);
  } finally {
    fixture.cleanup();
  }
});
