# Move the kit checkout outside the consumer worktree

## Summary

The reusable release workflow currently checks the kit into
`.npm-release-flow/` inside the consumer tree. Consumer tooling scans the
vendored directory: knip flagged 21 kit-internal files plus the
`createAndPushTag` export as unused, failing `release:verify`. Relocate the
per-job kit checkout to `$RUNNER_TEMP/npm-release-flow-kit` via
checkout-then-mv, invoke the workflow scripts from that absolute path, and
have the two kit version reads find the kit's own `package.json` via
`import.meta.url` module-relative resolution (no new env contract). The
ephemeral pack and artifact dirs stay at their existing locations.

## Motivation

- The vendored checkout pollutes every consumer's tree: any tool with a
  broad glob (knip default project, eslint flat config, prettier,
  `git status`, `git add .`) can trip over `.npm-release-flow`. The
  incident is real and hits every consumer.
- Nothing requires the kit inside the consumer tree. Only two cwd-relative
  reads exist (`src/detect.mjs:212`, `src/verify.mjs:88`). Kit scripts
  resolve their imports file-relative via `import.meta.url`, so
  absolute-path invocation works from anywhere.
- The kit already knows its own location: `src/commands/prepare.mjs`
  derives the kit root from `import.meta.url`. Reusing that pattern means
  the kit needs no path env var, no fallback branching, and no consumer
  wiring.
- `actions/checkout` forbids `path:` outside `GITHUB_WORKSPACE` (verified
  `input-helper.ts` guard), so relocation needs checkout-then-mv.

## Scope

What changes:

- Workflow (`.github/workflows/release.yml`): relocate step in the detect,
  verify, and release jobs; six node invocations run from
  `${{ runner.temp }}/npm-release-flow-kit/src/`.
- Kit code: `src/detect.mjs` and `src/verify.mjs` resolve the kit's
  `package.json` relative to their own module location (the
  `prepare.mjs` pattern); `src/lib/run-script.mjs` comment.
- Tests: fixture drops the vendored `.npm-release-flow` dir; detect and
  verify tests assert against the running kit's own version;
  `script-entry` workflow regex.
- Docs plus kit configs: `.gitignore`, `knip.json`, `eslint.config.mjs`
  ignores for the vendored dir; README/RELEASE exclusion contract for
  `.npm-release-flow/`; `CHANGELOG.md` entry.

## Out of Scope

- Any new env contract (`NPM_RELEASE_FLOW_KIT`,
  `NPM_RELEASE_FLOW_PACK_DIR`): the kit locates itself via
  `import.meta.url`.
- Relocating `.npm-release-flow-pack` and `.npm-release-flow-artifact`:
  the pack dir appears only after `npm ci`, `release:verify`, and the
  optional build finish, and the artifact dir exists only in the protected
  release job, which runs no consumer code. Neither causes consumer-tool
  scanning failures; both stay at their existing locations.
- Manual `git clone` to temp instead of checkout-then-mv (loses the action
  pin and token handling).
- Sibling `../` placement via `actions/checkout` `path:` (blocked by the
  checkout guard).
- Dedicated kit artifact job (extra latency, version-skew risk).
- Changes to `self-release.yml` (thin caller; advances pin on next
  release).
- Behavior of `validate-artifact.mjs`, `revalidate.mjs`, `release.mjs`
  (already location agnostic).

## Approach

Adopted decisions from the scouting investigation (2026-08-16), revised
after review:

1. Outside-worktree elimination, not docs-only exclusion.
2. `$RUNNER_TEMP/npm-release-flow-kit` via checkout-then-mv. No env var:
   the kit finds its own `package.json` through `import.meta.url`, and the
   workflow invokes scripts from the absolute temp path directly.
3. Ephemeral pack and artifact dirs stay at their existing locations
   (scope cut).
4. Fallback exclusion docs ship regardless, as defense in depth, scoped to
   `.npm-release-flow/`.

### Kit code (ships first; works from any location)

- `src/detect.mjs` and `src/verify.mjs` resolve the kit `package.json`
  relative to the script's own module location, the same pattern as
  `src/commands/prepare.mjs`:
  `const moduleDir = dirname(fileURLToPath(import.meta.url));` then
  `resolve(moduleDir, "..", "package.json")` (both scripts live in
  `src/`). The read is location-agnostic: it works whether the checkout
  sits at the legacy `.npm-release-flow` path or at
  `$RUNNER_TEMP/npm-release-flow-kit`, because the running script is the
  checkout. The skew-marker and pin-agreement semantics are unchanged: the
  running script's own version is the checkout version.
- Diagnostics (`checked:`, `correction:`) drop the hardcoded
  `.npm-release-flow` path and name the kit checkout's own
  `package.json`. Update the `detect.mjs:137` comment.
- `run-script.mjs` comment: invocation convention becomes
  `node "${{ runner.temp }}/npm-release-flow-kit/src/<name>.mjs"`.

### Workflow

Each of detect, verify, and release keeps the existing guard and the
`actions/checkout` kit checkout (same pin, `path: .npm-release-flow`,
`fetch-depth: 1`, `persist-credentials: false`) and gains:

```yaml
- name: Relocate the kit outside the worktree
  shell: bash
  run: |
    set -euo pipefail
    test ! -e "${{ runner.temp }}/npm-release-flow-kit" || { echo "kit temp path already exists" >&2; exit 1; }
    mv .npm-release-flow "${{ runner.temp }}/npm-release-flow-kit"
```

Ordering rule: the mv completes before any consumer tool runs. detect runs
no consumer code; verify's relocate step sits before the Node resolution,
`npm ci`, and `release:verify` steps; release's sits before
revalidation #1.

All six node invocations become
`node "${{ runner.temp }}/npm-release-flow-kit/src/<name>.mjs"`
(detect 1, verify 1, revalidate 2, validate-artifact 1, release 1).

Pack and artifact paths are untouched: `npm pack --pack-destination`
still targets `.npm-release-flow-pack`, upload-artifact `path` stays
`.npm-release-flow-pack/`, and download-artifact `path` stays
`.npm-release-flow-artifact`.

### Tests

- `test/helpers/fixture.mjs` stops creating the vendored
  `.npm-release-flow` dir inside the consumer; nothing reads it after the
  module-relative change.
- detect and verify tests derive the expected kit version from the
  repository's own `package.json` instead of the removed fixture dir;
  mismatch cases keep a deliberately wrong marker or devDependency
  version.
- `test/script-entry.test.mjs`: update the workflow invocation regex to
  the new absolute-temp-path form; the asserted set stays five unique
  scripts.

### Docs and kit configs (defense in depth)

- `.gitignore`: add `.npm-release-flow/`, `.npm-release-flow-pack/`, and
  `.npm-release-flow-artifact/` (the last two are ephemeral leftovers from
  workflow runs, not scanner inputs).
- `knip.json`: `"ignore": [".npm-release-flow/**"]`.
- `eslint.config.mjs` `ignores`: add `.npm-release-flow/`.
- README caller contract: the exclusion contract required for consumers
  still on old workflow pins (copy-paste gitignore, knip, eslint, prettier
  snippets for `.npm-release-flow/`).
- `RELEASE.md` prerequisites: the same exclusion note.
- `CHANGELOG.md` `## [Unreleased]` entry.

### Migration strategy

- Kit code lands first: module-relative reads work from the legacy
  `.npm-release-flow` location and from `$RUNNER_TEMP` alike, so old
  workflow pins keep working with the new kit code.
- Workflow relocation lands alongside: consumers pinning the new workflow
  get an unpolluted tree; consumers on old pins are unaffected and rely on
  the documented exclusion contract.
- The kit's own self release adopts the new workflow on its next pin
  advance.

## Acceptance Criteria

- In all three jobs the consumer tree contains no `.npm-release-flow`
  once the relocate step has run; the kit lives at
  `$RUNNER_TEMP/npm-release-flow-kit` and every node invocation runs from
  that absolute path.
- No env var is introduced anywhere; detect and verify find the kit
  `package.json` through `import.meta.url` resolution alone.
- Job step ordering keeps the mv before consumer-controlled code in every
  job.
- Detect and verify tests pass without any vendored dir in the fixture;
  their expected kit version is the repository's own version.
- `script-entry` still derives the same five scripts from the workflow.
- The kit's own knip/eslint/gitignore configs ignore the vendored dir, and
  README/RELEASE document the exclusion contract for old pins.
- `.npm-release-flow-pack` and `.npm-release-flow-artifact` references in
  the workflow and `src/verify.mjs` are unchanged.

## Verification

- Per task: targeted `node --test` runs for the touched suites.
- Before checking the last task: `npm run lint`, `npm run format:check`,
  `npm run typecheck`, `npm run knip`, `npm test`.
- `planlet validate kit-outside-checkout` after any plan or task edit.
- External gate: CI on the PR plus the first self release through the
  relocated workflow (workflow behavior itself cannot run locally).

## Risks and Considerations

- Module-relative reads assume the running script is the kit checkout.
  True by construction: the workflow runs the script it checked out at
  `workflow_sha`, and tests run the repository's own `src/`.
- Transient pollution window: `.npm-release-flow` exists between checkout
  and mv. No consumer tool runs in that window given the ordering rule;
  the window is milliseconds.
- `RUNNER_TEMP` is per job, so parallel jobs cannot collide on the kit
  dir.
- Consumers that intentionally read `.npm-release-flow` internals break;
  that coupling was never documented or supported.
- A future `actions/checkout` change that allows outside paths would make
  the mv redundant, not harmful.
