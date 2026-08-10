/**
 * Keep a Changelog grammar:
 * `## [Unreleased]`, `## [x.y.z] - date`, link references, compare-URL
 * rewrite, and version-section extraction for release notes.
 */

const headingPattern = /^## \[([^\]]+)\](.*)$/gm;
const linkReferenceLinePattern = /^\[([^\]]+)\]:[ \t]*\S.*$/;
const sectionBoundaryPattern = /\n## \[|\n\[[^\]]+\]:/;

/**
 * Whether a value is a real calendar date in YYYY-MM-DD form.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime())) return false;
  return instant.toISOString().slice(0, 10) === value;
}

/**
 * Today's date in UTC as YYYY-MM-DD.
 *
 * @returns {string}
 */
export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * @typedef {object} ChangelogSection
 * @property {string} label Section label (e.g. "Unreleased" or "1.2.3").
 * @property {string} suffix Text after the label on the heading line
 *   (e.g. " - 2026-08-01"), untrimmed.
 * @property {string} body Section body (trimmed), or "" for empty.
 * @property {number} index Character offset of the heading in the document.
 */

/**
 * Parse every `## [label]` section with its body. A body ends at the next
 * section heading or the start of the link-reference block. CRLF input is
 * normalized to LF before parsing.
 *
 * @param {string} changelog
 * @returns {ChangelogSection[]}
 */
export function sections(changelog) {
  const text = changelog.replace(/\r\n/g, "\n");
  const result = [];
  for (const match of text.matchAll(headingPattern)) {
    const start = match.index ?? 0;
    const rest = text.slice(start + match[0].length);
    const boundary = rest.search(sectionBoundaryPattern);
    const body = (boundary === -1 ? rest : rest.slice(0, boundary)).trim();
    result.push({
      label: match[1],
      suffix: match[2] ?? "",
      body,
      index: start,
    });
  }
  return result;
}

/**
 * Find the first section with the exact label, or null.
 *
 * @param {string} changelog
 * @param {string} label
 * @returns {ChangelogSection | null}
 */
export function section(changelog, label) {
  return sections(changelog).find((s) => s.label === label) ?? null;
}

/**
 * Link-reference labels present in the document (`[label]: url` lines).
 *
 * @param {string} changelog
 * @returns {Set<string>}
 */
export function linkReferenceLabels(changelog) {
  const labels = new Set();
  for (const line of changelog.replace(/\r\n/g, "\n").split("\n")) {
    const match = linkReferenceLinePattern.exec(line);
    if (match) labels.add(match[1]);
  }
  return labels;
}

/**
 * Whether a section body has non-empty release notes (at least one list item
 * starting with a bullet followed by a non-space character).
 *
 * @param {string} body
 * @returns {boolean}
 */
export function hasNonEmptyNotes(body) {
  return /^\s*-\s+\S/m.test(body);
}

/**
 * Whether the changelog declares the release-intent signal (a mandatory
 * consumer prerequisite): exactly one bare `## [Unreleased]` heading (no
 * date or trailing text).
 *
 * @param {string} changelog
 * @returns {boolean}
 */
export function hasUnreleasedSection(changelog) {
  const unreleased = sections(changelog).filter(
    (s) => s.label === "Unreleased",
  );
  return unreleased.length === 1 && unreleased[0].suffix === "";
}

/**
 * Whether the changelog's `[Unreleased]` section is present and non-empty
 * (prepare requires non-empty notes before cutting a release).
 *
 * @param {string} changelog
 * @returns {{ ok: boolean, reason?: string }}
 */
export function unreleasedState(changelog) {
  const unreleased = sections(changelog).filter(
    (s) => s.label === "Unreleased",
  );
  if (unreleased.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one [Unreleased] section, found ${unreleased.length}`,
    };
  }
  if (unreleased[0].suffix !== "") {
    return {
      ok: false,
      reason: "[Unreleased] header must not include a date or trailing text",
    };
  }
  if (!hasNonEmptyNotes(unreleased[0].body)) {
    return {
      ok: false,
      reason: "[Unreleased] section has no non-empty notes",
    };
  }
  return { ok: true };
}

/**
 * Historical release-changelog verification ("Changelog not a valid released
 * version"): exactly one bare `## [Unreleased]` section that
 * is empty, exactly one `## [x.y.z] - date` section for `version` with a real
 * calendar date and non-empty notes, and a link reference for every section
 * label.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validReleasedChangelog(changelog, version) {
  const all = sections(changelog);
  const unreleased = all.filter((s) => s.label === "Unreleased");
  if (unreleased.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one [Unreleased] section, found ${unreleased.length}`,
    };
  }
  if (unreleased[0].suffix !== "") {
    return {
      ok: false,
      reason: "[Unreleased] header must not include a date or trailing text",
    };
  }
  if (unreleased[0].body !== "") {
    return {
      ok: false,
      reason:
        "[Unreleased] section must be empty for a released version (notes are moved, not copied)",
    };
  }
  const versionSections = all.filter((s) => s.label === version);
  if (versionSections.length !== 1) {
    return {
      ok: false,
      reason: `expected exactly one [${version}] section, found ${versionSections.length}`,
    };
  }
  const target = versionSections[0];
  const dated = /^ - (\d{4}-\d{2}-\d{2})$/.exec(target.suffix);
  if (!dated) {
    return {
      ok: false,
      reason: `[${version}] header must include - YYYY-MM-DD, found ${JSON.stringify(target.suffix)}`,
    };
  }
  if (!isValidCalendarDate(dated[1])) {
    return {
      ok: false,
      reason: `[${version}] date is not a valid calendar day: ${dated[1]}`,
    };
  }
  if (!hasNonEmptyNotes(target.body)) {
    return {
      ok: false,
      reason: `[${version}] section is missing release notes`,
    };
  }
  const labels = new Set(all.map((s) => s.label));
  const links = linkReferenceLabels(changelog);
  const missing = [...labels].filter((label) => !links.has(label));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `changelog is missing link reference(s): ${missing.map((l) => `[${l}]`).join(", ")}`,
    };
  }
  return { ok: true };
}

/**
 * Rewrite the managed link references (`[Unreleased]` and `[version]`) and
 * preserve every prior link reference, mirroring Planlet's
 * `updateChangelogLinkReferences`.
 *
 * @param {string} changelog
 * @param {string} previousVersion
 * @param {string} version
 * @param {string} compareUrl
 * @returns {string}
 */
function updateLinkReferences(changelog, previousVersion, version, compareUrl) {
  const managed = new Map([
    ["Unreleased", `[Unreleased]: ${compareUrl}/v${version}...HEAD`],
    [version, `[${version}]: ${compareUrl}/v${previousVersion}...v${version}`],
  ]);
  const body = [];
  const priorLinks = [];
  for (const line of changelog.split("\n")) {
    const match = linkReferenceLinePattern.exec(line);
    if (match) {
      if (managed.has(match[1])) continue;
      priorLinks.push(line);
      continue;
    }
    body.push(line);
  }
  return (
    [body.join("\n").trimEnd(), "", ...managed.values(), ...priorLinks].join(
      "\n",
    ) + "\n"
  );
}

/**
 * Cut the changelog for a release: move the `[Unreleased]` body into a new
 * `## [version] - date` section (leaving `[Unreleased]` empty), rewrite the
 * managed link references, and preserve prior link references.
 *
 * @param {string} changelog
 * @param {{ previousVersion: string, version: string, date: string, compareUrl: string }} options
 * @returns {{ ok: boolean, content?: string, reason?: string }}
 */
export function cutChangelog(
  changelog,
  { previousVersion, version, date, compareUrl },
) {
  const text = changelog.replace(/\r\n/g, "\n");
  const current = unreleasedState(text);
  if (!current.ok) {
    return { ok: false, reason: current.reason };
  }
  const unreleasedIdx = text.indexOf("## [Unreleased]");
  const rest = text.slice(unreleasedIdx);
  const boundary = rest.search(sectionBoundaryPattern);
  const unreleasedSection = boundary === -1 ? rest : rest.slice(0, boundary);
  const bodyMatch = unreleasedSection.match(/^## \[Unreleased\]\n\n([\s\S]*)$/);
  const unreleasedBody = bodyMatch ? bodyMatch[1].trim() : "";
  if (!unreleasedBody) {
    return {
      ok: false,
      reason: "[Unreleased] section is empty; nothing to release",
    };
  }
  const after = boundary === -1 ? "" : rest.slice(boundary).replace(/^\n+/, "");
  const before = text.slice(0, unreleasedIdx);
  const content = updateLinkReferences(
    before +
      "## [Unreleased]\n\n" +
      `## [${version}] - ${date}\n\n` +
      unreleasedBody +
      "\n\n" +
      after,
    previousVersion,
    version,
    compareUrl,
  );
  return { ok: true, content };
}

/**
 * Release-notes body for a version section (the GitHub Release notes source),
 * or null when the section is absent.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
export function releaseNotes(changelog, version) {
  const target = section(changelog, version);
  return target ? target.body : null;
}
