import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { validateArtifact } from "../src/validate-artifact.mjs";
import { sha256OfFile } from "../src/lib/pack-contract.mjs";
import { runSync } from "../src/lib/spawn.mjs";
import { createFixtureRepo, envWithShim } from "./helpers/fixture.mjs";

/**
 * Produce a real artifact directory (tarball + pack.json) for a fixture
 * consumer, mirroring what the verify job uploads.
 * @param fixture
 * @param env
 */
function produceArtifact(fixture, env) {
  const packDir = join(fixture.base, "produced-pack");
  mkdirSync(packDir, { recursive: true });
  const result = runSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
    { cwd: fixture.consumer, env },
  );
  const report = JSON.parse(result.stdout);
  const entries = Array.isArray(report) ? report : Object.values(report);
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  const tarball = entries[0].filename;
  const artifactDir = join(fixture.base, "artifact");
  mkdirSync(artifactDir, { recursive: true });
  copyFileSync(join(packDir, tarball), join(artifactDir, tarball));
  copyFileSync(join(packDir, "pack.json"), join(artifactDir, "pack.json"));
  return { artifactDir, tarball };
}

function artifactFixture() {
  // validateArtifact never touches the git remote, so skip the bare remote.
  const fixture = createFixtureRepo({ remote: false });
  const githubEnv = join(fixture.base, "github-env.txt");
  writeFileSync(githubEnv, "", "utf8");
  const env = { ...envWithShim(fixture), GITHUB_ENV: githubEnv };
  const produced = produceArtifact(fixture, env);
  return {
    fixture,
    env,
    githubEnv,
    artifactDir: produced.artifactDir,
    tarball: produced.tarball,
  };
}

function runValidate(ctx, overrides = {}) {
  return validateArtifact({
    cwd: ctx.fixture.consumer,
    env: {
      ...ctx.env,
      PACKAGE_SHA256: sha256OfFile(join(ctx.artifactDir, ctx.tarball)),
      ARTIFACT_DIR: ctx.artifactDir,
      ...overrides,
    },
    log: () => {},
  });
}

test("validate-artifact: passes for a real artifact and writes PACKAGE_TARBALL", async () => {
  const ctx = artifactFixture();
  try {
    const code = await runValidate(ctx);
    assert.equal(code, 0);
    const githubEnv = readFileSync(ctx.githubEnv, "utf8");
    assert.match(
      githubEnv,
      new RegExp(
        `^PACKAGE_TARBALL=${escapeRegExp(join(ctx.artifactDir, ctx.tarball))}$`,
        "m",
      ),
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("validate-artifact: fails on a sha256 mismatch", async () => {
  const ctx = artifactFixture();
  try {
    const problems = [];
    const code = await validateArtifact({
      cwd: ctx.fixture.consumer,
      env: {
        ...ctx.env,
        PACKAGE_SHA256: "0".repeat(64),
        ARTIFACT_DIR: ctx.artifactDir,
      },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: that the downloaded tarball matches the verify job's sha256\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("validate-artifact: fails on extra files in the artifact directory", async () => {
  const ctx = artifactFixture();
  try {
    writeFileSync(join(ctx.artifactDir, "extra.txt"), "unexpected");
    const problems = [];
    const code = await validateArtifact({
      cwd: ctx.fixture.consumer,
      env: {
        ...ctx.env,
        PACKAGE_SHA256: sha256OfFile(join(ctx.artifactDir, ctx.tarball)),
        ARTIFACT_DIR: ctx.artifactDir,
      },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the artifact directory contents\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("validate-artifact: fails on a corrupt tarball", async () => {
  const ctx = artifactFixture();
  try {
    const originalSha = sha256OfFile(join(ctx.artifactDir, ctx.tarball));
    // Corrupt the tarball bytes; sha256 diverges from the expected value.
    writeFileSync(join(ctx.artifactDir, ctx.tarball), "corrupt");
    const problems = [];
    const code = await validateArtifact({
      cwd: ctx.fixture.consumer,
      env: {
        ...ctx.env,
        PACKAGE_SHA256: originalSha,
        ARTIFACT_DIR: ctx.artifactDir,
      },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(problems.join("\n"), /sha256 .* != expected/);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("validate-artifact: fails on a missing PACKAGE_SHA256", async () => {
  const ctx = artifactFixture();
  try {
    const problems = [];
    const code = await validateArtifact({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, ARTIFACT_DIR: ctx.artifactDir },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(problems.join("\n"), /Checked: PACKAGE_SHA256\./);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("validate-artifact: fails when the pack report names a different tarball", async () => {
  const ctx = artifactFixture();
  try {
    const packPath = join(ctx.artifactDir, "pack.json");
    const report = JSON.parse(readFileSync(packPath, "utf8"));
    const entries = Array.isArray(report) ? report : Object.values(report);
    entries[0].filename = "other-1.2.2.tgz";
    writeFileSync(
      packPath,
      JSON.stringify(
        Array.isArray(report) ? entries : { entry: entries[0] },
        null,
        2,
      ) + "\n",
    );
    const problems = [];
    const code = await validateArtifact({
      cwd: ctx.fixture.consumer,
      env: {
        ...ctx.env,
        PACKAGE_SHA256: sha256OfFile(join(ctx.artifactDir, ctx.tarball)),
        ARTIFACT_DIR: ctx.artifactDir,
      },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: that the tarball matches the pack report\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
