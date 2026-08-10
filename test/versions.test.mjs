import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  formatVersion,
  isStrictIncrease,
  parseStableVersion,
} from "../src/lib/versions.mjs";

test("parseStableVersion accepts stable X.Y.Z", () => {
  assert.deepEqual(parseStableVersion("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseStableVersion("0.0.0"), [0, 0, 0]);
  assert.deepEqual(parseStableVersion("10.200.3000"), [10, 200, 3000]);
});

test("parseStableVersion rejects malformed input", () => {
  for (const value of [
    undefined,
    null,
    1.23,
    "",
    "1.2",
    "1.2.3.4",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-beta",
    "v1.2.3",
    "1.2.3+meta",
    "1.2.3 ",
    "1..3",
    "1.2.x",
  ]) {
    assert.equal(
      parseStableVersion(value),
      null,
      `expected ${String(value)} to be rejected`,
    );
  }
});

test("compareVersions orders correctly", () => {
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
  assert.ok(compareVersions([1, 2, 4], [1, 2, 3]) > 0);
  assert.ok(compareVersions([1, 2, 3], [1, 2, 4]) < 0);
  assert.ok(compareVersions([1, 3, 0], [1, 2, 9]) > 0);
  assert.ok(compareVersions([2, 0, 0], [1, 9, 9]) > 0);
});

test("isStrictIncrease requires strictly greater", () => {
  assert.equal(isStrictIncrease([1, 2, 2], [1, 2, 3]), true);
  assert.equal(isStrictIncrease([1, 2, 3], [1, 2, 3]), false);
  assert.equal(isStrictIncrease([1, 2, 4], [1, 2, 3]), false);
});

test("formatVersion round-trips", () => {
  assert.equal(formatVersion([1, 2, 3]), "1.2.3");
});
