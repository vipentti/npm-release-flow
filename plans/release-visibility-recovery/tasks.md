# Tasks: Release publish visibility recovery

- [ ] T1 npm shim scripting. In `test/helpers/fixture.mjs`, extend the
      npm fixture script: `hiddenViews` (after `publish`, the first
      `hiddenViews` `view` calls for the published `name@version` answer
      E404, then the manifest) and `publishFailure` (`{ status, stderr }`:
      `publish` prints `stderr` and exits `status` without recording the
      manifest). On success `publish` prints
      `Provenance statement published to transparency log: https://search.sigstore.dev/?logIndex=1`
      to stderr. Both fields default off, so existing state files behave
      as before.
      Verify: `node --test test/release.test.mjs` passes unchanged.

- [ ] T2 Backoff visibility wait. In `src/release.mjs` `publishRelease()`,
      replace the 30 x 2000 ms loop with the plan's schedule: poll
      immediately, then sleep `initialDelayMs` doubling up to
      `maxDelayMs` until summed sleep reaches `waitBudgetMs`, one final
      poll after the last sleep. Add the optional parameters
      `waitBudgetMs = 900_000`, `initialDelayMs = 2000`,
      `maxDelayMs = 30_000` and return `{ verified: true }` or
      `{ verified: false, polls, waitedMs }` (no throw on timeout). The
      first visible manifest still goes through the unchanged
      `publishedIdentityProblems()` verify (mismatch stays fatal). Existing
      present-path returns `{ verified: true }`. Add tests: default
      schedule is 34 polls over 900 000 ms with delays 2000, 4000, 8000,
      16000, then 30000; `hiddenViews: 5` verifies after 6 post-publish
      views with one publish; `hiddenViews` beyond the poll count returns
      `{ verified: false }`; a delayed manifest with a wrong
      `dist.integrity`, `repository.url`, or `gitHead` throws the
      "never publish a second tarball" failure.
      Verify: `node --test test/release.test.mjs` passes, including the
      new cases.

- [ ] T3 Non-fatal visibility in `release()`. Add the optional
      `publishWait` field to `ReleaseOptions` and pass it to
      `publishRelease()`. When the result is `{ verified: false }`, log
      that verification is pending, run Boundary 6 as today, then throw
      the plan's unverified `CliError` (Checked / Found with polls, seconds,
      and the finished boundaries / Correction naming the rerun). Add
      `release()`-level tests (gpg fixture, same skip rule as the happy
      path): never visible creates the GitHub Release with `--verify-tag`,
      runs `npm publish` once, exits 1 with the unverified message; a
      delayed identity mismatch exits 1 with no gh `release create` or
      `release edit` call.
      Verify: `node --test test/release.test.mjs` passes; the existing
      happy-path test still exits 0.

- [ ] T4 Publish-conflict convergence. In `publishRelease()`, when
      `npm publish` throws a `CommandError` whose captured stdout or
      stderr contains `cannot publish over the previously published versions`,
      log the refusal and run the same wait and verify: visible and
      matching returns `{ verified: true }`, visible and mismatching throws
      the existing failure, never visible throws a fatal `CliError` (no
      accepted publish in this run). Every other publish failure rethrows
      as today. Tests: conflict plus matching manifest (one publish call,
      verified), conflict plus mismatching manifest (fatal), conflict with
      no manifest (fatal; at the `release()` level no gh release call),
      E401-style failure (fatal, unchanged).
      Verify: `node --test test/release.test.mjs` passes.

- [ ] T5 Observability. After a successful `npm publish`, log
      `[release] npm accepted <name>@<version>` plus the transparency log
      URL when the captured output contains one; log one
      `not visible yet (poll <n>, <s> s waited, next in <d> s)` line per
      miss and `visible after <s> s; identity verified` on success after
      misses. `publishRelease()` takes a `log` sink (default
      `consoleLog`) passed from `release()`. Tests assert the accepted
      line with the shim's URL, the per-miss lines for `hiddenViews: 5`,
      and the verified line.
      Verify: `node --test test/release.test.mjs test/e2e.test.mjs`
      passes.

- [ ] T6 Docs and changelog. In `README.md` and `RELEASE.md`, add one
      short paragraph: the release job waits up to 15 minutes for the
      published version; if the registry is slower, the GitHub Release is
      still created and the job fails asking for one rerun, which verifies
      without publishing again. Add a `## [Unreleased]` `### Fixed` entry
      to `CHANGELOG.md`.
      Verify: `npm run format:check` passes; the entry sits under
      `## [Unreleased]`.

- [ ] T7 Full verification gate. Run `npm run release:verify`, then
      `planlet validate release-visibility-recovery`. Confirm with
      `git diff origin/main --stat` that `.github/workflows/` and
      `publishedIdentityProblems()` are unchanged and no new environment
      variable is read.
      Verify: all commands exit 0; the diff review holds.
