# Tasks: Move the kit checkout outside the consumer worktree

- [x] T1 Kit version reads module-relative. In `src/detect.mjs` and
      `src/verify.mjs`, replace the cwd-relative
      `.npm-release-flow/package.json` reads with the kit's own
      `package.json` resolved from the script's module location, using the
      `src/commands/prepare.mjs` pattern:
      `const moduleDir = dirname(fileURLToPath(import.meta.url));` then
      `resolve(moduleDir, "..", "package.json")`. No env var, no fallback
      branching. Update the `checked:`/`correction:` diagnostics and the
      `detect.mjs:137` comment so they name the kit checkout's own
      `package.json` instead of hardcoding `.npm-release-flow`. Update the
      invocation convention comment in `src/lib/run-script.mjs` to
      `node "${{ runner.temp }}/npm-release-flow-kit/src/<name>.mjs"`.
      Verify: `node --test test/detect.test.mjs test/verify.test.mjs`
      passes after the T2 fixture update (both land in one change set);
      `npm test` green.

- [x] T2 Tests follow the module-relative reads. In
      `test/helpers/fixture.mjs`, remove the vendored `.npm-release-flow`
      dir creation inside the consumer. In `test/detect.test.mjs` and
      `test/verify.test.mjs`, derive the expected kit version from the
      repository's own `package.json` instead of the removed fixture dir;
      keep the mismatch cases by stamping a deliberately wrong marker or
      devDependency version.
      Verify: `node --test test/detect.test.mjs test/verify.test.mjs`
      passes; `npm test` green.

- [x] T3 Relocate the kit in the detect and verify jobs. In
      `.github/workflows/release.yml`, keep the existing guard and kit
      checkout and add the `Relocate the kit outside the worktree` step
      (guard `${{ runner.temp }}/npm-release-flow-kit` absence, `mv
      .npm-release-flow "${{ runner.temp }}/npm-release-flow-kit"`, no env
      export) after each kit checkout, before any consumer tooling. Change
      `node .npm-release-flow/src/detect.mjs` and
      `node .npm-release-flow/src/verify.mjs` to
      `node "${{ runner.temp }}/npm-release-flow-kit/src/<name>.mjs"`.
      Leave the pack dir, `PACK_DIR` handling, and upload-artifact `path`
      untouched.
      Verify: YAML review (relocate before consumer steps in both jobs;
      guard retained); `npm run format:check` on the workflow.

- [x] T4 Relocate the kit in the release job. Add the same relocate step
      after the kit checkout (before revalidation #1) and change the four
      node invocations (`revalidate` x2, `validate-artifact`, `release`) to
      `node "${{ runner.temp }}/npm-release-flow-kit/src/<name>.mjs"`.
      Leave download-artifact `path: .npm-release-flow-artifact` and
      `ARTIFACT_DIR: ${{ steps.download.outputs.download-path }}` as is.
      Verify: YAML review; `npm run format:check`; all six invocation sites
      use the temp path
      (`rg "node \\.npm-release-flow" .github` returns nothing).

- [x] T5 Update the workflow invocation test. In
      `test/script-entry.test.mjs`, change the regex that derives invoked
      scripts to match the new
      `node "${{ runner.temp }}/npm-release-flow-kit/src/<name>.mjs"` form
      and assert the same five unique scripts.
      Verify: `node --test test/script-entry.test.mjs` passes; `npm test`
      green.

- [x] T6 Kit repo ignores the vendored dir. Add `.npm-release-flow/`,
      `.npm-release-flow-pack/`, `.npm-release-flow-artifact/` to
      `.gitignore`; add `".npm-release-flow/**"` to `knip.json` `ignore`;
      add `.npm-release-flow/` to `eslint.config.mjs` `ignores`. Prove with
      a temporary vendored stub: create `.npm-release-flow/` with a `.mjs`
      file, run `npm run knip` and `npm run lint`, confirm no findings,
      remove the stub.
      Verify: `npm run knip`, `npm run lint`, `npm run format:check` pass.

- [x] T7 Document the exclusion contract for old pins. In the README
      caller-contract section, add the exclusion contract required for
      consumers still on old workflow pins (gitignore, knip ignore, eslint
      ignores, prettier ignore snippets for `.npm-release-flow/`). Add the
      same note to RELEASE.md prerequisites. No env-contract text.
      Verify: `npm run format:check` on the docs.

- [x] T8 CHANGELOG entry. Add a `## [Unreleased]` bullet describing the
      relocated kit checkout and the documented exclusion fallback for old
      pins.
      Verify: `npm run format:check`; entry sits under `## [Unreleased]`.

- [x] T9 Full verification gate. Run `npm run lint`,
      `npm run format:check`, `npm run typecheck`, `npm run knip`,
      `npm test`, then `planlet validate kit-outside-checkout`.
      Verify: all commands exit 0; no consumer-tree pollution references
      remain in the workflow besides the pre-mv checkout path (`rg`
      review).

## Completion

- Completed at: 2026-08-16T09:40:54.499Z
- Mode: normal
