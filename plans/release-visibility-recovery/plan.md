# Release publish visibility recovery

## Summary

A release whose `npm publish` succeeded must not fail on the registry's
eventual consistency. Boundary 5 waits longer with bounded backoff; if an
accepted publish still is not visible, Boundary 6 runs anyway and the job
ends with a precise rerun-to-verify failure. Identity verification stays
exactly as strict as today, and no run ever publishes a second tarball.

Grounding: `origin/main` at commit
`aac74861b4e4c35ba8f8cf72fb2d46d0685aa4c6`.

## Motivation

The `@vipentti/planlet@0.8.0` release
(<https://github.com/vipentti/planlet/actions/runs/36298325561>, attempt 1,
job `108561293331`) pushed and verified the signed tag, then published, and
failed with:

```text
Checked: that the published version is visible in the packument. Found: @vipentti/planlet@0.8.0 did not appear within the visibility wait. Correction: inspect the registry state manually.
```

The job gave up at 05:52:08Z; `npm publish` had returned by about 05:51:08Z
(the failure followed 30 polls and 60 s of sleeps). The registry records
`time["0.8.0"] = 05:53:06.237Z` and packument `last-modified` 05:53:08, and
serves the packument with `cache-control: public, max-age=300` from an edge
cache. The version became readable roughly two minutes after publish, up to
five more with the edge cache. No GitHub Release was created; attempt 2
(release job 05:57Z) took the verify-or-idempotent path and finished.

Today, `publishRelease()` (`src/release.mjs:381`) publishes, then polls
`viewPublishedVersion()` (`npm view <name>@<version> --json --registry https://registry.npmjs.org`) 30 times, 2000 ms apart
(`src/release.mjs:444-460`), and throws on timeout, so `release()` exits 1
before `ensureGithubRelease()` (Boundary 6). `npm publish` output, including
its transparency log URL, is discarded.

## Scope

- `src/release.mjs`: `publishRelease()` wait, return value, publish-conflict
  branch, logging; `release()` handling of an unverified publish.
- `test/helpers/fixture.mjs` npm shim and `test/release.test.mjs`.
- `README.md`, `RELEASE.md`, `CHANGELOG.md` notes.

Out of scope: `.github/workflows/release.yml` (the release job has no
`timeout-minutes`), `pollGithubSignatureVerification()`,
`publishedIdentityProblems()`, and advancing the caller pin and
devDependency in consumer repositories (planlet, pi-session-clock, and this
kit's own caller) or any other consumer change.

## Approach

### Signals

- Accepted publish: `npm publish` exits 0. The registry accepted exactly the
  tarball at `PACKAGE_TARBALL`. Only this signal authorizes continuing past
  a visibility timeout.
- Verified publish: the manifest from the existing `viewPublishedVersion()`
  passes the unchanged `publishedIdentityProblems()` (name, version,
  repository, integrity, gitHead). Job success still requires it.

### Wait

- Exported pure helper `visibilityDelays({ waitBudgetMs, initialDelayMs, maxDelayMs })` returns the sleep list: `delay_k = min(initialDelayMs * 2^k, maxDelayMs, remaining budget)`, appended while budget remains, so the
  final delay is clamped and the list sums to exactly `waitBudgetMs`.
  Defaults 900 000 / 2000 / 30 000 give 2000, 4000, 8000, 16000, then
  29 x 30000.
- Poll once right after publish and once after each delay (34 polls by
  default). The budget is 15 minutes of sleep; `npm view` request time adds
  on top, so wall-clock time is 15 minutes plus registry request time.
- 15 minutes is about twice the observed worst case (two minute registry
  write plus five minute edge cache); the doubling-to-30 s shape verifies
  fast registries in seconds without hundreds of polls.
- `publishRelease()` takes optional `waitBudgetMs`, `initialDelayMs`,
  `maxDelayMs` (defaults above), and `log` (default `consoleLog`).
  `ReleaseOptions` gains
  `publishWait?: { waitBudgetMs?: number, initialDelayMs?: number, maxDelayMs?: number }`;
  `release()` calls `publishRelease({ ..., log, ...options.publishWait })`.
  The workflow never sets it; no new environment variable.

### Outcomes

`publishRelease()` returns `{ verified: true }` or
`{ verified: false, polls, waitedMs }`:

- Present at the first view (rerun path): verify as today.
- Accepted, then visible: verify; a mismatch throws the existing "never
  publish a second tarball" failure before Boundary 6.
- Accepted, never visible: `{ verified: false }`. `release()` runs the
  unchanged `ensureGithubRelease()` (create with `--verify-tag`, or edit an
  existing release as today), then throws a `CliError` whose Found names
  the poll count, waited seconds, and completed boundaries, and whose
  Correction says to re-run the release job, which verifies without
  publishing again. Exit 1.
- Publish conflict: a rerun inside the latency window sees "absent" and
  `npm publish` fails with the registry's
  `cannot publish over the previously published versions` text. Run the
  same wait and verify: matching is `{ verified: true }`, mismatching is
  fatal, never visible is fatal before Boundary 6 (this run has no accepted
  publish). Any other publish failure stays fatal as today.

`npm publish` runs at most once per run and never after a manifest was
seen. Every other existing failure (newer stable version, malformed or
failing `npm view`, Boundary 4 and 6 errors) is unchanged.

### Observability

Log the accepted publish with npm's transparency log URL when present
(`https://search.sigstore.dev/?logIndex=<n>`), one line per missed poll
(poll number, waited seconds, next delay; the final miss says it was the
last), the verified outcome with elapsed seconds, and the publish-conflict
refusal.

### 0.8.0 after the change

The version is readable by about 05:58Z at worst, inside the budget: the
identity verify passes, `Release v0.8.0` is created, exit 0, one run. Past
the budget, the GitHub Release would still exist and the failure would ask
for the one rerun that verifies.

### Rejected alternatives

- Longer packument polling alone: a slower registry still skips an
  independent boundary.
- Polling the version document or attestations endpoint: avoids the edge
  cache but not the registry write delay that dominated 0.8.0, and adds a
  registry client outside npm's config, proxy, and CA handling.
- Succeeding with a warning: job success would stop implying verified
  identity.
- Retrying `npm publish`: no gain; one publish per run stays the rule.

### Release path

The kit releases through its own flow: the self-release caller is pinned
to an older kit, so this fix's own release still uses the 30 x 2 s wait (a
rerun recovers it if it trips). Consumers and the kit's caller pick up the
fix only after ordinary upgrade PRs advance the caller pin and
devDependency, out of scope here.

## Acceptance Criteria

- An accepted publish that becomes visible within the budget verifies
  identity, reaches Boundary 6, and exits 0.
- An accepted publish that never becomes visible still runs
  `ensureGithubRelease()` (create or edit, unchanged), runs `npm publish`
  once, and exits 1 with the unverified message.
- A visible identity mismatch after publish or after a conflict fails with
  the existing message and no GitHub Release call.
- A publish conflict converges to verified when the version matches and is
  fatal before Boundary 6 when it never appears; other publish failures fail
  as today.
- The idempotent rerun path is unchanged.
- On every path, recorded npm calls show at most one `publish` and no
  `publish` after any `view` returned a manifest: already-visible rerun
  (zero), delayed-visible, timeout, conflict-match, conflict-mismatch, and
  conflict-timeout (one each).
- Logs carry the accepted publish (with transparency log URL), each miss,
  and the verify outcome.
- The workflow, `publishedIdentityProblems()`, and the set of environment
  keys `src/release.mjs` reads are unchanged.

## Verification

- Pure unit test of `visibilityDelays()` for the default schedule and a
  clamped non-multiple budget; no fake timers.
- npm shim contract: `publishManifest` is never served before a `publish`
  invocation; any `publish` invocation, successful or failing, arms it;
  after arming, `hiddenViews` (default 0) views answer E404, then the
  manifest; `publishFailure` (`{ status, stderr }`) makes `publish` fail
  after arming; successful `publish` prints a transparency log URL.
  Existing state files behave as today.
- `publishRelease()` and `release()` tests with small millisecond values
  for the three `publishWait` fields cover each Outcome and each acceptance
  criterion, and every one asserts the recorded `publish` count and that no
  `publish` follows a manifest-returning `view` in the shim call log; `release()`-level cases
  use the gpg fixture with the happy path's skip rule, and the gh shim's
  `releases` state for the edit case.
- Final gate: `npm run release:verify`, `planlet validate release-visibility-recovery`, an empty
  `git diff origin/main -- .github/workflows`, an unchanged
  `publishedIdentityProblems()` body, and a full review of the `src/` diff
  confirming `src/release.mjs` reads only its seven existing environment
  keys (`VERSION`, `GITHUB_SHA`, `GITHUB_REPOSITORY`,
  `NPM_RELEASE_FLOW_GPG_FINGERPRINT`, `TAG_EXISTS`,
  `NPM_RELEASE_FLOW_APP_TOKEN`, `PACKAGE_TARBALL`) in any access form and
  no `src/lib/` file adds one.
- External gate: CI on the implementation PR; the real registry wait runs
  only in the next consumer release on an advanced pin.

## Risks and Considerations

- Conflict detection matches registry wording; if the wording changes the
  branch stops matching and today's fatal behaviour returns.
- On the unverified path the GitHub Release exists before identity is
  verified. It references only the verified tag and changelog notes, and
  the job stays red until a rerun verifies.
- A stuck registry now holds the job about 15 minutes of sleep plus request
  time, versus about one minute today.
