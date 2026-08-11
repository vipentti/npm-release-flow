/**
 * Verify job script: runs the consumer's
 * verification and produces the sha256-handoff artifact. Env-driven:
 * `VERSION` (from detect), `CALLER_REPOSITORY` (self-host detection),
 * `GH_TOKEN` (npm/auth context). Executes consumer-controlled code (`npm ci`,
 * `npm run release:verify`) — this is the unprivileged job.
 *
 * Produces `.npm-release-flow-pack/`: exactly one tarball plus `pack.json`
 * (the exact `npm pack --json` report), validates the pack contract,
 * exercises the generic smoke test, enforces the pin agreement, and
 * writes `package-sha256` to `GITHUB_OUTPUT`.
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

import { describeFailure } from "./lib/errors.mjs";
import { msysPath, runSync } from "./lib/spawn.mjs";
import { CommandError } from "./lib/errors.mjs";
import { mandatoryPrerequisiteProblem } from "./lib/control-files.mjs";
import { parseStableVersion } from "./lib/versions.mjs";
import {
  packContractProblems,
  binEntryProblems,
  sha256OfFile,
} from "./lib/pack-contract.mjs";

const PACK_DIR = ".npm-release-flow-pack";
const KIT_PACKAGE = "@vipentti/npm-release-flow";

/**
 * @typedef {object} VerifyOptions
 * @property {string} [cwd] Repository root (the consumer tree).
 * @property {NodeJS.ProcessEnv} [env] Environment (VERSION,
 *   CALLER_REPOSITORY, GH_TOKEN, GITHUB_OUTPUT...).
 * @property {(line: string) => void} [log] Output sink (diagnostics).
 */

/**
 * @param {string} line
 * @returns {void}
 */
function consoleError(line) {
  console.error(line);
}

/**
 * The kit repository identity derived from the checkout's
 * `repository.url` (e.g. "vipentti/npm-release-flow"), or null.
 *
 * @param {Record<string, any>} manifest
 * @returns {string | null}
 */
export function kitRepository(manifest) {
  const url = manifest.repository?.url;
  if (typeof url !== "string") return null;
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  return match ? match[1] : null;
}

/**
 * The pin agreement: for a normal consumer, the installed kit
 * devDependency copy must equal the kit checkout's version. For the kit
 * itself (self-host), no self devDependency is required; pin agreement is
 * proven by the detect marker check.
 *
 * @param {string} cwd
 * @param {Record<string, any>} manifest
 * @param {string} callerRepository
 * @returns {string | null} The problem, or null when pins agree.
 */
function skewProblem(cwd, manifest, callerRepository) {
  const selfHost = kitRepository(manifest) === callerRepository;
  if (selfHost) {
    return null;
  }
  let checkoutVersion;
  try {
    const kitManifest = JSON.parse(
      readFileSync(resolve(cwd, ".npm-release-flow", "package.json"), "utf8"),
    );
    checkoutVersion =
      typeof kitManifest.version === "string" ? kitManifest.version : null;
  } catch {
    checkoutVersion = null;
  }
  if (checkoutVersion === null) {
    return describeFailure({
      checked: "the kit checkout version at .npm-release-flow/package.json",
      found: "the kit package.json is missing or has no version",
      correction:
        "check out the kit at the pinned workflow SHA into .npm-release-flow",
    });
  }
  let installedVersion;
  try {
    const installed = JSON.parse(
      readFileSync(
        resolve(cwd, "node_modules", KIT_PACKAGE, "package.json"),
        "utf8",
      ),
    );
    installedVersion =
      typeof installed.version === "string" ? installed.version : null;
  } catch {
    installedVersion = null;
  }
  if (installedVersion === null) {
    return describeFailure({
      checked: `the installed ${KIT_PACKAGE} devDependency`,
      found: "node_modules/@vipentti/npm-release-flow/package.json is missing",
      correction:
        "pin the kit as an exact devDependency so the installed copy matches the workflow checkout",
    });
  }
  if (installedVersion !== checkoutVersion) {
    return describeFailure({
      checked: "that the installed kit version equals the kit checkout version",
      found: `installed ${installedVersion}, checkout ${checkoutVersion}`,
      correction:
        "move both pins (CLI devDependency and workflow SHA) in a single upgrade PR",
    });
  }
  return null;
}

/**
 * Run the verify job script.
 *
 * @param {VerifyOptions} [options]
 * @returns {Promise<number>} 0 on success, 1 on failure.
 */
export async function verify(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.log ?? consoleError;

  /**
   * @param {string} message
   * @returns {number}
   */
  const fail = (message) => {
    log(message);
    return 1;
  };

  const version = env.VERSION ?? "";
  if (parseStableVersion(version) === null) {
    return fail(
      describeFailure({
        checked: "VERSION",
        found:
          version === ""
            ? "the environment variable is not set"
            : `${JSON.stringify(version)} is not a stable X.Y.Z version`,
        correction: "wire VERSION from the detect job's version output",
      }),
    );
  }

  // Defensive re-validation of the mandatory consumer checks (enforcement
  // lives in the detect job).
  const prerequisite = mandatoryPrerequisiteProblem({ cwd, env });
  if (prerequisite !== null) {
    return fail(prerequisite);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
  } catch (err) {
    return fail(
      describeFailure({
        checked: "package.json",
        found:
          err instanceof Error && "code" in err && err.code === "ENOENT"
            ? "package.json is missing"
            : "package.json is not valid JSON",
        correction: "commit a readable package.json",
      }),
    );
  }
  if (manifest.version !== version) {
    return fail(
      describeFailure({
        checked: "that the manifest version equals the release version",
        found: `package.json.version is ${JSON.stringify(manifest.version)}, expected ${JSON.stringify(version)}`,
        correction: "the release merge must carry the released version",
      }),
    );
  }

  // --- Consumer-controlled verification ---

  try {
    runSync("npm", ["ci"], { cwd, env });
  } catch (err) {
    const detail =
      err instanceof CommandError ? err.stderr.trim() : String(err);
    return fail(
      describeFailure({
        checked: "npm ci",
        found: detail || "npm ci failed",
        correction: "fix the consumer's dependency state",
      }),
    );
  }
  try {
    runSync("npm", ["run", "release:verify"], { cwd, env });
  } catch (err) {
    const detail =
      err instanceof CommandError ? err.stderr.trim() : String(err);
    return fail(
      describeFailure({
        checked: "npm run release:verify",
        found: detail || "the release:verify script failed",
        correction: "fix the consumer's release verification",
      }),
    );
  }
  if (
    typeof manifest.scripts?.build === "string" &&
    manifest.scripts.build !== ""
  ) {
    try {
      runSync("npm", ["run", "build"], { cwd, env });
    } catch (err) {
      const detail =
        err instanceof CommandError ? err.stderr.trim() : String(err);
      return fail(
        describeFailure({
          checked: "npm run build (build-if-declared)",
          found: detail || "the build script failed",
          correction: "fix the consumer's build",
        }),
      );
    }
  }

  // --- Pack into the dedicated directory and persist the exact report ---

  const packDir = resolve(cwd, PACK_DIR);
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(packDir, { recursive: true });

  let report;
  let reportEntries;
  try {
    const result = runSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
      { cwd, env },
    );
    report = JSON.parse(result.stdout);
    // npm 11+ reports an object keyed by package name; older npm reports an
    // array. Both are the exact report; normalize to entries for validation.
    reportEntries = Array.isArray(report) ? report : Object.values(report);
  } catch (err) {
    const detail =
      err instanceof CommandError ? err.stderr.trim() : String(err);
    return fail(
      describeFailure({
        checked: "npm pack --json --ignore-scripts",
        found: detail || "npm pack failed",
        correction: "fix the consumer's pack state",
      }),
    );
  }
  writeFileSync(
    join(packDir, "pack.json"),
    JSON.stringify(report, null, 2) + "\n",
    "utf8",
  );

  // --- Pack contract from the pack directory ---

  const contractProblems = packContractProblems({
    packDir,
    report: /** @type {import("./lib/pack-contract.mjs").PackEntry[]} */ (
      reportEntries
    ),
    manifest,
    version,
  });
  if (contractProblems.length > 0) {
    return fail(
      describeFailure({
        checked: "the pack contract",
        found: contractProblems.join("; "),
        correction:
          "the tarball must match the manifest, version, and its own report",
      }),
    );
  }
  const tarball = readdirSync(packDir).filter((name) =>
    name.endsWith(".tgz"),
  )[0];

  // --- Bin entries and generic smoke test from the packed tarball ---

  const extractDir = join(
    tmpdir(),
    `npmrf-verify-${process.pid}-${Date.now()}`,
  );
  mkdirSync(extractDir, { recursive: true });
  try {
    runSync(
      "tar",
      // The Git-bundled tar is an MSYS2 binary that misreads native Windows
      // paths as cwd-relative; hand it the MSYS form on win32 only.
      ["-xzf", msysPath(join(packDir, tarball)), "-C", msysPath(extractDir)],
      { cwd, env },
    );
    const packageDir = join(extractDir, "package");
    const binProblems = binEntryProblems(manifest, packageDir);
    if (binProblems.length > 0) {
      return fail(
        describeFailure({
          checked: "the declared bin entries in the tarball",
          found: binProblems.join("; "),
          correction:
            "declare only binaries that ship in the tarball with a shebang",
        }),
      );
    }
  } catch (err) {
    const detail =
      err instanceof CommandError ? err.stderr.trim() : String(err);
    return fail(
      describeFailure({
        checked: "extracting the packed tarball",
        found: detail || "tar extraction failed",
        correction: "inspect the pack output",
      }),
    );
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }

  const smokeDir = join(tmpdir(), `npmrf-smoke-${process.pid}-${Date.now()}`);
  mkdirSync(smokeDir, { recursive: true });
  writeFileSync(
    join(smokeDir, "package.json"),
    JSON.stringify(
      { name: "smoke-project", version: "0.0.0", private: true },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  try {
    // The fresh-project install is the native npm smoke test: npm itself
    // wires the declared .bin entries. The kit never executes a consumer
    // binary with invented arguments (e.g. --version); behavioral CLI smoke
    // tests belong to release:verify.
    runSync(
      "npm",
      ["i", join(packDir, tarball), "--ignore-scripts", "--omit=peer"],
      { cwd: smokeDir, env },
    );
  } catch (err) {
    const detail =
      err instanceof CommandError ? err.stderr.trim() : String(err);
    return fail(
      describeFailure({
        checked:
          "the generic smoke install (npm i <tgz> --ignore-scripts --omit=peer)",
        found: detail || "the smoke install failed",
        correction: "the tarball must install into a fresh project",
      }),
    );
  } finally {
    rmSync(smokeDir, { recursive: true, force: true });
  }

  // --- Pin agreement ---

  const callerRepository = env.CALLER_REPOSITORY ?? "";
  const skew = skewProblem(cwd, manifest, callerRepository);
  if (skew !== null) {
    return fail(skew);
  }

  // --- Output ---

  const packageSha256 = sha256OfFile(join(packDir, tarball));
  const outputPath = env.GITHUB_OUTPUT;
  const line = `package-sha256=${packageSha256}\n`;
  if (outputPath) {
    appendFileSync(outputPath, line, "utf8");
  } else {
    process.stdout.write(line);
  }
  return 0;
}
