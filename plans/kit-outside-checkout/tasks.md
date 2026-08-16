# Tasks: Move the kit checkout outside the consumer worktree

- [ ] T1 Kit version reads env-driven with legacy fallback. In
      `src/detect.mjs` and `src/verify.mjs`, replace the hardcoded
      `.npm-release-flow/package.json` reads with
      `const kitDir = env.NPM_RELEASE_FLOW_KIT ?? ".npm-release-flow";`
      resolved as `resolve(cwd, kitDir, "package.json")` (absolute values
      win per Node `path.resolve`). Update the `checked:`/`correction:`
      diagnostics and the `detect.mjs:137` comment so they name the resolved
      location instead of hardcoding `.npm-release-flow`. Update the
      invocation convention comment in `src/lib/run-script.mjs` to
      `node "$NPM_RELEASE_FLOW_KIT/src/<name>.mjs"`.
      Verify: `node --test test/detect.test.mjs test/verify.test.mjs` and
      `npm test` still pass via the fallback path (no workflow change yet).

- [ ] T2 Fixture and tests for the env-driven reads. In
      `test/helpers/fixture.mjs`, create the kit checkout dir outside the
      consumer (under the fixture base), write its `package.json`, expose it
      on the fixture, and wire `NPM_RELEASE_FLOW_KIT` into `envWithShim`.
      Add backward-compat tests: one detect case and one verify case where
      `NPM_RELEASE_FLOW_KIT` is unset and a legacy `.npm-release-flow` dir
      inside the consumer carries the kit version, asserting the version is
      still read.
      Verify: `node --test test/detect.test.mjs test/verify.test.mjs`
      passes; `npm test` green.

- [ ] T3 `NPM_RELEASE_FLOW_PACK_DIR` for the pack dir. In `src/verify.mjs`
      derive the pack dir from
      `env.NPM_RELEASE_FLOW_PACK_DIR ?? ".npm-release-flow-pack"` resolved
      against cwd. Add a verify test that the pack output lands in an
      env-specified dir, and keep existing tests green with the default.
      Verify: `node --test test/verify.test.mjs` passes.

- [ ] T4 Relocate the kit in the detect and verify jobs. In
      `.github/workflows/release.yml`, keep the existing guard and kit
      checkout and add the `Relocate the kit outside the worktree` step
      (guard `${{ runner.temp }}/npm-release-flow-kit` absence, `mv`, write
      `NPM_RELEASE_FLOW_KIT` to `$GITHUB_ENV`) after each kit checkout,
      before any consumer tooling. Change
      `node .npm-release-flow/src/detect.mjs` and
      `node .npm-release-flow/src/verify.mjs` to
      `node "$NPM_RELEASE_FLOW_KIT/src/<name>.mjs"`. Wire
      `NPM_RELEASE_FLOW_PACK_DIR: ${{ runner.temp }}/npm-release-flow-pack`
      into the Verify and pack step and change upload-artifact `path` to
      `${{ runner.temp }}/npm-release-flow-pack/`.
      Verify: YAML review (relocate before consumer steps in both jobs;
      guard retained); `npm run format:check` on the workflow.

- [ ] T5 Relocate the kit in the release job. Add the same relocate step
      after the kit checkout (before revalidation #1), change the four node
      invocations (`revalidate` x2, `validate-artifact`, `release`) to
      `$NPM_RELEASE_FLOW_KIT`, and change download-artifact `path` to
      `${{ runner.temp }}/npm-release-flow-artifact`. Keep
      `ARTIFACT_DIR: ${{ steps.download.outputs.download-path }}` as is.
      Verify: YAML review; `npm run format:check`; all six invocation sites
      use `$NPM_RELEASE_FLOW_KIT`
      (`rg "node \\.npm-release-flow" .github` returns nothing).

- [ ] T6 Update the workflow invocation test. In
      `test/script-entry.test.mjs`, change the regex that derives invoked
      scripts to match the new
      `node "$NPM_RELEASE_FLOW_KIT/src/<name>.mjs"` form and assert the same
      five unique scripts.
      Verify: `node --test test/script-entry.test.mjs` passes; `npm test`
      green.

- [ ] T7 Kit repo ignores the vendored dirs. Add `.npm-release-flow/`,
      `.npm-release-flow-pack/`, `.npm-release-flow-artifact/` to
      `.gitignore`; add `".npm-release-flow/**"` and
      `".npm-release-flow-pack/**"` to `knip.json` `ignore`; add the
      dot-dirs to `eslint.config.mjs` `ignores`. Prove with a temporary
      vendored stub: create `.npm-release-flow/` with a `.mjs` file, run
      `npm run knip` and `npm run lint`, confirm no findings, remove the
      stub.
      Verify: `npm run knip`, `npm run lint`, `npm run format:check` pass.

- [ ] T8 Document the exclusion contract and internal env contract. In the
      README caller-contract section, add the exclusion contract for
      consumers still on old workflow pins (gitignore, knip ignore, eslint
      ignores, prettier ignore snippets) and state that
      `NPM_RELEASE_FLOW_KIT` and `NPM_RELEASE_FLOW_PACK_DIR` are internal,
      set by the workflow, and must not be set by consumers. Add the same
      exclusion note to RELEASE.md prerequisites.
      Verify: `npm run format:check` on the docs.

- [ ] T9 CHANGELOG entry. Add a `## [Unreleased]` bullet describing the
      relocated kit checkout, the internal env contract, and the documented
      exclusion fallback.
      Verify: `npm run format:check`; entry sits under `## [Unreleased]`.

- [ ] T10 Full verification gate. Run `npm run lint`,
      `npm run format:check`, `npm run typecheck`, `npm run knip`,
      `npm test`, then `planlet validate kit-outside-checkout`.
      Verify: all commands exit 0; no consumer-tree pollution references
      remain in the workflow besides the pre-mv checkout path (`rg` review).
