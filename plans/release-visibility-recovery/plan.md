# Release publish visibility recovery

## Summary

A real consumer release failed in the release job after `npm publish` had
already succeeded, because the post-publish packument visibility wait (30
polls, 2 s apart) ran out before the registry served the new version. The
GitHub Release boundary never ran; a workflow rerun recovered it. This
planlet makes Boundary 5 wait long enough for the observed registry
latency (bounded exponential backoff, 15 minute budget), makes a
visibility timeout after an accepted publish non-fatal for the rest of the
release (Boundary 6 still runs, then the job fails with a precise
rerun-to-verify message), converges a rerun that races the same latency,
and leaves identity verification exactly as strict as today.

Grounding: `origin/main` at commit
`aac74861b4e4c35ba8f8cf72fb2d46d0685aa4c6`. Every file and line reference
below resolves at that commit.

## Motivation

Evidence, from the `vipentti/planlet` release run
<https://github.com/vipentti/planlet/actions/runs/36298325561> (attempt 1,
job `108561293331`, release `@vipentti/planlet@0.8.0`, triggering commit
`c88e868a`). The release step log, verbatim (timestamps UTC):

```text
05:50:50.43 [release] version 0.8.0 at c88e868a (tag-exists=false)
05:50:53.22 [release] tag v0.8.0 created, verified, and pushed
05:50:53.81 [release] GitHub reports the tag signature verified
05:52:08.15 Checked: that the published version is visible in the packument. Found: @vipentti/planlet@0.8.0 did not appear within the visibility wait. Correction: inspect the registry state manually.
05:52:08.15 ##[error]Process completed with exit code 1.
```

- Boundary 4 (signed tag create, verify, push, GitHub signature poll)
  completed. Boundary 5 published: the registry holds `0.8.0` today and
  the rerun did not publish again.
- The 74 s between the signature line and the failure hold one
  `npm publish`, 32 `npm view` calls and 60 s of sleeps, so `npm publish`
  returned no later than about 05:51:08.
- The registry's own record puts the version's arrival later than the
  whole wait: `npm view @vipentti/planlet time` reports
  `"0.8.0": "2026-09-27T05:53:06.237Z"` and the packument carries
  `last-modified: Sun, 27 Sep 2026 05:53:08 GMT`. The version entered the
  packument about two minutes after `npm publish` returned and about one
  minute after the job gave up.
- The packument is additionally edge-cached: its response carries
  `cache-control: public, max-age=300` and `cf-cache-status: HIT`, so a
  reader can see a packument up to five minutes older than the registry's
  write. `npm view` already passes `preferOnline` (npm 11
  `lib/commands/view.js`), so the local npm cache is not the problem; the
  delay is registry-side.
- Attempt 2 of the same run re-ran detect, verify, and release at
  05:55-05:57; its release job took the verify-or-idempotent path
  (version present, identity verified, no publish) and created the GitHub
  Release. The kit's idempotency made recovery clean, but only after a
  red run and a manual rerun.

The 60 s wait is shorter than one observed registry write delay, and the
failure aborts the one boundary that does not depend on the registry at
all.

## Current behaviour (exact code path)

`release()` (`src/release.mjs:523`) runs Boundary 4, then
`publishRelease()` (`src/release.mjs:381`), then Boundary 6
`ensureGithubRelease()` (`src/release.mjs:471`). Any throw returns exit 1
before Boundary 6.

`publishRelease()`:

1. `viewPublishedVersion()` (`src/release.mjs:267`) runs
   `npm view <name>@<version> --json --registry https://registry.npmjs.org`;
   exit status 1 means absent (`null`), other failures throw.
2. Present: `publishedIdentityProblems()` (`src/release.mjs:329`: name,
   version, `repository.url`, `dist.integrity` equals the packed tarball's
   integrity, `gitHead` when present). Any problem throws "never publish a
   second tarball over it". Otherwise return (idempotent rerun path).
3. Absent: `newerStableExists()` refuses when a newer stable version is on
   the registry.
4. `npm publish <tarball> --ignore-scripts --access public --provenance --registry https://registry.npmjs.org`
   through `runSync`. Its captured
   stdout and stderr (including npm's
   `Provenance statement published to transparency log: <url>` notice) are
   discarded on success; a non-zero exit throws `CommandError`, which
   `release()` reports through its generic catch.
5. Visibility loop (`src/release.mjs:444-460`): up to 30 `npm view`
   polls with a fixed 2000 ms sleep after each miss; the first visible
   manifest goes through the same identity verify; after 30 misses it
   throws the `Checked: that the published version is visible in the packument`
   failure seen above.

## Scope

What changes:

- `src/release.mjs`: `publishRelease()` visibility wait, its return value,
  the publish-conflict branch, publish observability; `release()`
  ordering around Boundary 6 and the final unverified failure.
- `test/helpers/fixture.mjs`: the npm shim gains delayed visibility and a
  scripted publish failure.
- `test/release.test.mjs`: new cases (Test plan below).
- `README.md` / `RELEASE.md`: one short paragraph on the wait and the
  rerun-to-verify outcome; `CHANGELOG.md` `## [Unreleased]` entry.

## Out of Scope

- Advancing the caller pin and the `@vipentti/npm-release-flow`
  devDependency in consumer repositories (planlet, pi-session-clock, and
  this kit's own `self-release.yml` plus README caller example), and any
  other change to consumer repositories. Those follow in ordinary upgrade
  PRs after this fix is released.
- `.github/workflows/release.yml`: the release job has no
  `timeout-minutes`, so the runner default (360 minutes) already covers
  the longer wait; no workflow change is needed.
- `pollGithubSignatureVerification()`: same 30 x 2 s shape, but it has
  not failed and a GitHub API read is not the eventually consistent
  registry; leave it.
- Any change to `publishedIdentityProblems()` or to what counts as a
  matching published artifact.

## Approach

### Signals and what each proves

- **Accepted publish:** `npm publish` exiting 0. The registry answered the
  upload PUT with success, for exactly the tarball at `PACKAGE_TARBALL`
  (the same file whose integrity the kit verifies), with provenance signed
  and logged. This is authoritative and is the only signal that authorizes
  continuing past a visibility timeout.
- **Verified publish:** the registry's manifest for `<name>@<version>`
  (via the existing `viewPublishedVersion()`) passing
  `publishedIdentityProblems()`. Job success keeps requiring this, as
  today.

### Visibility wait

- Keep `viewPublishedVersion()` (the packument through `npm view`, registry
  pinned) as the poll. It is the same read and the same identity fields the
  idempotent rerun path uses, so a successful wait and a successful rerun
  prove the same thing.
- Delay schedule: first poll immediately after publish, then sleep
  2 s, 4 s, 8 s, 16 s, then 30 s per miss (doubling, capped at 30 s), until
  the summed sleep reaches the 15 minute budget (900 000 ms); one final
  poll follows the last sleep. That is 34 polls at most. The budget is
  counted as summed scheduled sleep, not wall clock, so it is
  deterministic in tests; real `npm view` time adds on top.
- Why 15 minutes: the observed worst case is the registry write about two
  minutes after `npm publish` returned plus up to five minutes of edge
  cache, about seven minutes. Fifteen minutes is roughly twice that.
  The job holds no scarce resource while waiting (no timeout configured;
  the Environment approval is already spent).
- Why doubling to a 30 s cap: fast registries still verify within
  seconds, and the long tail costs about 30 polls instead of 450.
- `publishRelease()` gains optional `waitBudgetMs = 900_000`,
  `initialDelayMs = 2000`, `maxDelayMs = 30_000` parameters, the same
  injection style as `pollGithubSignatureVerification({ attempts, delayMs })`. `release()` accepts an optional `publishWait` object in
  `ReleaseOptions` (alongside `cwd`, `env`, `log`) and passes it through;
  the workflow never sets it. No new environment variable.

### Outcomes after an accepted publish

`publishRelease()` returns `{ verified: true }` or
`{ verified: false, polls, waitedMs }` instead of `void`:

- Visible and matching: `{ verified: true }`; release continues as today.
- Visible and mismatching (name, version, repository, integrity, gitHead):
  throw the existing "never publish a second tarball over it" failure.
  Still fatal, still before Boundary 6.
- Never visible within the budget: return `{ verified: false, ... }`.
  `release()` logs that verification is pending, runs Boundary 6
  (`ensureGithubRelease()`, `--verify-tag` against the already verified
  tag), then throws a `CliError`:

  ```text
  Checked: that the published <name>@<version> is visible on https://registry.npmjs.org and matches the verified tarball.
  Found: npm publish succeeded, but the version did not appear after <polls> polls over <seconds> s; the tag and GitHub Release v<version> are complete; the published identity is not yet verified.
  Correction: re-run the failed release job once the version is visible; the rerun verifies the published version and never publishes again.
  ```

  Exit 1. The run is red only to demand the identity check that has not
  happened yet; every mutation is done.

### Rerun racing the same latency (publish conflict)

A rerun that starts while the packument still hides the version sees
"absent", passes `newerStableExists()`, and calls `npm publish`, which the
registry rejects (`E403 ... You cannot publish over the previously
published versions`). No second tarball can be published, but today the
rerun fails with a raw `CommandError`.

New branch: when `npm publish` fails and its captured output contains
`cannot publish over the previously published versions`, run the same
visibility wait and identity verify. Visible and matching: treat as the
idempotent path (return `{ verified: true }`). Visible and mismatching:
the existing fatal failure. Not visible within the budget: fatal before
Boundary 6 (this run did not publish, so it has no accepted-publish proof
that the hidden version is its tarball). Any other publish failure stays
fatal exactly as today.

### Stays fatal (unchanged or tightened)

- Every `publishedIdentityProblems()` mismatch, on the idempotent path,
  after a new publish, and after a publish conflict. Nothing on any path
  publishes a second time: `npm publish` is invoked at most once per run,
  and never after a manifest has been seen.
- `newerStableExists()` refusal; malformed `npm view` JSON; `npm view`
  failures other than exit 1; `npm publish` failures other than the
  publish conflict.
- A publish conflict whose version never becomes visible.
- Boundary 6 failures; Boundary 4 failures (unchanged).

### Observability

`publishRelease()` takes a `log` sink (default `consoleLog`), passed from
`release()`.

- After a successful publish, log `[release] npm accepted <name>@<version>`
  plus the transparency log URL when npm printed one (matched as
  `https://search.sigstore.dev/?logIndex=<n>` in the captured output).
- One line per missed poll:
  `[release] <name>@<version> not visible yet (poll <n>, <s> s waited, next in <d> s)`.
- On success after misses: `[release] <name>@<version> visible after <s> s; identity verified`.
- On a publish conflict: log that the registry refused a second publish and
  the wait starts.
- The final unverified failure (above) names the poll count, waited
  seconds, and the finished boundaries.

### The 0.8.0 failure, today versus after

- Today: publish returns by about 05:51:08, 30 polls end at 05:52:08,
  exit 1, no GitHub Release; manual rerun at 05:55 recovers.
- After: publish returns, polls back off to 30 s steps; the version lands
  in the registry at 05:53:06 and, even with the full five minute edge
  cache, is served by about 05:58:08, well inside the 15 minute budget.
  The identity verify passes, Boundary 6 creates `Release v0.8.0`, exit 0,
  one green run. Had the registry been slower than 15 minutes, the GitHub
  Release would still exist and the failure would name the single rerun
  that finishes verification.

### Rejected alternatives

- **Longer packument polling alone** (keep the throw on timeout): fixes
  0.8.0 but keeps the design flaw that a registry delay skips an
  independent boundary; a slower day repeats the incident.
- **Poll the version document** (`GET /<name>/<version>`, served
  `cf-cache-status: DYNAMIC`) **or the attestations endpoint**
  (`/-/npm/v1/attestations/<name>@<version>`): avoids the edge cache but
  not the registry write delay that dominated 0.8.0, adds a second registry
  client outside npm's config, proxy, and CA handling, and needs an HTTP
  test seam. Attestation parsing would re-derive identity from DSSE
  payloads that `publishedIdentityProblems()` already checks from the
  manifest.
- **Succeed with a warning when not visible:** job success would stop
  implying a verified identity and nothing would ever run the check.
- **Retry `npm publish`:** could never publish different bytes, but it
  multiplies the conflict path for no gain; one publish per run stays the
  rule.

## Release path of this fix

The kit releases through its own flow: a `prepare` release PR, the
self-release caller (`.github/workflows/self-release.yml`, pinned to
`e2e32a756c374d62f35e460cc4020b071d449750`), which runs the pinned, older
`release.mjs`. The kit's own release of this fix therefore still uses the
30 x 2 s wait; if it trips, the documented rerun recovers it. Consumers
(and the kit's own caller) get the new behaviour only after their caller
pin and devDependency advance in ordinary upgrade PRs, out of scope here.

## Acceptance Criteria

- An accepted publish whose version becomes visible anywhere inside the
  15 minute budget verifies identity and reaches Boundary 6; exit 0.
- An accepted publish whose version never becomes visible still creates or
  edits the GitHub Release with `--verify-tag`, then exits 1 with the
  unverified message; `npm publish` ran exactly once.
- A visible mismatch (integrity, repository, or gitHead) after publish
  fails with the existing "never publish a second tarball" message and no
  GitHub Release call.
- A publish conflict with a matching visible version exits 0 with one
  publish attempt; with a mismatching one fails hard; with no visible
  version fails before Boundary 6.
- Non-conflict publish failures fail as today, before Boundary 6.
- The idempotent rerun path (version present at the first view) is
  unchanged: no publish, identity verified.
- Logs show the accepted publish (with transparency log URL when present),
  each missed poll, and the verify outcome.
- No new environment variable, no workflow change, no change to
  `publishedIdentityProblems()`.

## Verification

- Per task: `node --test test/release.test.mjs` (plus
  `test/e2e.test.mjs` where release flow output is asserted).
- Before checking the last task: `npm run release:verify` (lint,
  format:check, typecheck, knip, test).
- `planlet validate release-visibility-recovery` after any plan or task
  edit.
- External gate: CI on the implementation PR. The real registry wait is
  only exercised by the next consumer release on an advanced pin.

## Test plan

All cases use the npm PATH shim with millisecond-scale `publishWait`
values; nothing touches the network.

- Shim: `hiddenViews` (number of post-publish `view` calls for the
  published key that still answer E404) and `publishFailure`
  (`{ status, stderr }` returned by `publish` instead of success). Existing
  state files keep working (both default off).
- Schedule: default parameters yield 34 polls and 900 000 ms of summed
  sleep with delays 2000, 4000, 8000, 16000, then 30000; small injected
  values keep the doubling-and-cap shape.
- Retry: `hiddenViews: 5` resolves `{ verified: true }` after 6
  post-publish views, one publish, and logs five "not visible yet" lines.
- Non-fatal visibility: `hiddenViews` above the poll count returns
  `{ verified: false }` without throwing; at the `release()` level (gpg
  fixture, same skip rule as the happy path) the gh shim records
  `release create ... --verify-tag`, the exit code is 1, and the log
  contains the unverified message.
- Still-fatal identity: after a delayed visibility, a published manifest
  with a wrong `dist.integrity`, `repository.url`, or `gitHead` throws the
  "never publish a second tarball" failure; at the `release()` level no
  gh `release create` or `release edit` call is recorded.
- Publish conflict: `publishFailure` with the registry's conflict text plus
  a matching manifest verifies with exactly one publish call; with a
  mismatching manifest fails hard; with no manifest fails with no GitHub
  Release call. A `publishFailure` with other text (for example E401)
  fails as today.
- Observability: the transparency log URL printed by the shim's `publish`
  appears in the log.
- Existing `publishRelease` and `release` tests keep passing unmodified
  except for the new return value.

## Risks and Considerations

- Matching the conflict by message text couples to the registry wording;
  on a wording change the branch simply stops matching and the old fatal
  behaviour returns, so the failure mode is safe.
- The unverified path creates the GitHub Release before identity is
  verified. The release entry references only the verified tag and the
  changelog notes, never the npm artifact, and a mismatch after an accepted
  publish of the verified tarball would already need manual registry work
  today; the job still fails until verification passes.
- A 15 minute worst case lengthens a genuinely stuck registry run by
  about 14 minutes versus today. Acceptable against a red release.
