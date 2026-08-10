import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_FILES,
  isReleaseDiff,
  lockfileVersionMismatch,
  packageIdentityMismatch,
  packageChangesBeyondVersion,
  lockfileChangesBeyondVersion,
} from "../src/lib/control-files.mjs";

const pkg = (version, extra = {}) => ({ name: "consumer", version, ...extra });
const lock = (version, extra = {}) => ({
  name: "consumer",
  version,
  packages: { "": { name: "consumer", version }, ...extra },
});

test("RELEASE_FILES is the fixed three-file allowlist", () => {
  assert.deepEqual([...RELEASE_FILES], [
    "CHANGELOG.md",
    "package.json",
    "package-lock.json",
  ]);
});

test("isReleaseDiff accepts exactly the three control files in any order", () => {
  assert.equal(
    isReleaseDiff(["package.json", "CHANGELOG.md", "package-lock.json"]),
    true,
  );
});

test("isReleaseDiff rejects extra, missing, duplicated, or empty sets", () => {
  assert.equal(isReleaseDiff([]), false);
  assert.equal(
    isReleaseDiff(["CHANGELOG.md", "package.json"]),
    false,
    "missing a control file",
  );
  assert.equal(
    isReleaseDiff([
      "CHANGELOG.md",
      "package.json",
      "package-lock.json",
      "README.md",
    ]),
    false,
    "extra file",
  );
  assert.equal(
    isReleaseDiff(["CHANGELOG.md", "package.json", "package-lock.json", "CHANGELOG.md"]),
    false,
    "duplicate collapses the set",
  );
});

test("lockfileVersionMismatch checks root and packages[\"\"] versions", () => {
  assert.equal(lockfileVersionMismatch(lock("1.2.3"), "1.2.3"), null);
  const rootMismatch = lockfileVersionMismatch(lock("1.2.2"), "1.2.3");
  assert.match(rootMismatch, /package-lock\.json\.version is "1\.2\.2", expected "1\.2\.3"/);
  const entryMismatch = lockfileVersionMismatch(
    { ...lock("1.2.3"), packages: { "": { name: "consumer", version: "1.2.2" } } },
    "1.2.3",
  );
  assert.match(entryMismatch, /packages\[""\]\.version is "1\.2\.2"/);
  const missingEntry = lockfileVersionMismatch(
    { ...lock("1.2.3"), packages: {} },
    "1.2.3",
  );
  assert.match(missingEntry, /packages\[""\] is missing or not an object/);
});

test("packageIdentityMismatch requires agreement across all three name slots", () => {
  assert.equal(packageIdentityMismatch(pkg("1.2.3"), lock("1.2.3")), null);
  const lockName = packageIdentityMismatch(pkg("1.2.3"), {
    ...lock("1.2.3"),
    name: "other",
  });
  assert.match(lockName, /package-lock\.json\.name is "other", but package\.json\.name is "consumer"/);
  const entryName = packageIdentityMismatch(pkg("1.2.3"), {
    ...lock("1.2.3"),
    packages: { "": { name: "other", version: "1.2.3" } },
  });
  assert.match(entryName, /packages\[""\]\.name is "other"/);
  const missing = packageIdentityMismatch(pkg("1.2.3"), {
    ...lock("1.2.3"),
    packages: {},
  });
  assert.match(missing, /package name must be a non-empty string/);
});

test("packageChangesBeyondVersion only permits the version field", () => {
  const before = pkg("1.2.2", { description: "a", scripts: { build: "x" } });
  const versionOnly = pkg("1.2.3", { description: "a", scripts: { build: "x" } });
  assert.deepEqual(packageChangesBeyondVersion(before, versionOnly), []);
  // Property-order and formatting changes are not part of the contract.
  const reordered = { scripts: { build: "x" }, version: "1.2.3", description: "a", name: "consumer" };
  assert.deepEqual(packageChangesBeyondVersion(before, reordered), []);
  const changedDescription = pkg("1.2.3", {
    description: "b",
    scripts: { build: "x" },
  });
  assert.deepEqual(packageChangesBeyondVersion(before, changedDescription), ["description"]);
  const removedKey = pkg("1.2.3");
  assert.deepEqual(packageChangesBeyondVersion(before, removedKey), ["description", "scripts"]);
});

test("lockfileChangesBeyondVersion only permits the version fields", () => {
  const before = { ...lock("1.2.2"), dependencies: { a: "1.0.0" } };
  const versionOnly = { ...lock("1.2.3"), dependencies: { a: "1.0.0" } };
  assert.deepEqual(lockfileChangesBeyondVersion(before, versionOnly), []);
  const changedDeps = { ...lock("1.2.3"), dependencies: { a: "2.0.0" } };
  assert.deepEqual(lockfileChangesBeyondVersion(before, changedDeps), ["dependencies"]);
});
