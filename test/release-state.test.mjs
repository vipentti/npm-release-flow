import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRelease } from "../src/lib/release-state.mjs";

const sha = (char) => char.repeat(40);
const AFTER = sha("a");
const OTHER = sha("b");

function validChangelog(version) {
  return `# Changelog

## [Unreleased]

## [${version}] - 2026-08-01

- Released ${version}.

[Unreleased]: https://github.com/example/repo/compare/v${version}...HEAD
[${version}]: https://github.com/example/repo/compare/v1.2.2...v${version}
`;
}

const FILES = ["CHANGELOG.md", "package.json", "package-lock.json"];

function validInput(overrides = {}) {
  const version = "1.2.3";
  const previous = "1.2.2";
  const base = {
    beforeResolved: true,
    headMatchesTrigger: true,
    beforePkg: { name: "consumer", version: previous },
    afterPkg: { name: "consumer", version },
    beforeLock: {
      name: "consumer",
      version: previous,
      packages: { "": { name: "consumer", version: previous } },
    },
    afterLock: {
      name: "consumer",
      version,
      packages: { "": { name: "consumer", version } },
    },
    changedFiles: FILES,
    changelog: validChangelog(version),
    tagTarget: null,
    afterSha: AFTER,
  };
  return { ...base, ...overrides };
}

test("§9: version unchanged is an ordinary push whatever files changed", () => {
  const ordinary = validInput({
    afterPkg: { name: "consumer", version: "1.2.2" },
    afterLock: {
      name: "consumer",
      version: "1.2.2",
      packages: { "": { name: "consumer", version: "1.2.2" } },
    },
    changelog: "anything",
  });
  assert.equal(ordinary.changedFiles.length, 3);
  const verdict = classifyRelease(ordinary);
  assert.deepEqual(verdict, { verdict: "ordinary", version: null, reasons: [] });

  const noFiles = classifyRelease(
    validInput({
      changedFiles: [],
      afterPkg: { name: "consumer", version: "1.2.2" },
      afterLock: {
        name: "consumer",
        version: "1.2.2",
        packages: { "": { name: "consumer", version: "1.2.2" } },
      },
    }),
  );
  assert.equal(noFiles.verdict, "ordinary");
});

test("§9: valid release with no tag", () => {
  const verdict = classifyRelease(validInput());
  assert.deepEqual(verdict, { verdict: "valid", version: "1.2.3", reasons: [] });
});

test("§9: tag already at the release commit is still a valid release", () => {
  const verdict = classifyRelease(validInput({ tagTarget: AFTER }));
  assert.deepEqual(verdict, { verdict: "valid", version: "1.2.3", reasons: [] });
});

test("§9: before SHA missing, malformed, all-zero, or unresolvable is a hard fail", () => {
  const verdict = classifyRelease(validInput({ beforeResolved: false }));
  assert.equal(verdict.verdict, "invalid");
  assert.match(verdict.reasons[0], /Checked: the previous push SHA\./);
  assert.match(verdict.reasons[0], /Found: missing, malformed, all-zero, or unresolvable\./);
  assert.match(verdict.reasons[0], /Correction: re-run on a push whose previous SHA resolves to a commit\./);
});

test("§9: HEAD not equal to the triggering SHA is a hard fail", () => {
  const verdict = classifyRelease(validInput({ headMatchesTrigger: false }));
  assert.equal(verdict.verdict, "invalid");
  assert.match(verdict.reasons[0], /Checked: HEAD against the triggering SHA\./);
});

test("§9: new or previous version not stable X.Y.Z is a hard fail", () => {
  const newUnstable = classifyRelease(
    validInput({ afterPkg: { name: "consumer", version: "1.2.3-beta" } }),
  );
  assert.equal(newUnstable.verdict, "invalid");
  assert.match(newUnstable.reasons[0], /Checked: the new package\.json\.version\./);
  assert.match(newUnstable.reasons[0], /Found: "1\.2\.3-beta"\./);

  const previousUnstable = classifyRelease(
    validInput({ beforePkg: { name: "consumer", version: "1.2" } }),
  );
  assert.equal(previousUnstable.verdict, "invalid");
  assert.match(previousUnstable.reasons[0], /Checked: the previous package\.json\.version\./);

  const leadingZero = classifyRelease(
    validInput({ afterPkg: { name: "consumer", version: "01.2.3" } }),
  );
  assert.equal(leadingZero.verdict, "invalid");

  const unreadable = classifyRelease(validInput({ afterPkg: null }));
  assert.equal(unreadable.verdict, "invalid");
  assert.match(unreadable.reasons[0], /unreadable/);
});

test("§9: version not increased is a hard fail", () => {
  const verdict = classifyRelease(
    validInput({ afterPkg: { name: "consumer", version: "1.2.1" } }),
  );
  assert.equal(verdict.verdict, "invalid");
  assert.match(verdict.reasons[0], /Checked: whether the new version strictly increases\./);
  assert.match(verdict.reasons[0], /Found: new version 1\.2\.1 is not greater than previous 1\.2\.2\./);
});

test("§9: lockfile mismatch vs version is a hard fail", () => {
  const verdict = classifyRelease(
    validInput({
      afterLock: {
        name: "consumer",
        version: "1.2.2",
        packages: { "": { name: "consumer", version: "1.2.2" } },
      },
    }),
  );
  assert.equal(verdict.verdict, "invalid");
  assert.match(verdict.reasons[0], /Checked: package-lock\.json version fields against the release version\./);
  assert.match(verdict.reasons[0], /Correction: regenerate the lockfile with npm install\./);

  const unreadable = classifyRelease(validInput({ afterLock: null }));
  assert.equal(unreadable.verdict, "invalid");
  const previousUnreadable = classifyRelease(validInput({ beforeLock: null }));
  assert.equal(previousUnreadable.verdict, "invalid");
});

test("§9: package identity mismatch is a hard fail", () => {
  const verdict = classifyRelease(
    validInput({
      afterLock: {
        name: "other",
        version: "1.2.3",
        packages: { "": { name: "other", version: "1.2.3" } },
      },
    }),
  );
  assert.equal(verdict.verdict, "invalid");
  assert.match(verdict.reasons[0], /Checked: package identity across package\.json and package-lock\.json\./);
});

test("§9: package.json changed beyond the version field is a hard fail", () => {
  const verdict = classifyRelease(
    validInput({ afterPkg: { name: "consumer", version: "1.2.3", description: "changed" } }),
  );
  assert.equal(verdict.verdict, "invalid");
  assert.match(verdict.reasons[0], /Checked: package\.json changes beyond the version field\./);
  assert.match(verdict.reasons[0], /Found: changed key\(s\): description\./);
  assert.match(verdict.reasons[0], /Correction: a release merge may only change package\.json\.version\./);
});

test("§9: package-lock.json changed beyond the version fields is a hard fail", () => {
  const verdict = classifyRelease(
    validInput({
      afterLock: {
        name: "consumer",
        version: "1.2.3",
        packages: { "": { name: "consumer", version: "1.2.3" } },
        dependencies: { a: "2.0.0" },
      },
    }),
  );
  assert.equal(verdict.verdict, "invalid");
  assert.match(verdict.reasons[0], /Checked: package-lock\.json changes beyond the version fields\./);
  assert.match(verdict.reasons[0], /Found: changed key\(s\): dependencies\./);
});

test("§9: diff not exactly the three control files is a hard fail", () => {
  const extra = classifyRelease(
    validInput({ changedFiles: [...FILES, "README.md"] }),
  );
  assert.equal(extra.verdict, "invalid");
  assert.match(extra.reasons[0], /Checked: the changed-file set against the release-diff allowlist\./);
  assert.match(extra.reasons[0], /Found: CHANGELOG\.md, package\.json, package-lock\.json, README\.md\./);

  const missing = classifyRelease(
    validInput({ changedFiles: ["CHANGELOG.md", "package.json"] }),
  );
  assert.equal(missing.verdict, "invalid");

  const none = classifyRelease(validInput({ changedFiles: [] }));
  assert.equal(none.verdict, "invalid");
  assert.match(none.reasons[0], /Found: no files changed\./);
});

test("§9: changelog not a valid released version is a hard fail", () => {
  const noSection = classifyRelease(
    validInput({ changelog: "# Changelog\n\n## [Unreleased]\n\n## [9.9.9] - 2026-08-01\n\n- Other version.\n" }),
  );
  assert.equal(noSection.verdict, "invalid");
  assert.match(noSection.reasons[0], /Checked: the changelog as a valid released version\./);

  const unreadable = classifyRelease(validInput({ changelog: null }));
  assert.equal(unreadable.verdict, "invalid");
});

test("§9: tag at a commit other than the release commit is a hard fail", () => {
  const verdict = classifyRelease(validInput({ tagTarget: OTHER }));
  assert.equal(verdict.verdict, "invalid");
  assert.match(verdict.reasons[0], /Checked: refs\/tags\/v1\.2\.3 target against the release commit\./);
  assert.match(verdict.reasons[0], /Found: tag points at b{40}, not the triggering commit a{40}\./);
  assert.match(verdict.reasons[0], /Correction: delete or move the tag to the release commit\./);
});

test("§9: ambiguous rows fail closed, never degrade to ordinary", () => {
  // A version bump with a malformed changelog must NOT be ordinary.
  const verdict = classifyRelease(
    validInput({ changelog: "# Changelog\n\nNo sections at all.\n" }),
  );
  assert.equal(verdict.verdict, "invalid");
});
