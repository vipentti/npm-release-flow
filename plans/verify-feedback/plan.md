# Richer verify failure feedback

## Summary

Make kit command-failure messages honor the error-content contract when the
failing subprocess writes only to stdout. A shared helper joins non-empty
captured stdout and stderr, trims, and caps the result; every current
stderr-only `found:` extraction uses it. Per-step `checked:` labels and
generic fallbacks stay as they are.

## Motivation

`CommandError` already carries both streams (`src/lib/errors.mjs`), and
`runSync`/`runAsync` populate them (`src/lib/spawn.mjs`). Call sites still
take `err.stderr.trim()` only. A failing step that writes to stdout (the
observed case: `git diff --exit-code` at the end of a consumer
`release:verify`) therefore produces an empty `found:` and falls back to
the generic line:

`Checked: npm run release:verify. Found: the release:verify script failed.`

The real cause never reaches the job log.

## Scope

- Add one helper (and a named length constant) next to `describeFailure` in
  `src/lib/errors.mjs`. `src/index.mjs` already re-exports that module.
- Replace every stderr-only `CommandError` detail extraction used as
  `describeFailure` `found:` (or the equivalent mutation-error detail) in:
  `src/verify.mjs`, `src/detect.mjs`, `src/release.mjs`,
  `src/validate-artifact.mjs`, `src/commands/check.mjs`,
  `src/commands/prepare.mjs`, `src/commands/tag.mjs`,
  `src/lib/tag-verify.mjs`.
- Unit tests for the helper in `test/errors.test.mjs`. One `verify` fixture
  test that a `release:verify` script whose distinctive output is on stdout
  surfaces that output in the logged failure.
- `CHANGELOG.md` `## [Unreleased]` entry. A short README note that verify
  (and other command) failures include captured stdout and stderr.

## Out of Scope

- Changing `checked:` strings, correction text, or generic `found:`
  fallbacks.
- `revalidate.mjs`: it swallows spawn errors and uses fixed `found:` text.
- Status-based classification that inspects `err.stderr` for meaning
  (`check.mjs` `isNotFound` 404 probe, `refProbeSync`, other
  `err.status === N` branches). Those are not detail composition.
- Spawn capture, `maxBuffer`, or `CommandError` shape.
- Workflow YAML, CLI flags, or consumer `release:verify` scripts.

## Approach

Put `commandFailureDetail(err)` in `src/lib/errors.mjs`:

- Non-`CommandError`: `String(err)` (same as today).
- `CommandError`: trim stdout and stderr independently; drop empty
  streams; join the rest with a single newline (stdout first, so
  stdout-only tools surface); trim the join. Empty both streams returns
  `""` so the existing `detail || "<generic>"` fallback still fires.
- If the joined text is longer than `COMMAND_FAILURE_DETAIL_LIMIT` (8192
  characters), keep the first 8192 characters and append `\n...[truncated]`.
  8 KiB is enough for a typical short `git diff --exit-code` and keeps
  Actions logs readable.

Call sites become `commandFailureDetail(err)` in place of
`err instanceof CommandError ? err.stderr.trim() : String(err)`. Keep each
site's `detail || "<generic>"`. The two `tag-verify.mjs` sites today fall
back to `err.message` rather than a generic; keep that local
`commandFailureDetail(err) || err.message` shape so GPG failures without
stream output stay as specific as they are now.

Do not inject spawn into `verify`. The helper unit tests cover stdout-only,
empty-both, both-streams, and the cap. The verify fixture test sets
`release:verify` to a one-liner that writes a unique token to stdout and
exits 1, then asserts the logged `describeFailure` line still has
`Checked: npm run release:verify` and contains the token. npm may also
write lifecycle text to stderr; that is fine as long as the stdout token
is present.

## Acceptance Criteria

- A `CommandError` with only stdout yields that trimmed stdout as the
  detail; both streams empty yields `""`; both non-empty streams appear,
  stdout then stderr; text longer than 8192 characters is capped and marked
  truncated.
- `npm run release:verify` (and the other replaced command sites) put that
  detail in `found:`. A verify fixture whose script prints only to stdout
  then exits non-zero logs that stdout in `Found:` and keeps
  `Checked: npm run release:verify`.
- Empty captured streams still use each site's existing generic `found:`
  (verify: `the release:verify script failed`).
- `checked:` labels, corrections, exit codes, and spawn behavior are
  unchanged. `isNotFound` and other status classifiers still read
  `err.stderr` / `err.status` directly.
- `CHANGELOG.md` `## [Unreleased]` records the fix. README states that
  command-failure `found:` includes captured stdout and stderr, capped.

## Verification

- Per task: `node --test test/errors.test.mjs` after the helper;
  `node --test test/verify.test.mjs` after the verify wiring; targeted
  command tests after the remaining call-site sweep if those files change
  behavior.
- Before checking the last task: `npm run lint`, `npm run format:check`,
  `npm run typecheck`, `npm run knip`, `npm test`.
- `planlet validate verify-feedback` after any plan or task edit.
- No `## Verification Evidence` section: all checks are reproducible via
  the commands above and CI.

## Risks and Considerations

- Including stdout can put file diffs or npm install logs into job
  summaries. The 8192-character cap is the mitigation; do not raise it
  without a new reason.
- npm often writes lifecycle errors to stderr even when the script used
  stdout. The helper still has to include stdout so the script's own
  output is not dropped beside npm's wrapper text.
- `tag-verify.mjs` must keep its `err.message` fallback; using only the
  helper there would replace today's GPG message with a less specific
  generic if both streams are empty.
