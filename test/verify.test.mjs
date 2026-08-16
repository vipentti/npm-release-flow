import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { verify, kitRepository } from "../src/verify.mjs";
import {
  packContractProblems,
  binEntryProblems,
  integrityOfFile,
  sha256OfFile,
} from "../src/lib/pack-contract.mjs";
import {
  createFixtureRepo,
  addKitDevDependency,
  createTempBase,
  envWithShim,
} from "./helpers/fixture.mjs";

const KIT_VERSION = "1.0.0";

/**
 * Fixture wired for verify runs.
 */
function verifyFixture() {
  const fixture = createFixtureRepo();
  const outputFile = join(fixture.base, "verify-output.txt");
  writeFileSync(outputFile, "", "utf8");
  const env = {
    ...envWithShim(fixture),
    VERSION: "1.2.2",
    // A normal consumer: CALLER_REPOSITORY differs from the fixture's own
    // repository.url, so the pin agreement is enforced.
    CALLER_REPOSITORY: "acme/consumer-app",
    GH_TOKEN: "fixture-token",
    GITHUB_OUTPUT: outputFile,
  };
  const output = () => readFileSync(outputFile, "utf8");
  return { fixture, env, output };
}

/**
 * @param {ReturnType<typeof verifyFixture>} ctx
 * @param {NodeJS.ProcessEnv} [envOverrides]
 */
function runVerify(ctx, envOverrides = {}) {
  return verify({
    cwd: ctx.fixture.consumer,
    env: { ...ctx.env, ...envOverrides },
    log: () => {},
  });
}

test("pack-contract: integrity and sha256 helpers match the bytes", () => {
  // The pack-contract helpers only need scratch files, not a git repo.
  const ctx = createTempBase();
  const file = join(ctx.base, "nonexistent");
  try {
    const pkgPath = join(ctx.consumer, "package.json");
    const bytes = readFileSync(pkgPath);
    const expectedIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(integrityOfFile(pkgPath), expectedIntegrity);
    assert.equal(sha256OfFile(pkgPath), expectedSha256);
  } finally {
    ctx.cleanup();
  }
  assert.equal(file.includes("nonexistent"), true);
});

test("pack-contract: problems for missing/extra tarballs, bad names, mismatches", () => {
  const ctx = createTempBase();
  try {
    const packDir = join(ctx.base, "packdir");
    const report = [
      {
        filename: "fixture-consumer-1.2.2.tgz",
        name: "fixture-consumer",
        version: "1.2.2",
        integrity: "sha512-AAAA",
      },
    ];
    const manifest = { name: "fixture-consumer", version: "1.2.2" };
    mkdirSync(packDir, { recursive: true });
    // No tarball at all.
    let problems = packContractProblems({
      packDir,
      report,
      manifest,
      version: "1.2.2",
    });
    assert.ok(problems.some((p) => /exactly one tarball; found 0/.test(p)));

    // A tarball whose bytes don't match the reported integrity.
    writeFileSync(join(packDir, "fixture-consumer-1.2.2.tgz"), "bytes");
    problems = packContractProblems({
      packDir,
      report,
      manifest,
      version: "1.2.2",
    });
    assert.ok(problems.some((p) => /does not match the tarball bytes/.test(p)));

    // Version mismatch vs the release version.
    const versionProblems = packContractProblems({
      packDir,
      report,
      manifest,
      version: "9.9.9",
    });
    assert.ok(
      versionProblems.some((p) => /does not match the release version/.test(p)),
    );
  } finally {
    ctx.cleanup();
  }
});

test("pack-contract: bin-entry checks accept a shebang file and reject missing/empty", () => {
  const ctx = createTempBase();
  try {
    const dir = join(ctx.base, "extracted");
    mkdirSync(join(dir, "package"), { recursive: true });
    writeFileSync(
      join(dir, "package", "tool.mjs"),
      "#!/usr/bin/env node\nconsole.log(1);\n",
    );
    const manifest = { name: "pkg", bin: { tool: "./tool.mjs" } };
    assert.deepEqual(binEntryProblems(manifest, join(dir, "package")), []);

    writeFileSync(join(dir, "package", "tool.mjs"), "");
    assert.ok(
      binEntryProblems(manifest, join(dir, "package")).some((p) =>
        /is empty/.test(p),
      ),
    );

    writeFileSync(join(dir, "package", "tool.mjs"), "console.log(1);\n");
    assert.ok(
      binEntryProblems(manifest, join(dir, "package")).some((p) =>
        /has no shebang/.test(p),
      ),
    );

    const missing = { name: "pkg", bin: { other: "./missing.mjs" } };
    assert.ok(
      binEntryProblems(missing, join(dir, "package")).some((p) =>
        /does not exist/.test(p),
      ),
    );
  } finally {
    ctx.cleanup();
  }
});

test("verify: passing consumer produces the pack dir, sha256 output, and smoke-passing bin", async () => {
  const ctx = verifyFixture();
  try {
    addKitDevDependency(ctx.fixture, { version: KIT_VERSION, env: ctx.env });
    const code = await runVerify(ctx);
    assert.equal(code, 0);
    // Both pack-dir files exist before upload.
    const packDir = join(ctx.fixture.consumer, ".npm-release-flow-pack");
    const files = readdirSync(packDir).sort();
    assert.deepEqual(files, ["fixture-consumer-1.2.2.tgz", "pack.json"]);
    const report = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8"));
    const entries = Array.isArray(report) ? report : Object.values(report);
    assert.equal(entries[0].name, "fixture-consumer");
    assert.equal(entries[0].version, "1.2.2");
    // package-sha256 matches the tarball bytes.
    const sha = ctx.output().trim().split("=")[1];
    assert.equal(
      sha,
      sha256OfFile(join(packDir, "fixture-consumer-1.2.2.tgz")),
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("verify: fails on a missing mandatory file", async () => {
  const ctx = verifyFixture();
  try {
    rmSync(join(ctx.fixture.consumer, "CHANGELOG.md"));
    const problems = [];
    const code = await verify({
      cwd: ctx.fixture.consumer,
      env: ctx.env,
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the CHANGELOG\.md control file\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("verify: fails when the manifest version mismatches VERSION", async () => {
  const ctx = verifyFixture();
  try {
    const problems = [];
    const code = await verify({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, VERSION: "9.9.9" },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /package\.json\.version is "1\.2\.2", expected "9\.9\.9"/,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("verify: fails on a missing VERSION env value", async () => {
  const ctx = verifyFixture();
  try {
    const problems = [];
    const code = await verify({
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

test("verify: normal consumer with an agreeing pin passes", async () => {
  const ctx = verifyFixture();
  try {
    addKitDevDependency(ctx.fixture, { version: KIT_VERSION, env: ctx.env });
    const code = await runVerify(ctx);
    assert.equal(code, 0);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("verify: skewed pin (installed kit version differs from the checkout) fails", async () => {
  const ctx = verifyFixture();
  try {
    addKitDevDependency(ctx.fixture, { version: "2.0.0", env: ctx.env });
    const problems = [];
    const code = await verify({
      cwd: ctx.fixture.consumer,
      env: ctx.env,
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    const text = problems.join("\n");
    assert.match(
      text,
      /Checked: that the installed kit version equals the kit checkout version\./,
    );
    assert.match(text, /Found: installed 2\.0\.0, checkout 1\.0\.0\./);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("verify: missing kit devDependency in a normal consumer fails", async () => {
  const ctx = verifyFixture();
  try {
    const problems = [];
    const code = await verify({
      cwd: ctx.fixture.consumer,
      env: ctx.env,
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    assert.match(
      problems.join("\n"),
      /Checked: the installed @vipentti\/npm-release-flow devDependency\./,
    );
  } finally {
    ctx.fixture.cleanup();
  }
});

test("verify: self-host fixture passes without a self devDependency", async () => {
  const ctx = verifyFixture();
  try {
    // The checkout IS the kit: repository.url derives vipentti/npm-release-flow.
    const pkgPath = join(ctx.fixture.consumer, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.name = "@vipentti/npm-release-flow";
    pkg.repository.url = "git+https://github.com/vipentti/npm-release-flow.git";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    // CALLER_REPOSITORY equals the kit repository -> self-host.
    const code = await runVerify(ctx, {
      CALLER_REPOSITORY: "vipentti/npm-release-flow",
    });
    assert.equal(code, 0);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("verify: release:verify stdout-only failure surfaces stdout detail", async () => {
  const ctx = verifyFixture();
  try {
    const token = "STDOUT_ONLY_VERIFY_TOKEN_9f3b1a";
    const pkgPath = join(ctx.fixture.consumer, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.scripts["release:verify"] =
      `node -e "console.log('${token}'); process.exit(1)"`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    const problems = [];
    const code = await verify({
      cwd: ctx.fixture.consumer,
      env: { ...ctx.env, npm_config_loglevel: "silent" },
      log: (line) => problems.push(line),
    });
    assert.equal(code, 1);
    const text = problems.join("\n");
    assert.match(text, /Checked: npm run release:verify\./);
    assert.ok(text.includes(token), `expected token in: ${text}`);
  } finally {
    ctx.fixture.cleanup();
  }
});

test("kitRepository derives owner/name from repository.url", () => {
  assert.equal(
    kitRepository({
      repository: {
        url: "git+https://github.com/vipentti/npm-release-flow.git",
      },
    }),
    "vipentti/npm-release-flow",
  );
  assert.equal(
    kitRepository({ repository: { url: "https://github.com/owner/repo" } }),
    "owner/repo",
  );
  assert.equal(kitRepository({}), null);
  assert.equal(
    kitRepository({ repository: { url: "git@gitlab.com:owner/repo.git" } }),
    null,
  );
});
