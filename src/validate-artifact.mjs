/**
 * Artifact validation script: consumes the download directory and
 * fails unless it contains exactly the expected tarball and `pack.json`, the
 * tarball's sha256 equals the verify job's `package-sha256` output, the
 * pack.json contract holds (name/version match the tarball's manifest,
 * integrity matches the bytes), and declared bin entries resolve. Writes
 * `PACKAGE_TARBALL` to `$GITHUB_ENV` for the release step.
 */

import {
  appendFileSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { commandFailureDetail, describeFailure } from "./lib/errors.mjs";
import { runSync, tarPath } from "./lib/spawn.mjs";
import { runAsScript } from "./lib/run-script.mjs";
import {
  integrityOfFile,
  sha256OfFile,
  binEntryProblems,
} from "./lib/pack-contract.mjs";

/**
 * @typedef {object} ValidateArtifactOptions
 * @property {string} [cwd] Repository root (the consumer workspace).
 * @property {NodeJS.ProcessEnv} [env] Environment (PACKAGE_SHA256,
 *   ARTIFACT_DIR, GITHUB_ENV).
 * @property {(line: string) => void} [log] Output sink.
 */

/**
 * @param {string} line
 * @returns {void}
 */
function consoleError(line) {
  console.error(line);
}

/**
 * Run the artifact validation script.
 *
 * @param {ValidateArtifactOptions} [options]
 * @returns {Promise<number>} 0 when the artifact is valid, 1 otherwise.
 */
export async function validateArtifact(options = {}) {
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

  const expectedSha256 = env.PACKAGE_SHA256 ?? "";
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    return fail(
      describeFailure({
        checked: "PACKAGE_SHA256",
        found:
          expectedSha256 === ""
            ? "the environment variable is not set"
            : `${JSON.stringify(expectedSha256)} is not a 64-character hex digest`,
        correction:
          "wire PACKAGE_SHA256 from the verify job's package-sha256 output",
      }),
    );
  }
  const artifactDir = env.ARTIFACT_DIR ?? "";
  if (artifactDir === "") {
    return fail(
      describeFailure({
        checked: "ARTIFACT_DIR",
        found: "the environment variable is not set",
        correction:
          "wire ARTIFACT_DIR from the download step's download-path output",
      }),
    );
  }

  let entries;
  try {
    entries = readdirSync(artifactDir).sort();
  } catch {
    return fail(
      describeFailure({
        checked: "the artifact download directory",
        found: `${artifactDir} could not be read`,
        correction: "download the artifact to a dedicated path first",
      }),
    );
  }
  const tarballs = entries.filter((name) => name.endsWith(".tgz"));
  const others = entries.filter(
    (name) => !name.endsWith(".tgz") && name !== "pack.json",
  );
  if (tarballs.length !== 1 || entries.length !== 2 || others.length > 0) {
    return fail(
      describeFailure({
        checked: "the artifact directory contents",
        found:
          entries.length === 0 ? "the directory is empty" : entries.join(", "),
        correction:
          "the artifact must contain exactly the uploaded tarball and pack.json",
      }),
    );
  }
  const tarball = tarballs[0];
  const tarballPath = join(artifactDir, tarball);

  const actualSha256 = sha256OfFile(tarballPath);
  if (actualSha256 !== expectedSha256) {
    return fail(
      describeFailure({
        checked: "that the downloaded tarball matches the verify job's sha256",
        found: `sha256 ${actualSha256.slice(0, 12)}... != expected ${expectedSha256.slice(0, 12)}...`,
        correction:
          "re-run the workflow; the artifact was not produced by this release",
      }),
    );
  }

  let report;
  try {
    report = JSON.parse(readFileSync(join(artifactDir, "pack.json"), "utf8"));
  } catch {
    return fail(
      describeFailure({
        checked: "pack.json",
        found: "pack.json is missing or not valid JSON",
        correction: "the verify job must upload pack.json with the tarball",
      }),
    );
  }
  const reportEntries = Array.isArray(report) ? report : Object.values(report);
  if (reportEntries.length !== 1) {
    return fail(
      describeFailure({
        checked: "the pack report entries",
        found: `${reportEntries.length} entries`,
        correction: "exactly one pack entry is expected",
      }),
    );
  }
  const entry = reportEntries[0];
  if (entry.filename !== tarball) {
    return fail(
      describeFailure({
        checked: "that the tarball matches the pack report",
        found: `report names ${JSON.stringify(entry.filename)}, directory has ${JSON.stringify(tarball)}`,
        correction: "re-run the workflow; the artifact set is inconsistent",
      }),
    );
  }
  const actualIntegrity = integrityOfFile(tarballPath);
  if (entry.integrity !== actualIntegrity) {
    return fail(
      describeFailure({
        checked: "that the pack report integrity matches the tarball bytes",
        found: `${entry.integrity} != ${actualIntegrity}`,
        correction: "re-run the workflow; the artifact is corrupt",
      }),
    );
  }

  // Name/version agreement with the tarball's own manifest, and bin entries.
  const extractDir = join(
    tmpdir(),
    `npmrf-artifact-${process.pid}-${Date.now()}`,
  );
  mkdirSync(extractDir, { recursive: true });
  try {
    // win32 tar is either the Git-bundled GNU tar (MSYS form) or the native
    // bsdtar (native form); tarPath picks the form the resolved tar reads.
    runSync("tar", ["-xzf", tarPath(tarballPath), "-C", tarPath(extractDir)], {
      cwd,
      env,
    });
    const manifest = JSON.parse(
      readFileSync(join(extractDir, "package", "package.json"), "utf8"),
    );
    if (manifest.name !== entry.name || manifest.version !== entry.version) {
      return fail(
        describeFailure({
          checked: "that the tarball manifest matches the pack report",
          found: `${manifest.name}@${manifest.version} != ${entry.name}@${entry.version}`,
          correction: "re-run the workflow; the artifact set is inconsistent",
        }),
      );
    }
    const binProblems = binEntryProblems(manifest, join(extractDir, "package"));
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
    const detail = commandFailureDetail(err);
    return fail(
      describeFailure({
        checked: "the packed tarball contents",
        found: detail || "extraction or manifest read failed",
        correction: "inspect the artifact contents",
      }),
    );
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }

  // Hand the verified tarball path to the release step.
  const githubEnv = env.GITHUB_ENV;
  const line = `PACKAGE_TARBALL=${tarballPath}\n`;
  if (githubEnv) {
    appendFileSync(githubEnv, line, "utf8");
  } else {
    process.stdout.write(line);
  }
  return 0;
}

runAsScript(import.meta.url, validateArtifact);
