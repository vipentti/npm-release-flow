# Tasks: Release publish visibility recovery

- [ ] T1 npm shim scripting. In `test/helpers/fixture.mjs`, implement the
      plan's single shim contract: `publishManifest` is never served
      before a `publish` invocation; any `publish` invocation (successful
      or failing) arms it; after arming, the next `hiddenViews` (default 0)
      `view` calls for `publishName@publishVersion` answer E404, then the
      manifest is returned; `publishFailure` (`{ status, stderr }`,
      default absent) makes `publish` print `stderr` and exit `status`
      after arming; no `publishManifest` means nothing is ever served. On
      success `publish` prints
      `Provenance statement published to transparency log: https://search.sigstore.dev/?logIndex=1`
      to stderr. Existing state files behave as before.
      Verify: `node --test test/release.test.mjs` passes unchanged.

- [ ] T2 Backoff visibility wait. In `src/release.mjs`, add the exported
      pure helper `visibilityDelays({ waitBudgetMs, initialDelayMs,
maxDelayMs })` with the plan's arithmetic (doubling, capped at
      `maxDelayMs`, final delay clamped to the remaining budget, sum equals
      `waitBudgetMs`). In `publishRelease()`, replace the 30 x 2000 ms
      loop: poll once immediately, then sleep each helper delay and poll
      again (polls = delays + 1). Add optional parameters
      `waitBudgetMs = 900_000`, `initialDelayMs = 2000`,
      `maxDelayMs = 30_000`; return `{ verified: true }` or
      `{ verified: false, polls, waitedMs }` (no throw on timeout). The
      first visible manifest still goes through the unchanged
      `publishedIdentityProblems()` verify (mismatch stays fatal); the
      present path returns `{ verified: true }`. Tests: default helper
      output is 2000, 4000, 8000, 16000, then 29 x 30000 (33 entries, sum
      900 000); budget 10 / initial 1 / max 4 gives 1, 2, 4, 3;
      `hiddenViews: 5` verifies after 6 post-publish views with one
      publish; `hiddenViews` beyond the poll count returns
      `{ verified: false }`; a delayed manifest with a wrong
      `dist.integrity`, `repository.url`, or `gitHead` throws the "never
      publish a second tarball" failure.
      Verify: `node --test test/release.test.mjs` passes, including the
      new cases.

- [ ] T3 Non-fatal visibility in `release()`. Add the optional
      `publishWait` field to `ReleaseOptions` and pass it to
      `publishRelease()`. When the result is `{ verified: false }`, log
      that verification is pending, run the unchanged
      `ensureGithubRelease()`, then throw the plan's unverified `CliError`
      (Checked / Found with polls, seconds, and the finished boundaries /
      Correction naming the rerun). `release()`-level tests (gpg fixture,
      same skip rule as the happy path): never visible with no existing
      release records `release create ... --verify-tag`, one
      `npm publish`, exit 1 with the unverified message; never visible
      with `setGhRepoState(fixture, { releases: { "v1.2.2": true } })`
      records `release edit` and no `create`, then exit 1; a delayed
      identity mismatch exits 1 with no gh `release create` or
      `release edit` call.
      Verify: `node --test test/release.test.mjs` passes; the existing
      happy-path test still exits 0.

- [ ] T4 Observability. `publishRelease()` takes a `log` sink (default
      `consoleLog`) passed from `release()`. After a successful
      `npm publish`, log `[release] npm accepted <name>@<version>` plus
      the transparency log URL when the captured output contains one
      (`https://search.sigstore.dev/?logIndex=<n>`). Log
      `not visible yet (poll <n>, <s> s waited, next in <d> s)` for each
      missed poll followed by a sleep, `not visible after <n> polls, <s> s waited`
      for the final missed poll, and `visible after <s> s; identity verified`
      on success after misses. Tests assert the accepted line with the
      shim's URL, five per-miss lines plus the verified line for
      `hiddenViews: 5`, and the final-miss line on timeout.
      Verify: `node --test test/release.test.mjs test/e2e.test.mjs`
      passes.

- [ ] T5 Publish-conflict convergence. In `publishRelease()`, when
      `npm publish` throws a `CommandError` whose captured stdout or
      stderr contains `cannot publish over the previously published versions`,
      log the refusal through the T4 sink and run the same wait and
      verify: visible and matching returns `{ verified: true }`, visible
      and mismatching throws the existing failure, never visible throws a
      fatal `CliError` (no accepted publish in this run). Every other
      publish failure rethrows as today. Tests, using the plan's conflict
      `publishFailure`: matching `publishManifest` with `hiddenViews: 2`
      (one publish call, verified); wrong `dist.integrity` (fatal, existing
      message); no `publishManifest` (fatal; at the `release()` level no gh
      `release create` or `release edit` call); `npm error code E401`
      text (fatal, unchanged).
      Verify: `node --test test/release.test.mjs` passes.

- [ ] T6 Docs and changelog. In `README.md` and `RELEASE.md`, add one
      short paragraph: the release job waits up to 15 minutes for the
      published version; if the registry is slower, the GitHub Release is
      still created or updated and the job fails asking for one rerun,
      which verifies without publishing again. Add a `## [Unreleased]`
      `### Fixed` entry to `CHANGELOG.md`.
      Verify: `npm run format:check` passes; the entry sits under
      `## [Unreleased]`.

- [ ] T7 Full verification gate. Run `npm run release:verify` and
      `planlet validate release-visibility-recovery`. Scope invariants,
      each checked mechanically:
      `git diff --exit-code origin/main -- .github/workflows` (no workflow
      change);
      `diff <(git show origin/main:src/release.mjs | sed -n '/^export function publishedIdentityProblems/,/^}/p') <(sed -n '/^export function publishedIdentityProblems/,/^}/p' src/release.mjs)`
      (identity verify unchanged);
      `git diff origin/main -- src | grep '^+' | grep -E 'env\.[A-Z_]|env\[|process\.env'`
      returns nothing (no new environment read). `git diff origin/main --stat`
      for the scope overview only.
      Verify: every command above exits as stated (0, or no output for the
      grep).
