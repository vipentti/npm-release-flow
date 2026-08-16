# Tasks: Richer verify failure feedback

- [x] T1 Add `commandFailureDetail` in `src/lib/errors.mjs` next to
      `describeFailure`. Keep `COMMAND_FAILURE_DETAIL_LIMIT` (8192) module-private;
      do not export it. Behavior: non-CommandError becomes `String(err)`;
      CommandError returns `stderr.trim() || stdout.trim()` (stderr wins when
      both are non-empty); empty both streams returns `""`; the selected
      detail is capped so the returned string, including `\n...[truncated]`,
      is at most 8192 characters. Cover in `test/errors.test.mjs` via the
      helper only (do not import the private constant): stdout-only,
      stderr-only, both streams (stderr used, stdout dropped), empty both,
      non-CommandError, selected detail longer than the limit, and long
      stdout plus non-empty stderr (stderr used and capped).
      Verify: `node --test test/errors.test.mjs` passes; `src/index.mjs`
      still re-exports the module and does not grow a named export for the
      limit.

- [x] T2 Wire `src/verify.mjs` through the helper at every
      `err.stderr.trim()` detail site (`npm ci`, `release:verify`,
      build-if-declared, `npm pack`, tarball extract, smoke install). Keep
      each site's `checked:` label and `detail || "<generic>"` fallback.
      Add a `test/verify.test.mjs` case: fixture `release:verify` prints a
      unique token to stdout and exits 1; keep npm lifecycle stderr empty
      (for example `npm_config_loglevel=silent`) so the captured error is
      stdout-only; logged failure still has `Checked: npm run release:verify`
      and contains the token.
      Verify: `node --test test/verify.test.mjs test/errors.test.mjs` passes.

- [x] T3 Replace the remaining stderr-only detail extractions that feed
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

- [x] T4 Record the change under `CHANGELOG.md` `## [Unreleased]`. Add a
      short README note (verify / command-failure section is enough) that
      `found:` prefers captured stderr and falls back to stdout, capped.
      No RELEASE.md change unless a sentence there already claims
      stderr-only behavior.
      Verify: `npm run lint`, `npm run format:check`, `npm run typecheck`,
      `npm run knip`, and `npm test` all pass.
