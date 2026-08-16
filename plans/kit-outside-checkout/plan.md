# Move the kit checkout outside the consumer worktree

## Summary

The reusable release workflow currently checks the kit into
`.npm-release-flow/` inside the consumer tree and writes two ephemeral dirs
(`.npm-release-flow-pack/`, `.npm-release-flow-artifact/`) there as well.
Consumer tooling scans the vendored directory: knip flagged 21 kit-internal
files plus the `createAndPushTag` export as unused, failing
`release:verify`. Relocate the per-job kit checkout to
`$RUNNER_TEMP/npm-release-flow-kit` via checkout-then-mv, expose it as the
`NPM_RELEASE_FLOW_KIT` env var, redirect the two kit version reads, move the
ephemeral pack and artifact dirs to `$RUNNER_TEMP`, and ship fallback
exclusion docs as defense in depth.

## Motivation

- The vendored checkout pollutes every consumer's tree: any tool with a
  broad glob (knip default project, eslint flat config, prettier,
  `git status`, `git add .`) can trip over `.npm-release-flow`. The
  incident is real and hits every consumer.
- Nothing requires the kit inside the consumer tree. Only two cwd-relative
  reads exist (`src/detect.mjs:212`, `src/verify.mjs:88`). Kit scripts
  resolve their imports file-relative via `import.meta.url`, so
  absolute-path invocation works from anywhere.
- `actions/checkout` forbids `path:` outside `GITHUB_WORKSPACE` (verified
  `input-helper.ts` guard), so relocation needs checkout-then-mv.

## Scope

What changes:

- Workflow (`.github/workflows/release.yml`): relocate step in the detect,
  verify, and release jobs; six node invocations via
  `NPM_RELEASE_FLOW_KIT`; pack and artifact dirs moved to `runner.temp`.
- Kit code: `src/detect.mjs` and `src/verify.mjs` env-driven kit reads with
  legacy fallback; `src/verify.mjs` `PACK_DIR` env; `src/lib/run-script.mjs`
  comment.
- Tests: fixture kit dir outside the consumer with `NPM_RELEASE_FLOW_KIT`;
  backward-compat fallback coverage; `script-entry` workflow regex.
- Docs plus kit configs: `.gitignore`, `knip.json`, `eslint.config.mjs`
  ignores; README/RELEASE exclusion contract plus internal-env note;
  `CHANGELOG.md` entry.

## Out of Scope

- Manual `git clone` to temp instead of checkout-then-mv (loses the action
  pin and token handling).
- Sibling `../` placement via `actions/checkout` `path:` (blocked by the
  checkout guard).
- Dedicated kit artifact job (extra latency, version-skew risk).
- Removing the legacy `.npm-release-flow` fallback (kept for old workflow
  pins).
- Changes to `self-release.yml` (thin caller; advances pin on next
  release).
- Behavior of `validate-artifact.mjs`, `revalidate.mjs`, `release.mjs`
  (already location agnostic).

## Approach

Adopted decisions from the scouting investigation (2026-08-16):

1. Outside-worktree elimination, not docs-only exclusion.
2. `$RUNNER_TEMP/npm-release-flow-kit` via checkout-then-mv with the
   `NPM_RELEASE_FLOW_KIT` env var.
3. Ephemeral pack and artifact dirs also relocate to `$RUNNER_TEMP`.
4. Fallback exclusion docs ship regardless, as defense in depth.

### Kit code (ships first; fallback keeps old pins working)

- The skew-marker read in `detect.mjs` and the pin-agreement read in
  `verify.mjs` become:
  `const kitDir = env.NPM_RELEASE_FLOW_KIT ?? ".npm-release-flow";` then
  `resolve(cwd, kitDir, "package.json")`. Node `path.resolve` drops earlier
  segments when a later one is absolute, so one expression serves both the
  absolute temp path and the legacy relative path. The fallback means an old
  workflow pin that still vendors `.npm-release-flow` keeps working with the
  new kit code.
- Diagnostics (`checked:`, `correction:`) name the resolved location
  instead of hardcoding `.npm-release-flow`. Update the `detect.mjs:137`
  comment.
- `verify.mjs` pack dir becomes
  `env.NPM_RELEASE_FLOW_PACK_DIR ?? ".npm-release-flow-pack"`, resolved
  against cwd (absolute value wins).
- `run-script.mjs` comment: invocation convention becomes
  `node "$NPM_RELEASE_FLOW_KIT/src/<name>.mjs"`.

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
    echo "NPM_RELEASE_FLOW_KIT=${{ runner.temp }}/npm-release-flow-kit" >> "$GITHUB_ENV"
```

Ordering rule: the mv completes before any consumer tool runs. detect runs
no consumer code; verify's relocate step sits before the Node resolution,
`npm ci`, and `release:verify` steps; release's sits before
revalidation #1.

All six node invocations become
`node "$NPM_RELEASE_FLOW_KIT/src/<name>.mjs"` (detect 1, verify 1,
revalidate 2, validate-artifact 1, release 1).

Ephemeral dirs:

- verify job passes
  `NPM_RELEASE_FLOW_PACK_DIR: ${{ runner.temp }}/npm-release-flow-pack` to
  the Verify and pack step; upload-artifact `path` becomes
  `${{ runner.temp }}/npm-release-flow-pack/`.
- release job: download-artifact `path` becomes
  `${{ runner.temp }}/npm-release-flow-artifact`. `ARTIFACT_DIR` already
  arrives absolute via the download-path output; `validate-artifact.mjs` is
  unchanged.

### Tests

- `test/helpers/fixture.mjs` places the kit `package.json` in a
  fixture-level kit dir outside the consumer (under the fixture base) and
  wires `NPM_RELEASE_FLOW_KIT` into the shared env.
- New backward-compat tests: with `NPM_RELEASE_FLOW_KIT` unset and a legacy
  `.npm-release-flow` dir inside the consumer, detect and verify still read
  the version (fallback).
- `test/script-entry.test.mjs`: update the workflow invocation regex to the
  new form; the asserted set stays five unique scripts.
- A verify test for `NPM_RELEASE_FLOW_PACK_DIR`: pack output lands in the
  env-specified dir.

### Docs and kit configs (defense in depth)

- `.gitignore`: add the three dot-dirs.
- `knip.json`:
  `"ignore": [".npm-release-flow/**", ".npm-release-flow-pack/**"]`.
- `eslint.config.mjs` `ignores`: add the dot-dirs.
- README caller contract: the exclusion contract required for consumers
  still on old workflow pins (copy-paste gitignore, knip, eslint, prettier
  snippets) plus the internal-env note: `NPM_RELEASE_FLOW_KIT` and
  `NPM_RELEASE_FLOW_PACK_DIR` are set by the workflow; consumers must not
  set them.
- `RELEASE.md` prerequisites: the same exclusion note.
- `CHANGELOG.md` `## [Unreleased]` entry.

### Migration strategy

- Kit code with fallback lands first: old workflow pins (vendoring inside)
  still read `.npm-release-flow` because the env var is unset.
- Workflow relocation lands alongside: consumers pinning the new workflow
  get an unpolluted tree; consumers on old pins are unaffected and rely on
  the documented exclusion contract.
- The kit's own self release adopts the new workflow on its next pin
  advance.

## Acceptance Criteria

- In all three jobs the consumer tree contains no `.npm-release-flow`,
  `.npm-release-flow-pack`, or `.npm-release-flow-artifact` once the
  relocate step has run; the kit lives at
  `$RUNNER_TEMP/npm-release-flow-kit` and `NPM_RELEASE_FLOW_KIT` is
  exported for subsequent steps.
- All six node invocations run through `$NPM_RELEASE_FLOW_KIT`; job step
  ordering keeps the mv before consumer-controlled code in every job.
- With `NPM_RELEASE_FLOW_KIT` unset, detect and verify read the legacy
  `.npm-release-flow` path unchanged (old pins unaffected).
- Verify writes the pack to `NPM_RELEASE_FLOW_PACK_DIR` when set, else
  `.npm-release-flow-pack`; the workflow uploads from and downloads to
  `runner.temp` paths.
- Tests cover env-set and env-unset reads; `script-entry` still derives the
  same five scripts from the workflow.
- The kit's own knip/eslint/gitignore configs ignore the vendored dirs, and
  README/RELEASE document the exclusion contract for old pins plus the
  internal env contract.

## Verification

- Per task: targeted `node --test` runs for the touched suites.
- Before checking the last task: `npm run lint`, `npm run format:check`,
  `npm run typecheck`, `npm run knip`, `npm test`.
- `planlet validate kit-outside-checkout` after any plan or task edit.
- External gate: CI on the PR plus the first self release through the
  relocated workflow (workflow behavior itself cannot run locally).

## Risks and Considerations

- An env wiring bug could break the skew check; fallback plus tests for
  both env states mitigate.
- Transient pollution window: `.npm-release-flow` exists between checkout
  and mv. No consumer tool runs in that window given the ordering rule; the
  window is milliseconds.
- upload-artifact/download-artifact absolute path inputs are supported on
  ubuntu (this workflow's only runner); not evaluated for Windows.
- `RUNNER_TEMP` is per job, so parallel jobs cannot collide on the kit dir.
- Consumers that intentionally read `.npm-release-flow` internals break;
  that coupling was never documented or supported.
- A future `actions/checkout` change that allows outside paths would make
  the mv redundant, not harmful.
