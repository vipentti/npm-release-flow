# Tasks: Richer verify failure feedback

- [ ] T1 Add `commandFailureDetail` and `COMMAND_FAILURE_DETAIL_LIMIT` (8192)
      in `src/lib/errors.mjs` next to `describeFailure`. Behavior: non-CommandError
      becomes `String(err)`; CommandError joins trimmed non-empty stdout then
      stderr with one newline; empty both streams returns `""`; joined text
      longer than the limit is sliced to 8192 characters plus `\n...[truncated]`.
      Cover in `test/errors.test.mjs`: stdout-only, stderr-only, both streams,
      empty both, non-CommandError, and a string longer than the limit.
      Verify: `node --test test/errors.test.mjs` passes; `src/index.mjs` still
      re-exports the module (no extra export line unless knip requires it).

- [ ] T2 Wire `src/verify.mjs` through the helper at every
      `err.stderr.trim()` detail site (`npm ci`, `release:verify`,
      build-if-declared, `npm pack`, tarball extract, smoke install). Keep
      each site's `checked:` label and `detail || "<generic>"` fallback.
      Add a `test/verify.test.mjs` case: fixture `release:verify` prints a
      unique token to stdout and exits 1; logged failure still has
      `Checked: npm run release:verify` and contains the token.
      Verify: `node --test test/verify.test.mjs test/errors.test.mjs` passes.

- [ ] T3 Replace the remaining stderr-only detail extractions that feed
      `found:` / mutation-error text:
      `src/detect.mjs`, `src/release.mjs`, `src/validate-artifact.mjs`,
      `src/commands/check.mjs`, `src/commands/prepare.mjs`,
      `src/commands/tag.mjs`, `src/lib/tag-verify.mjs`. Leave
      `revalidate.mjs` and status classifiers (`isNotFound`,
      `err.status === N` branches) unchanged. In `tag-verify.mjs` keep
      `commandFailureDetail(err) || err.message`.
      Verify: `rg "err\\.stderr\\.trim\\(\\)" src` shows no remaining
      detail-composition hits (classifiers that only test `err.stderr`
      for 404/status may remain); `npm test` still passes.

- [ ] T4 Record the change under `CHANGELOG.md` `## [Unreleased]`. Add a
      short README note (verify / command-failure section is enough) that
      `found:` includes captured stdout and stderr, capped. No RELEASE.md
      change unless a sentence there already claims stderr-only behavior.
      Verify: `npm run lint`, `npm run format:check`, `npm run typecheck`,
      `npm run knip`, and `npm test` all pass.
