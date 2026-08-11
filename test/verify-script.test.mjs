/**
 * Regression test for the verify script entry point: the release
 * workflow invokes `node .npm-release-flow/src/verify.mjs` directly.
 * The artifact is produced only when the script actually runs, so this
 * test spawns the script as a child process (like the workflow) with a
 * realistic fixture environment and asserts the exit code and the pack
 * artifact, not just the imported function.
 *
 * Covers the failure where `process.exitCode` set inside a Promise
 * `.then` could still exit 0 and leave `.npm-release-flow-pack/` missing,
 * which made the runner report the step as success while the upload step
 * failed with `No files were found`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { sha256OfFile } from "../src/lib/pack-contract.mjs";
import {
  createFixtureRepo,
  addKitDevDependency,
  envWithShim,
} from "./helpers/fixture.mjs";

const root = resolve(import.meta.dirname, "..");

test("verify invoked as node src/verify.mjs with valid env creates pack artifact and exits 0", () => {
  const fixture = createFixtureRepo();
  const outputFile = join(fixture.base, "verify-output.txt");
  writeFileSync(outputFile, "", "utf8");

  // Normal consumer: installed kit version must equal checkout version.
  const KIT_VERSION = "1.0.0";
  const env = {
    ...envWithShim(fixture),
    VERSION: "1.2.2",
    CALLER_REPOSITORY: "acme/consumer-app",
    GH_TOKEN: "fixture-token",
    GITHUB_OUTPUT: outputFile,
  };

  try {
    addKitDevDependency(fixture, { version: KIT_VERSION, env });

    const result = spawnSync(
      process.execPath,
      [resolve(root, "src/verify.mjs")],
      {
        cwd: fixture.consumer,
        env,
        encoding: "utf8",
      },
    );

    assert.equal(
      result.status,
      0,
      `verify.mjs must exit 0 with valid env, stderr: ${result.stderr}`,
    );

    const packDir = join(fixture.consumer, ".npm-release-flow-pack");
    const files = readdirSync(packDir).sort();
    assert.deepEqual(files, ["fixture-consumer-1.2.2.tgz", "pack.json"]);

    const shaLine = readFileSync(outputFile, "utf8").trim();
    assert.match(shaLine, /^package-sha256=[0-9a-f]{64}$/);
    const sha = shaLine.split("=")[1];
    assert.equal(
      sha,
      sha256OfFile(join(packDir, "fixture-consumer-1.2.2.tgz")),
    );
  } finally {
    fixture.cleanup();
  }
});
