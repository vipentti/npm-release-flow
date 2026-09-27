# Tasks: Release publish visibility recovery

- [x] T1 Extend the npm shim with the plan's `publishManifest` arming,
      `hiddenViews`, `publishFailure`, and transparency log output.
      Verify: `node --test test/release.test.mjs` passes unchanged.
- [x] T2 Replace the fixed visibility loop with `visibilityDelays()` backoff
      and the `{ verified }` result, identity verify unchanged.
      Verify: `node --test test/release.test.mjs`.
- [x] T3 Make an unverified accepted publish run Boundary 6, then fail with
      the rerun-to-verify message. Verify: `node --test test/release.test.mjs`.
- [x] T4 Add the plan's publish and wait logging through a `log` sink
      forwarded from `release()`. Verify: `node --test test/release.test.mjs`.
- [x] T5 Converge a publish conflict through the same wait and verify; other
      publish failures unchanged. Verify: `node --test test/release.test.mjs`.
- [x] T6 Document the wait and rerun-to-verify outcome in `README.md` and
      `RELEASE.md`, with a `CHANGELOG.md` `## [Unreleased]` entry.
      Verify: `npm run format:check`.
- [x] T7 Run the final gate from the plan's Verification section.

## Verification Evidence

- 2026-09-27, this sandbox: `npm run release:verify` fails its `npm test`
  step with 7 failures in `test/verify.test.mjs` and `test/e2e.test.mjs`
  (concurrent `npm ci` / `npm pack` cache contention; the same 7 failures
  reproduce on `698505e` with this planlet's changes stashed, and the whole
  suite passes with `node --test --test-concurrency=1`). Lint, format:check,
  typecheck, knip, `planlet validate`, the empty
  `git diff origin/main -- .github/workflows`, the byte-identical
  `publishedIdentityProblems()` body, and the seven-key environment audit of
  `src/release.mjs` all passed. The authoritative green run is CI on the
  implementation PR.

## Completion

- Completed at: 2026-09-27T07:22:12.250Z
- Mode: normal
