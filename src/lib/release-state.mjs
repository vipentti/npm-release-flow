/**
 * Release-state enumeration classification over a push diff. Ambiguity
 * fails closed (hard fail) and is never degraded to an ordinary push; one
 * deliberate non-ambiguity: a tag already pointing at the release commit is
 * still a valid release (it routes the protected job to the verify-only
 * path, it is not a failure).
 */

import { describeFailure } from "./errors.mjs";
import {
  RELEASE_FILES,
  isReleaseDiff,
  lockfileVersionMismatch,
  packageIdentityMismatch,
  packageChangesBeyondVersion,
  lockfileChangesBeyondVersion,
} from "./control-files.mjs";
import { parseStableVersion, isStrictIncrease } from "./versions.mjs";
import { validReleasedChangelog } from "./changelog.mjs";

/**
 * @typedef {object} ReleaseStateInput
 * @property {boolean} beforeResolved Whether the `before` SHA is present,
 *   well-formed, non-zero, and resolves to a commit.
 * @property {boolean} headMatchesTrigger Whether HEAD equals the triggering
 *   SHA.
 * @property {Record<string, any> | null} beforePkg package.json at `before`
 *   (parsed), or null when unreadable.
 * @property {Record<string, any> | null} afterPkg package.json at `after`
 *   (parsed), or null when unreadable.
 * @property {Record<string, any> | null} beforeLock package-lock.json at
 *   `before` (parsed), or null when unreadable.
 * @property {Record<string, any> | null} afterLock package-lock.json at
 *   `after` (parsed), or null when unreadable.
 * @property {string[]} changedFiles Changed-file paths (before..after).
 * @property {string | null} changelog CHANGELOG.md content at `after`, or
 *   null when unreadable.
 * @property {string | null} tagTarget Resolved target SHA of
 *   `refs/tags/v<afterVersion>`, or null when the tag does not exist.
 * @property {string} afterSha The triggering (after) commit SHA.
 */

/**
 * @typedef {object} ReleaseVerdict
 * @property {"ordinary" | "valid" | "invalid"} verdict The classification of
 *   the release: ordinary, valid, or invalid.
 * @property {string | null} version The released version when `valid`.
 * @property {string[]} reasons Error-content messages when `invalid`
 *   (checked / found / correction).
 */

/**
 * @param {string} checked
 * @param {string} found
 * @param {string} correction
 * @returns {ReleaseVerdict}
 */
function invalid(checked, found, correction) {
  return {
    verdict: "invalid",
    version: null,
    reasons: [describeFailure({ checked, found, correction })],
  };
}

/**
 * Classify a push per the release-state enumeration.
 *
 * @param {ReleaseStateInput} input
 * @returns {ReleaseVerdict}
 */
export function classifyRelease(input) {
  const pkg = input.afterPkg;
  const beforePkg = input.beforePkg;
  const lock = input.afterLock;
  const beforeLock = input.beforeLock;
  const beforeVersion =
    beforePkg && typeof beforePkg.version === "string"
      ? beforePkg.version
      : null;
  const afterVersion =
    pkg && typeof pkg.version === "string" ? pkg.version : null;

  if (!input.beforeResolved) {
    return invalid(
      "the previous push SHA",
      "missing, malformed, all-zero, or unresolvable",
      "re-run on a push whose previous SHA resolves to a commit",
    );
  }
  if (!input.headMatchesTrigger) {
    return invalid(
      "HEAD against the triggering SHA",
      "HEAD does not equal the triggering commit",
      "bind HEAD to the triggering SHA before classifying",
    );
  }
  // Version unchanged: ordinary push, whatever files changed.
  if (
    beforeVersion !== null &&
    afterVersion !== null &&
    beforeVersion === afterVersion
  ) {
    return { verdict: "ordinary", version: null, reasons: [] };
  }

  const beforeParsed =
    beforeVersion === null ? null : parseStableVersion(beforeVersion);
  const afterParsed =
    afterVersion === null ? null : parseStableVersion(afterVersion);
  if (beforeParsed === null) {
    return invalid(
      "the previous package.json.version",
      beforeVersion === null
        ? "package.json at the previous commit is unreadable"
        : JSON.stringify(beforeVersion),
      "use a stable X.Y.Z version (no leading zeros, no prerelease)",
    );
  }
  if (afterParsed === null) {
    return invalid(
      "the new package.json.version",
      afterVersion === null
        ? "package.json at the triggering commit is unreadable"
        : JSON.stringify(afterVersion),
      "use a stable X.Y.Z version (no leading zeros, no prerelease)",
    );
  }
  if (!isStrictIncrease(beforeParsed, afterParsed)) {
    return invalid(
      "whether the new version strictly increases",
      `new version ${afterVersion} is not greater than previous ${beforeVersion}`,
      "release a higher stable version",
    );
  }
  // TS cannot narrow `afterVersion` through the parsed check; from here on
  // the release version is a string.
  const releaseVersion = /** @type {string} */ (afterVersion);

  if (lock === null) {
    return invalid(
      "package-lock.json at the triggering commit",
      "the lockfile could not be read",
      "commit a readable package-lock.json",
    );
  }
  const lockMismatch = lockfileVersionMismatch(lock, releaseVersion);
  if (lockMismatch) {
    return invalid(
      "package-lock.json version fields against the release version",
      lockMismatch,
      "regenerate the lockfile with npm install",
    );
  }
  if (beforeLock === null) {
    return invalid(
      "package-lock.json at the previous commit",
      "the previous lockfile could not be read",
      "fix the lockfile at the previous commit",
    );
  }
  const identityMismatch = packageIdentityMismatch(
    /** @type {Record<string, any>} */ (pkg),
    lock,
  );
  if (identityMismatch) {
    return invalid(
      "package identity across package.json and package-lock.json",
      identityMismatch,
      "align the package name in both files",
    );
  }
  // `pkg`/`beforePkg` are null-checked indirectly through the version
  // reads above; TS cannot narrow through those, so assert the types.
  const pkgChanges = packageChangesBeyondVersion(
    /** @type {Record<string, any>} */ (beforePkg),
    /** @type {Record<string, any>} */ (pkg),
  );
  if (pkgChanges.length > 0) {
    return invalid(
      "package.json changes beyond the version field",
      `changed key(s): ${pkgChanges.join(", ")}`,
      "a release merge may only change package.json.version",
    );
  }
  const lockChanges = lockfileChangesBeyondVersion(beforeLock, lock);
  if (lockChanges.length > 0) {
    return invalid(
      "package-lock.json changes beyond the version fields",
      `changed key(s): ${lockChanges.join(", ")}`,
      "a release merge may only change lockfile version fields",
    );
  }
  if (!isReleaseDiff(input.changedFiles)) {
    return invalid(
      "the changed-file set against the release-diff allowlist",
      input.changedFiles.length === 0
        ? "no files changed"
        : input.changedFiles.join(", "),
      `a release merge must change exactly ${RELEASE_FILES.join(", ")}`,
    );
  }
  if (input.changelog === null) {
    return invalid(
      "CHANGELOG.md at the triggering commit",
      "the changelog could not be read",
      "commit a readable CHANGELOG.md",
    );
  }
  const changelogCheck = validReleasedChangelog(
    input.changelog,
    releaseVersion,
  );
  if (!changelogCheck.ok) {
    return invalid(
      "the changelog as a valid released version",
      changelogCheck.reason ?? "the changelog is not a valid released version",
      "cut the changelog with the prepare flow",
    );
  }
  if (input.tagTarget !== null && input.tagTarget !== input.afterSha) {
    return invalid(
      `refs/tags/v${releaseVersion} target against the release commit`,
      `tag points at ${input.tagTarget}, not the triggering commit ${input.afterSha}`,
      "delete or move the tag to the release commit",
    );
  }

  return { verdict: "valid", version: releaseVersion, reasons: [] };
}
