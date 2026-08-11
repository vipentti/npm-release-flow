/**
 * Regression test for the workflow script entry points: the release
 * workflow invokes `node .npm-release-flow/src/<name>.mjs` directly, so
 * every script it invokes must actually run when executed. The workflow
 * file is the single inventory: scripts are derived from it, spawned with
 * a minimal environment, and must fail closed (exit 1 with the kit's
 * `Checked:` diagnostic) instead of silently exiting 0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");

test("bin invoked through a symlink still runs as a script", () => {
  const dir = mkdtempSync(join(tmpdir(), "npmrf-symlink-"));
  try {
    const binPath = resolve(root, "bin/npm-release-flow.mjs");
    const linkPath = join(dir, "npm-release-flow-link.mjs");
    try {
      symlinkSync(binPath, linkPath, "file");
    } catch {
      // Symlink creation can fail on Windows without developer mode;
      // the regression is POSIX-specific (node_modules/.bin symlinks).
      return;
    }
    const help = spawnSync(process.execPath, [linkPath, "--help"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    assert.equal(
      help.status,
      0,
      "symlink-invoked bin must exit 0 for --help (entry point missing?)",
    );
    assert.match(
      help.stdout,
      /usage: npm-release-flow/,
      "symlink-invoked bin must print usage",
    );
    const noArgs = spawnSync(process.execPath, [linkPath], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    assert.equal(
      noArgs.status,
      1,
      "symlink-invoked bin must exit 1 for missing subcommand",
    );
    assert.match(
      noArgs.stderr,
      /missing subcommand/,
      "symlink-invoked bin must report the diagnostic",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every script invoked by the workflow runs standalone and fails closed", () => {
  const workflow = readFileSync(
    resolve(root, ".github/workflows/release.yml"),
    "utf8",
  );
  const invoked = [
    ...new Set(
      [
        ...workflow.matchAll(/node \.npm-release-flow\/src\/([a-z-]+\.mjs)/g),
      ].map((match) => match[1]),
    ),
  ];
  assert.ok(
    invoked.length >= 5,
    "the workflow must invoke the workflow scripts",
  );
  for (const script of invoked) {
    const result = spawnSync(process.execPath, [resolve(root, "src", script)], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      1,
      `src/${script} must exit 1 when run without env (entry point missing?)`,
    );
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /Checked:/,
      `src/${script} must report a fail-closed diagnostic`,
    );
  }
});
