# Public release preparation and self-release bootstrap

## Summary

Prepare the kit repository (`vipentti/npm-release-flow`) for going public and for its first self-release, without performing any visibility, secret, environment, npm, or release/publish mutation. Concretely: harden CI to run the full local verification suite, make README and RELEASE.md self-contained public documentation (no dependence on the private `vipentti/agent-blueprints` repo), add SECURITY.md, satisfy the kit's own §4 mandatory consumer prerequisites (its own `CHANGELOG.md` with a non-empty `## [Unreleased]` and its own `release:verify` script), add a thin self-release caller workflow pinned to the current main SHA, and record the exact human-required sequences (before going public; before the first npm release) in RELEASE.md. Ends with a full verification pass including a gitleaks history scan and the required final report.

Blueprint pin: `vipentti/agent-blueprints` at commit `f9d06c77b9920e4cfab774d254f22d60894c1f05`, file `blueprints/npm-release-flow.md`. The planlet may use it as internal reference, but the documentation this planlet produces must be self-contained: public readers never need access to the private blueprint.

## Scope

- `package.json`: add `"test": "node --test"`; add a `release:verify` script composing the existing checks (lint, format:check, typecheck, knip, test). No runtime dependency changes; `"private": true`, version `0.0.0`, and the `files` entry stay untouched.
- Formatting baseline: the tree is not currently prettier-clean (`npm run format:check` fails on 46 files); run `npm run format` and review that the diff is formatting-only.
- Test harness: fix the pre-existing Windows bug in `test/helpers/fixture.mjs` where the GNUPGHOME temp path is misread as cwd-relative by the Git-bundled gpg, so `npm test` passes on this Windows machine too (CI runs POSIX).
- `.github/workflows/ci.yml`: add `format:check`, `knip`, and `test` steps in the captain-specified order; keep the single job named `ci` (the main ruleset's required check context) and all existing steps (npm ci, lint, typecheck, pinned actionlint, pack/CLI smoke).
- `CHANGELOG.md`: Keep a Changelog style, non-empty `## [Unreleased]` with initial entries summarizing the implemented functionality; no released-version section.
- `README.md`: full rewrite into self-contained public documentation (what the kit is, status, supported Node, installation once published, CLI `prepare`/`tag`/`check` with dry-run default and `--execute`, high-level release flow, reusable workflow usage, required consumer prerequisites, security/trust model summary, link to RELEASE.md, development commands, license). All usage derived from implementation and tests; no invented behavior. The blueprint pin stays only as an optional provenance/history note, clearly marked internal.
- `SECURITY.md`: new, concise (supported-versions policy pre-first-stable-release; private reporting via GitHub private vulnerability reporting, fallback to contacting the maintainer privately without inventing an email; scope examples relevant to this kit).
- `RELEASE.md`: restructure into "Automated/repository state" vs "Human-required setup", self-contained (requirements copied locally; blueprint pin retained only as provenance), recording the exact human sequences (before going public; before first npm release), the caller pin-advance procedure, and the pre-secrets failure window.
- Self-release caller workflow (`.github/workflows/self-release.yml`): thin caller invoking the reusable `release.yml` at an immutable pin (current main SHA `764e09c`), named secrets only, minimal permissions, no copied release logic.
- Final verification + report: full local suite, actionlint on all workflow files, `npm pack --dry-run` inspection, gitleaks history scan, and the §10-style final report.

Out of scope (explicitly forbidden in this planlet; human-gated): changing repository visibility, adding the required reviewer to the `release` Environment, configuring/creating secret or variable values, installing or changing the GitHub App, configuring npm Trusted Publisher, the first manual npm publication, removing `"private": true`, changing the version for the first release, publishing, creating release tags or GitHub Releases, any secret mutation, and destructive history rewriting. Also out of scope: consumer migrations (planlet, pi-session-clock), redesign of the release architecture, and unrelated code changes.

## Approach

- Order of work: baseline fixes first (test script + formatting, Windows test fix), then CI hardening, then the kit's own release prerequisites (CHANGELOG, release:verify), then public docs (README, SECURITY, RELEASE), then the caller workflow, then the final verification and report. The caller workflow lands after the prerequisites it depends on (detect hard-fails on missing prerequisites; the caller must not precede CHANGELOG/release:verify).
- CI order per the captain's brief, in the single `ci` job: install (npm ci), lint, format check, typecheck, knip, tests, workflow lint (pinned actionlint v1.7.12 with the established `-ignore` patterns), package/CLI smoke. Existing checks are kept, never removed or weakened.
- Fix findings, do not weaken: the 46-file formatting failure is fixed by running `npm run format` and reviewing that the diff is formatting-only; the failing tests are fixed by repairing the GNUPGHOME path handling in the fixture harness. The test suite has never run in CI; the first CI run of `npm test` is authoritative and any latent POSIX failure must be fixed, not skipped.
- `release:verify` composes exactly lint, format:check, typecheck, knip, test. It does not include actionlint or pack smoke: actionlint needs the pinned binary download that a consumer's verify job does not perform, and pack smoke already lives in CI.
- Caller workflow: `uses: vipentti/npm-release-flow/.github/workflows/release.yml@764e09c`. The pin is the current main SHA holding the known-good kit at version `0.0.0`, and it is correct for the first self-release: `prepare` at 0.0.0 stamps the §10 marker `@vipentti/npm-release-flow@0.0.0`, which detect compares against the kit checkout at the pin (also 0.0.0). The pin must advance to the release commit in a follow-up ordinary PR after each self-release (the release-diff allowlist is exactly CHANGELOG.md/package.json/package-lock.json, so the pin cannot move in a release PR; a stale pin fails the next release's marker check). The caller will fail on every push to main until the four secrets exist (required `workflow_call` secrets); this is documented non-blocking noise, since the `ci` check is the only required check on main.
- Documentation derives every CLI/workflow claim from `bin/npm-release-flow.mjs`, `src/commands/*`, `.github/workflows/release.yml`, and the tests. Nothing is invented.
- gitleaks: local history scan during implementation (gitleaks 8.30.1 is available on this machine) using a full local clone; the result is reported to the human. It is not added to CI: a history scan needs a full clone, which a fresh CI checkout does not provide.
- SECURITY.md: no invented email address; GitHub private vulnerability reporting is the preferred path.
- Archived planlet records are not rewritten; historical references to the private blueprint stay as history.

## Acceptance Criteria

- `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run knip`, and `npm test` all pass locally on the implementation branch; `npm run release:verify` composes the five checks and exits 0.
- ci.yml runs the full suite in the specified order in a single job still named `ci`, keeping every existing step; CI is green on the implementation branch.
- `CHANGELOG.md` exists with a non-empty `## [Unreleased]` and no released-version section; the kit's own detect/prepare accept it.
- README.md is self-contained and usable without access to `vipentti/agent-blueprints`: it documents the CLI commands, dry-run/`--execute`, the high-level release flow, reusable workflow usage, all required consumer prerequisites, a security/trust model summary, development commands, and the license, and links RELEASE.md; every claim matches the implementation and tests.
- SECURITY.md exists, is concise, and covers the supported-versions policy, private reporting with a no-invented-email fallback, and the listed scope examples.
- RELEASE.md is self-contained, separates automated/repository state from human-required setup, and records the exact sequences (before going public; before first npm release), the reviewer-rule `gh api` command, the caller pin-advance procedure, and the pre-secrets failure window.
- The self-release caller workflow exists, calls `release.yml` at `764e09c`, names the four secrets explicitly (never `secrets: inherit`), holds minimal permissions, and contains no copied release logic; actionlint is clean on all workflow files.
- `npm pack --dry-run` lists only intended files (bin, src, `.github/workflows/release.yml`, package.json, README.md, LICENSE; no CHANGELOG/SECURITY changes required since they are not in `files`), with no secrets, test fixtures, or dev-only files.
- The gitleaks history scan result is reported; if it cannot run, the human is told to run it before changing visibility.
- The final report covers: files changed, checks run and results, what is deliberately left for the human, the exact human sequence before making the repo public, the exact human sequence before the first npm release, and any blockers discovered.

## Verification

- Local, per task: `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run knip`, `npm test`; actionlint via the pinned v1.7.12 release-binary acquisition already used by ci.yml, with the established `-ignore` patterns, on `.github/workflows/release.yml`, `.github/workflows/ci.yml`, and any new workflow; `npm pack --dry-run` with inspection of the listing.
- gitleaks 8.30.1: full-clone history scan run during implementation (T10); the outcome is part of the final report. If the scan is unavailable or incomplete, the report states that the human must run the history scan before the visibility change.
- CI (ci.yml) runs the full suite on every PR; the main ruleset requires the `ci` check.
- Reviewer-confirmed gates: README/SECURITY/RELEASE content accuracy (usage derived from implementation and tests, nothing invented); RELEASE.md human sequences match the actual repository and settings state.
- Known limitations: the test suite's Windows fixture bug is fixed in this planlet (T2), and Linux CI is the authoritative test gate; the caller workflow fails on main pushes until secrets exist (documented, not a defect); the caller pin must advance per release (documented).
- No `## Verification Evidence` section is expected: all verification is reproducible via the stable commands and CI above.

## Risks and Considerations

- The tree was never prettier-formatted: `npm run format` touches 46 files; the diff must be reviewed as formatting-only and must not change behavior.
- The test suite has never run in CI; the Windows fixture fix is included, but the first CI run of `npm test` may surface latent POSIX failures that must be fixed, not weakened.
- The caller pin is correct for the first release only because the prepare marker (0.0.0) agrees with the kit checkout at `764e09c`; a stale pin fails the next release's marker check, hence the documented pin-advance PR.
- The caller produces failing workflow runs on main until the four secrets exist; non-blocking but noisy, and documented in RELEASE.md.
- Documentation must not require access to the private `agent-blueprints` repo; the pinned reference stays as provenance only, and archived planlet records are not rewritten.
- This planlet performs no visibility, secret, environment, npm, or release mutations; `"private": true` stays in place as the protection against accidental publication.
