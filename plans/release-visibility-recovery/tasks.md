# Tasks: Release publish visibility recovery

- [x] T1 Extend the npm shim with the plan's `publishManifest` arming,
      `hiddenViews`, `publishFailure`, and transparency log output.
      Verify: `node --test test/release.test.mjs` passes unchanged.
- [ ] T2 Replace the fixed visibility loop with `visibilityDelays()` backoff
      and the `{ verified }` result, identity verify unchanged.
      Verify: `node --test test/release.test.mjs`.
- [ ] T3 Make an unverified accepted publish run Boundary 6, then fail with
      the rerun-to-verify message. Verify: `node --test test/release.test.mjs`.
- [ ] T4 Add the plan's publish and wait logging through a `log` sink
      forwarded from `release()`. Verify: `node --test test/release.test.mjs`.
- [ ] T5 Converge a publish conflict through the same wait and verify; other
      publish failures unchanged. Verify: `node --test test/release.test.mjs`.
- [ ] T6 Document the wait and rerun-to-verify outcome in `README.md` and
      `RELEASE.md`, with a `CHANGELOG.md` `## [Unreleased]` entry.
      Verify: `npm run format:check`.
- [ ] T7 Run the final gate from the plan's Verification section.
