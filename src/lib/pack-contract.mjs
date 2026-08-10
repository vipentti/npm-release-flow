/**
 * Pack contract: fully generic, no opt-out — exactly one
 * tarball, safe filename, name matches the manifest, version matches the
 * release version, integrity metadata matches the bytes. This is the
 * artifact-identity backbone of the sha256 handoff.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

/**
 * The sha512 integrity value (npm `integrity` format: `sha512-<base64>`) of a
 * file's bytes.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function integrityOfFile(filePath) {
  const hash = createHash("sha512");
  hash.update(readFileSync(filePath));
  return `sha512-${hash.digest("base64")}`;
}

/**
 * The sha256 hex digest of a file (the `package-sha256` handoff).
 *
 * @param {string} filePath
 * @returns {string}
 */
export function sha256OfFile(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

/**
 * @typedef {object} PackEntry The npm pack --json report entry for a package.
 * @property {string} filename The tarball file name in the pack directory.
 * @property {string} name The package name from the manifest.
 * @property {string} version The packed version from the manifest.
 * @property {string} integrity The integrity checksum reported by npm pack.
 * @property {Array<{ path: string, size: number, mode: number }>} [files] The
 *   entries inside the tarball, when the report includes them.
 */

/**
 * Validate the pack contract for the tarballs in a pack directory against
 * the pack report, the manifest, and the release version.
 *
 * @param {{ packDir: string, report: PackEntry[], manifest: Record<string, any>, version: string }} input
 * @returns {string[]} Problems (empty when the contract holds).
 */
export function packContractProblems({ packDir, report, manifest, version }) {
  const problems = [];
  const tarballs = readdirSync(packDir)
    .filter((name) => name.endsWith(".tgz"))
    .sort();
  if (tarballs.length !== 1) {
    problems.push(
      `the pack directory must contain exactly one tarball; found ${tarballs.length}`,
    );
    return problems;
  }
  const filename = tarballs[0];
  if (
    basename(filename) !== filename ||
    filename.includes(sep) ||
    filename.startsWith(".")
  ) {
    problems.push(
      `the tarball filename ${JSON.stringify(filename)} is not safe`,
    );
  }
  if (report.length !== 1) {
    problems.push(
      `the pack report must contain exactly one entry; found ${report.length}`,
    );
    return problems;
  }
  const entry = report[0];
  if (entry.name !== manifest.name) {
    problems.push(
      `the packed name ${JSON.stringify(entry.name)} does not match the manifest name ${JSON.stringify(manifest.name)}`,
    );
  }
  if (entry.version !== version) {
    problems.push(
      `the packed version ${JSON.stringify(entry.version)} does not match the release version ${JSON.stringify(version)}`,
    );
  }
  const tarballPath = join(packDir, filename);
  const actualIntegrity = integrityOfFile(tarballPath);
  if (entry.integrity !== actualIntegrity) {
    problems.push(
      `the pack report integrity ${entry.integrity} does not match the tarball bytes (${actualIntegrity})`,
    );
  }
  return problems;
}

/**
 * Bin-entry checks: each declared binary exists in the tarball,
 * non-empty, with a shebang.
 *
 * @param {Record<string, any>} manifest
 * @param {string} extractedDir The extracted tarball.
 * @returns {string[]} Problems (empty when all declared binaries pass).
 */
export function binEntryProblems(manifest, extractedDir) {
  /** @type {string[]} */
  const problems = [];
  const bin = manifest.bin;
  if (bin === undefined || bin === null) return problems;
  const entries =
    typeof bin === "string"
      ? [[basename(manifest.name ?? "package"), bin]]
      : Object.entries(/** @type {Record<string, string>} */ (bin));
  for (const [binName, target] of entries) {
    const filePath = join(extractedDir, target);
    try {
      const info = statSync(filePath);
      if (info.size === 0) {
        problems.push(
          `the declared bin ${JSON.stringify(binName)} is empty in the tarball`,
        );
      }
    } catch {
      problems.push(
        `the declared bin ${JSON.stringify(binName)} (${target}) does not exist in the tarball`,
      );
      continue;
    }
    const head = readFileSync(filePath, "utf8");
    if (!head.startsWith("#!")) {
      problems.push(
        `the declared bin ${JSON.stringify(binName)} has no shebang`,
      );
    }
  }
  return problems;
}
