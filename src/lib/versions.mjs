/**
 * Stable X.Y.Z version parsing, comparison, and strict-increase checks
 * (blueprint §9: "New or previous version not stable X.Y.Z" is a hard fail).
 * Semver forbids leading zeros; prereleases and build metadata are not
 * stable versions.
 */

/**
 * Parse a stable X.Y.Z version into numeric parts.
 *
 * @param {unknown} value
 * @returns {[number, number, number] | null} Parsed parts, or null when the
 *   value is not a stable X.Y.Z version (including leading zeros, e.g.
 *   "01.2.3", and prerelease/build suffixes).
 */
export function parseStableVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (match.slice(1).some((segment, i) => segment !== String(parts[i]))) {
    return null;
  }
  return /** @type {[number, number, number]} */ (parts);
}

/**
 * Compare two parsed versions: negative when `a < b`, zero when equal,
 * positive when `a > b`.
 *
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Whether `after` is strictly greater than `before`.
 *
 * @param {[number, number, number]} before
 * @param {[number, number, number]} after
 * @returns {boolean}
 */
export function isStrictIncrease(before, after) {
  return compareVersions(after, before) > 0;
}

/**
 * Format parsed parts back to a "X.Y.Z" string.
 *
 * @param {[number, number, number]} parts
 * @returns {string}
 */
export function formatVersion(parts) {
  return parts.join(".");
}
