# Richer verify failure feedback

## Summary

Make kit command-failure messages honor the error-content contract when the
failing subprocess writes only to stdout. A shared helper returns trimmed
stderr when present, otherwise trimmed stdout, then caps that selected
detail. Every current stderr-only `found:` extraction uses it. Per-step
`checked:` labels and generic fallbacks stay as they are.

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

- Add `commandFailureDetail` next to `describeFailure` in
  `src/lib/errors.mjs`. Keep the length cap as a module-private constant;
  `src/index.mjs` already re-exports that module, so only the helper may
  be exported.
- Replace every stderr-only `CommandError` detail extraction used as
  `describeFailure` `found:` (or the equivalent mutation-error detail) in:
  `src/verify.mjs`, `src/detect.mjs`, `src/release.mjs`,
  `src/validate-artifact.mjs`, `src/commands/check.mjs`,
  `src/commands/prepare.mjs`, `src/commands/tag.mjs`,
  `src/lib/tag-verify.mjs`.
- Unit tests for the helper in `test/errors.test.mjs`. One `verify` fixture
  test that a `release:verify` script whose distinctive output is on stdout
  (and whose captured stderr is empty) surfaces that output in the logged
  failure.
- `CHANGELOG.md` `## [Unreleased]` entry. A short README note that
  command-failure `found:` prefers stderr and falls back to stdout.

## Out of Scope

- Changing `checked:` strings, correction text, or generic `found:`
  fallbacks.
- `revalidate.mjs`: it swallows spawn errors and uses fixed `found:` text.
- Status-based classification that inspects `err.stderr` for meaning
  (`check.mjs` `isNotFound` 404 probe, `refProbeSync`, other
  `err.status === N` branches). Those are not detail composition.
- Spawn capture, `maxBuffer`, or `CommandError` shape.
- Workflow YAML, CLI flags, or consumer `release:verify` scripts.
- Joining or interleaving stdout and stderr in one detail string.

## Approach

Put `commandFailureDetail(err)` in `src/lib/errors.mjs`:

- Non-`CommandError`: `String(err)` (same as today).
- `CommandError`: `stderr.trim() || stdout.trim()`. Empty both streams
  returns `""` so the existing `detail || "<generic>"` fallback still
  fires. When stderr is non-empty, stdout is ignored.
- Cap the selected detail, not a concatenation. A module-private
  `COMMAND_FAILURE_DETAIL_LIMIT` of 8192 is the maximum length of the
  returned string. If the selected text is longer, keep a prefix so that
  prefix plus `\n...[truncated]` is exactly 8192 characters. Do not
  export the constant (`src/index.mjs` uses `export *`).

Call sites become `commandFailureDetail(err)` in place of
`err instanceof CommandError ? err.stderr.trim() : String(err)`. Keep each
site's `detail || "<generic>"`. The two `tag-verify.mjs` sites today fall
back to `err.message` rather than a generic; keep that local
`commandFailureDetail(err) || err.message` shape so GPG failures without
stream output stay as specific as they are now.

Do not inject spawn into `verify`. Helper unit tests cover stdout-only,
stderr-only, both streams (stderr wins), empty both, a selected detail
over the cap, and long stdout with non-empty stderr (stderr is used,
stdout is dropped, the cap applies to stderr). Tests assert helper
behavior (returned text, length, truncation marker) without importing the
private constant. The verify fixture test sets `release:verify` to a
one-liner that writes a unique token to stdout and exits 1, and keeps
npm from writing lifecycle stderr (for example `npm_config_loglevel=silent`)
so the captured `CommandError` is stdout-only. Assert the logged
`describeFailure` line still has `Checked: npm run release:verify` and
contains the token.

## Acceptance Criteria

- A `CommandError` with only stdout yields that trimmed stdout as the
  detail; only stderr yields that trimmed stderr; both streams non-empty
  yields trimmed stderr and drops stdout; both streams empty yields `""`.
- A selected detail longer than 8192 characters returns a string of
  length 8192 that ends with `\n...[truncated]`. Long stdout plus
  non-empty stderr still selects stderr and caps that stderr.
- `npm run release:verify` (and the other replaced command sites) put that
  detail in `found:`. A verify fixture whose script prints only to stdout
  then exits non-zero, with empty captured stderr, logs that stdout in
  `Found:` and keeps `Checked: npm run release:verify`.
- Empty captured streams still use each site's existing generic `found:`
  (verify: `the release:verify script failed`).
- `checked:` labels, corrections, exit codes, and spawn behavior are
  unchanged. `isNotFound` and other status classifiers still read
  `err.stderr` / `err.status` directly.
- `COMMAND_FAILURE_DETAIL_LIMIT` is not exported from `src/lib/errors.mjs`
  or the package entry.
- `CHANGELOG.md` `## [Unreleased]` records the fix. README states that
  command-failure `found:` prefers captured stderr and falls back to
  stdout, capped.

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

- Stderr-first preserves today's diagnostics when npm (or another wrapper)
  writes lifecycle text to stderr. Script stdout then stays hidden; that
  is the accepted tradeoff. The observed bug is empty stderr.
- A stdout-only fallback can still put a file diff into the job log. The
  8192-character returned-length cap is the mitigation; do not raise it
  without a new reason.
- `tag-verify.mjs` must keep its `err.message` fallback; using only the
  helper there would replace today's GPG message with a less specific
  generic if both streams are empty.
