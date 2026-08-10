/**
 * Release control files: the fixed three-file release-diff allowlist and the
 * manifest/lockfile identity checks (blueprint §4, §9).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { git } from "./repo-state.mjs";
import { CommandError, describeFailure } from "./errors.mjs";
import { hasUnreleasedSection } from "./changelog.mjs";

/**
 * @typedef {Object} ControlCtx
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} [env]
 */

/**
 * The release-diff allowlist, fixed at exactly these three files
 * (blueprint §4: "Release-diff allowlist, fixed at exactly three files").
 * Kept sorted for diff comparison.
 * @type {readonly string[]}
 */
export const RELEASE_FILES = Object.freeze([
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
]);

/**
 * Whether the changed-file set is exactly the three control files.
 *
 * @param {string[]} changedFiles Changed paths (any order); duplicates and
 *   extra or missing files make this false.
 * @returns {boolean}
 */
export function isReleaseDiff(changedFiles) {
  const sorted = [...changedFiles].sort();
  const expected = [...RELEASE_FILES].sort();
  return (
    sorted.length === expected.length &&
    sorted.every((file, i) => file === expected[i])
  );
}

/**
 * Lockfile version-field mismatch, or null when the lockfile records
 * `version` in both the root and `packages[""]`.
 *
 * @param {Record<string, any>} lock
 * @param {string} version
 * @returns {string | null}
 */
export function lockfileVersionMismatch(lock, version) {
  if (lock.version !== version) {
    return `package-lock.json.version is ${JSON.stringify(lock.version)}, expected ${JSON.stringify(version)}`;
  }
  const rootEntry = lock.packages?.[""];
  if (!rootEntry || typeof rootEntry !== "object") {
    return 'package-lock.json.packages[""] is missing or not an object';
  }
  if (rootEntry.version !== version) {
    return `package-lock.json.packages[""].version is ${JSON.stringify(rootEntry.version)}, expected ${JSON.stringify(version)}`;
  }
  return null;
}

/**
 * Package-identity mismatch across package.json and package-lock.json (name
 * in the manifest, the lockfile root, and the lockfile `packages[""]` entry
 * must all agree), or null when identical.
 *
 * @param {Record<string, any>} pkg
 * @param {Record<string, any>} lock
 * @returns {string | null}
 */
export function packageIdentityMismatch(pkg, lock) {
  const lockRoot = lock.packages?.[""];
  const lockRootName =
    lockRoot && typeof lockRoot === "object" ? lockRoot.name : undefined;
  const names = [
    { source: "package.json", value: pkg.name },
    { source: "package-lock.json", value: lock.name },
    { source: 'package-lock.json packages[""]', value: lockRootName },
  ];
  const invalid = names.filter(
    (entry) => typeof entry.value !== "string" || entry.value === "",
  );
  if (invalid.length > 0) {
    return `${invalid
      .map((entry) => `${entry.source}.name is ${JSON.stringify(entry.value)}`)
      .join("; ")}; package name must be a non-empty string`;
  }
  const first = names[0].value;
  for (const entry of names.slice(1)) {
    if (entry.value !== first) {
      return `${entry.source}.name is ${JSON.stringify(entry.value)}, but package.json.name is ${JSON.stringify(first)}`;
    }
  }
  return null;
}

/**
 * Keys that changed beyond the excluded keys when comparing two parsed JSON
 * objects. Version fields are normalized back to their previous values before
 * deep comparison, so formatting and property order are not part of the
 * contract (the CLI serializes parsed JSON).
 *
 * @param {Record<string, any>} beforeObj
 * @param {Record<string, any>} afterObj
 * @param {readonly string[]} excludedKeys
 * @returns {string[]}
 */
function changedKeysBeyond(beforeObj, afterObj, excludedKeys) {
  const normalized = structuredClone(afterObj);
  const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  const changed = [];
  for (const key of keys) {
    if (excludedKeys.includes(key)) continue;
    if (
      !Object.hasOwn(beforeObj, key) ||
      !Object.hasOwn(afterObj, key) ||
      !isDeepStrictEqual(normalized[key], beforeObj[key])
    ) {
      changed.push(key);
    }
  }
  return changed;
}

/**
 * package.json keys changed beyond the permitted `version` field.
 *
 * @param {Record<string, any>} beforePkg
 * @param {Record<string, any>} afterPkg
 * @returns {string[]}
 */
export function packageChangesBeyondVersion(beforePkg, afterPkg) {
  const normalized = structuredClone(afterPkg);
  normalized.version = beforePkg.version;
  return changedKeysBeyond(beforePkg, normalized, ["version"]);
}

/**
 * package-lock.json keys changed beyond the permitted `version` fields
 * (root `version` and `packages[""].version`).
 *
 * @param {Record<string, any>} beforeLock
 * @param {Record<string, any>} afterLock
 * @returns {string[]}
 */
export function lockfileChangesBeyondVersion(beforeLock, afterLock) {
  const normalized = structuredClone(afterLock);
  normalized.version = beforeLock.version;
  if (normalized.packages?.[""] && beforeLock.packages?.[""]) {
    normalized.packages[""].version = beforeLock.packages[""].version;
  }
  return changedKeysBeyond(beforeLock, normalized, ["version"]);
}

/**
 * @param {string} cwd
 * @param {string} name
 * @returns {string | null}
 */
function tryReadFile(cwd, name) {
  try {
    return readFileSync(resolve(cwd, name), "utf8");
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd
 * @param {string} name
 * @returns {Record<string, any> | null}
 */
function tryReadJson(cwd, name) {
  const text = tryReadFile(cwd, name);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Validate the §4 mandatory consumer prerequisites (CHANGELOG.md with a
 * `## [Unreleased]` section, a `release:verify` script, a committed
 * lockfile). Missing prerequisites fail before any release verdict; the
 * detect job enforces them, the verify job re-validates defensively.
 *
 * @param {ControlCtx} ctx
 * @returns {string | null} The first problem, or null when all pass.
 */
export function mandatoryPrerequisiteProblem(ctx) {
  const { cwd, env } = ctx;
  const changelog = tryReadFile(cwd, "CHANGELOG.md");
  if (changelog === null) {
    return describeFailure({
      checked: "the CHANGELOG.md control file",
      found: "CHANGELOG.md is missing",
      correction: "add a CHANGELOG.md with a ## [Unreleased] section",
    });
  }
  if (!hasUnreleasedSection(changelog)) {
    return describeFailure({
      checked: "the ## [Unreleased] section in CHANGELOG.md",
      found:
        "the changelog has no bare ## [Unreleased] heading (or it has more than one)",
      correction: "declare exactly one ## [Unreleased] section",
    });
  }
  const pkg = tryReadJson(cwd, "package.json");
  const verifyScript =
    pkg !== null &&
    typeof pkg.scripts === "object" &&
    pkg.scripts !== null &&
    typeof pkg.scripts["release:verify"] === "string" &&
    pkg.scripts["release:verify"] !== "";
  if (!verifyScript) {
    return describeFailure({
      checked: "the release:verify script in package.json",
      found:
        pkg === null
          ? "package.json is missing or not valid JSON"
          : "no non-empty scripts.release:verify is declared",
      correction:
        "declare the consumer's release verification under scripts.release:verify",
    });
  }
  if (tryReadFile(cwd, "package-lock.json") === null) {
    return describeFailure({
      checked: "the package-lock.json lockfile",
      found: "package-lock.json is missing",
      correction: "generate and commit a lockfile",
    });
  }
  try {
    git(["ls-files", "--error-unmatch", "package-lock.json"], { cwd, env });
  } catch (err) {
    if (err instanceof CommandError && err.status === 1) {
      return describeFailure({
        checked: "that the lockfile is committed",
        found: "package-lock.json exists but is not tracked by git",
        correction: "git add package-lock.json and commit it",
      });
    }
    return describeFailure({
      checked: "that the lockfile is committed",
      found: "git ls-files failed",
      correction: "ensure the consumer tree is a git checkout",
    });
  }
  return null;
}
