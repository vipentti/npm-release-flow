import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cutChangelog,
  hasNonEmptyNotes,
  hasUnreleasedSection,
  isValidCalendarDate,
  linkReferenceLabels,
  releaseNotes,
  section,
  sections,
  unreleasedState,
  validReleasedChangelog,
} from "../src/lib/changelog.mjs";

const compareUrl = "https://github.com/example/repo/compare";

const sample = `# Changelog

## [Unreleased]

- Added a feature.
- Fixed a bug.

## [1.2.2] - 2026-07-01

- Previous release notes.

[Unreleased]: https://github.com/example/repo/compare/v1.2.2...HEAD
[1.2.2]: https://github.com/example/repo/compare/v1.2.1...v1.2.2
`;

test("isValidCalendarDate accepts real dates and rejects fakes", () => {
  assert.equal(isValidCalendarDate("2026-08-01"), true);
  assert.equal(isValidCalendarDate("2026-02-29"), false, "not a leap year");
  assert.equal(isValidCalendarDate("2024-02-29"), true, "leap year");
  assert.equal(isValidCalendarDate("2026-13-01"), false);
  assert.equal(isValidCalendarDate("2026-08-32"), false);
  assert.equal(isValidCalendarDate("08/01/2026"), false);
  assert.equal(isValidCalendarDate("20260801"), false);
  assert.equal(isValidCalendarDate(null), false);
});

test("sections parses headings with bodies, stopping at the link block", () => {
  const all = sections(sample);
  assert.equal(all.length, 2);
  assert.equal(all[0].label, "Unreleased");
  assert.equal(all[0].suffix, "");
  assert.match(all[0].body, /Added a feature\./);
  assert.match(all[0].body, /Fixed a bug\./);
  assert.equal(all[1].label, "1.2.2");
  assert.equal(all[1].suffix, " - 2026-07-01");
  assert.match(all[1].body, /Previous release notes\./);
});

test("section finds by exact label, null when absent", () => {
  assert.equal(section(sample, "1.2.2").label, "1.2.2");
  assert.equal(section(sample, "9.9.9"), null);
});

test("linkReferenceLabels collects [label]: url lines", () => {
  const labels = linkReferenceLabels(sample);
  assert.equal(labels.has("Unreleased"), true);
  assert.equal(labels.has("1.2.2"), true);
  assert.equal(labels.has("1.2.1"), false);
});

test("hasNonEmptyNotes requires a bullet with content", () => {
  assert.equal(hasNonEmptyNotes("- Something happened."), true);
  assert.equal(hasNonEmptyNotes("  -  Indented bullet"), true);
  assert.equal(hasNonEmptyNotes(""), false);
  assert.equal(hasNonEmptyNotes("-"), false);
  assert.equal(hasNonEmptyNotes("- "), false);
  assert.equal(hasNonEmptyNotes("plain prose without a bullet"), false);
});

test("hasUnreleasedSection requires exactly one bare heading", () => {
  assert.equal(hasUnreleasedSection(sample), true);
  assert.equal(hasUnreleasedSection("# No sections here\n"), false);
  assert.equal(
    hasUnreleasedSection(sample.replace("## [Unreleased]", "## [Unreleased] - 2026-08-01")),
    false,
    "dated Unreleased heading is malformed",
  );
  assert.equal(
    hasUnreleasedSection(sample + "\n## [Unreleased]\n"),
    false,
    "duplicate Unreleased headings",
  );
});

test("unreleasedState requires exactly one bare non-empty Unreleased section", () => {
  assert.equal(unreleasedState(sample).ok, true);
  const empty = sample.replace("- Added a feature.\n- Fixed a bug.\n\n", "");
  const emptyState = unreleasedState(empty);
  assert.equal(emptyState.ok, false);
  assert.match(emptyState.reason, /no non-empty notes/);
});

test("cutChangelog moves the Unreleased body into a dated section and rewrites links", () => {
  const result = cutChangelog(sample, {
    previousVersion: "1.2.2",
    version: "1.2.3",
    date: "2026-08-01",
    compareUrl,
  });
  assert.equal(result.ok, true);
  const content = result.content;
  const all = sections(content);
  assert.equal(all.length, 3);
  assert.equal(all[0].label, "Unreleased");
  assert.equal(all[0].body, "", "Unreleased is emptied, not removed");
  assert.equal(all[1].label, "1.2.3");
  assert.equal(all[1].suffix, " - 2026-08-01");
  assert.match(all[1].body, /Added a feature\./);
  assert.match(all[1].body, /Fixed a bug\./);
  assert.equal(all[2].label, "1.2.2");
  const labels = linkReferenceLabels(content);
  assert.equal(labels.has("1.2.2"), true, "prior links preserved");
  assert.match(content, new RegExp(`\\[Unreleased\\]: ${compareUrl}/v1\\.2\\.3\\.\\.\\.HEAD`));
  assert.match(content, new RegExp(`\\[1\\.2\\.3\\]: ${compareUrl}/v1\\.2\\.2\\.\\.\\.v1\\.2\\.3`));
  assert.ok(content.endsWith("\n"));
});

test("cutChangelog refuses an empty Unreleased section", () => {
  const empty = sample.replace("- Added a feature.\n- Fixed a bug.\n\n", "");
  const result = cutChangelog(empty, {
    previousVersion: "1.2.2",
    version: "1.2.3",
    date: "2026-08-01",
    compareUrl,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty; nothing to release|no non-empty notes/);
});

test("validReleasedChangelog accepts the post-prepare shape", () => {
  const released = `# Changelog

## [Unreleased]

## [1.2.3] - 2026-08-01

- Released 1.2.3.

[Unreleased]: https://github.com/example/repo/compare/v1.2.3...HEAD
[1.2.3]: https://github.com/example/repo/compare/v1.2.2...v1.2.3
`;
  assert.equal(validReleasedChangelog(released, "1.2.3").ok, true);
});

test("validReleasedChangelog rejects every invalid row", () => {
  const base = `# Changelog

## [Unreleased]

## [1.2.3] - 2026-08-01

- Released 1.2.3.

[Unreleased]: https://github.com/example/repo/compare/v1.2.3...HEAD
[1.2.3]: https://github.com/example/repo/compare/v1.2.2...v1.2.3
`;
  const cases = [
    {
      name: "non-empty Unreleased",
      edit: (c) => c.replace("## [Unreleased]\n\n## [1.2.3]", "## [Unreleased]\n\n- Not moved.\n\n## [1.2.3]"),
      match: /must be empty/,
    },
    {
      name: "no version section",
      edit: (c) => c.replace("\n## [1.2.3] - 2026-08-01\n\n- Released 1.2.3.\n", "\n"),
      match: /expected exactly one \[1\.2\.3\] section/,
    },
    {
      name: "undated version section",
      edit: (c) => c.replace("## [1.2.3] - 2026-08-01", "## [1.2.3]"),
      match: /must include - YYYY-MM-DD/,
    },
    {
      name: "impossible date",
      edit: (c) => c.replace("2026-08-01", "2026-02-30"),
      match: /not a valid calendar day/,
    },
    {
      name: "missing release notes",
      edit: (c) => c.replace("\n- Released 1.2.3.\n", "\n"),
      match: /missing release notes/,
    },
    {
      name: "missing link reference",
      edit: (c) => c.replace("[1.2.3]: https://github.com/example/repo/compare/v1.2.2...v1.2.3\n", ""),
      match: /missing link reference\(s\): \[1\.2\.3\]/,
    },
  ];
  for (const { name, edit, match } of cases) {
    const result = validReleasedChangelog(edit(base), "1.2.3");
    assert.equal(result.ok, false, name);
    assert.match(result.reason, match, name);
  }
});

test("releaseNotes extracts the version section body", () => {
  const released = `# Changelog

## [Unreleased]

## [1.2.3] - 2026-08-01

- Released 1.2.3.

[Unreleased]: https://github.com/example/repo/compare/v1.2.3...HEAD
[1.2.3]: https://github.com/example/repo/compare/v1.2.2...v1.2.3
`;
  assert.equal(releaseNotes(released, "1.2.3"), "- Released 1.2.3.");
  assert.equal(releaseNotes(released, "9.9.9"), null);
});
