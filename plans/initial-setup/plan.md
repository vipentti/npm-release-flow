# Initial setup of the npm-release-flow kit

## Summary

Bootstrap the kit repository (`vipentti/npm-release-flow`) to the point where a follow-up planlet can implement the CLI (`prepare`/`tag`/`check`) and the workflow job bodies: npm package skeleton, the reusable `release.yml` workflow interface (blueprint §5, literal), packaged workflow copy with a drift guard, CI verification scaffolding, release-prerequisites documentation, and the repo settings (`release` Environment, main ruleset) that must exist before first release. Nothing is published; the package stays `private: true`.

## Scope

- `package.json` skeleton: name `@vipentti/npm-release-flow`, `private: true` (first publish is manual per blueprint §10 step 3; captain flips it), `version: 0.0.0` placeholder, `type: module`, `engines.node >= 22.14.0` (npm Trusted Publishing floor, §7), `bin` (`npm-release-flow`), `exports`/`main`, `files` (`bin`, `src`, `workflow`), `license: MIT` (assumption, matches the planlet skills in this repo; trivially changeable), zero runtime dependencies (§3). `package-lock.json` committed (the kit is its own first consumer; lockfile is a mandatory control file, §4). `.gitignore` (node_modules, *.tgz).
- `src/index.mjs` and `bin/npm-release-flow.mjs`: minimal placeholders (usage text, exit 1) that the CLI planlet replaces. Plain `.mjs`, no build step (§3).
- `.github/workflows/release.yml`: blueprint §5 normative `workflow_call` interface (no inputs; the four `NPM_RELEASE_FLOW_*` secrets, all `required: true`; outputs `is-release`/`version`; top-level `permissions: {}`), jobs `detect`/`verify`/`release` with the §5 per-job permissions (`contents: read` on the first two; `contents: write` + `id-token: write` + `environment: release` on `release` only, T3/T6), the kit-checkout guard and checkout at `job.workflow_sha` into `.npm-release-flow` (T8). Job bodies are shells invoking kit scripts at `.npm-release-flow/src/...`; the logic itself ships in the CLI planlet.
- `workflow/release.yml`: packaged copy of the workflow (the package ships the workflow YAML as data, §3); CI asserts byte equality with `.github/workflows/release.yml` (drift guard).
- `.github/workflows/ci.yml`: npm ci on Node 24, `tsc --checkJs --noEmit` (JSDoc typecheck, §3), actionlint on both workflows, byte-equality check (`cmp`), pack smoke (`npm pack --dry-run`, bin stub runs and exits 1).
- `RELEASE.md`: blueprint §6 secret/variable fixed names, §7 toolchain pins (protected job Node 24.11.1 + npm 11.6.2; verify fallback Node 22), `release` Environment requirement (T3), App installation (T11), trusted-publisher workflow-filename note, §10 first-release checklist. README links it.
- Repo settings, applied during implementation via gh-axi: `release` Environment with a required reviewer (repo owner assumed; blueprint T3 needs approval to gate) and a main ruleset requiring PR review + the CI checks (§9: PR review is the release gate; the kit enforces it on itself).

Out of scope, later planlets or captain: CLI logic and workflow job-body logic, secret/variable *values* (key generation, App installation, secrets creation are captain/vault actions; this planlet only documents them), making the repo public (§10 step 2), first publish, consumer migrations.

## Approach

- One repository, one version, two artifacts (§3); the workflow never carries a version input, so both artifacts stay in lockstep (T8).
- Bin name `npm-release-flow`, single binary with subcommands `prepare`/`tag`/`check` (§8); the blueprint fixes the command set, not the binary name.
- Workflow written directly from the blueprint's literal YAML; structural completeness (interface, permissions, checkout plumbing) is this planlet's deliverable, functional completeness is the CLI planlet's.
- No build step: checked-in `.mjs` is what executes; type safety via JSDoc + `tsc --checkJs --noEmit` in CI.
- Repo settings applied last so nothing gates this planlet's own PR.

## Acceptance Criteria

- Fresh-checkout `npm ci` succeeds; `npm pack --dry-run` lists only `bin`/`src`/`workflow` files plus package.json/README/LICENSE; `node bin/npm-release-flow.mjs` prints usage and exits 1.
- `tsc --checkJs --noEmit` passes with zero errors; actionlint is clean on both workflow files; CI is green on the implementation branch.
- `release.yml` matches §5: no `inputs`; exactly the four `NPM_RELEASE_FLOW_*` secrets, all `required: true`; outputs `is-release`/`version`; `permissions: {}`; `environment: release` and `id-token: write` on the `release` job only.
- `workflow/release.yml` is byte-identical to `.github/workflows/release.yml` (CI-enforced).
- RELEASE.md names every §6 secret/variable exactly and both §7 pins; README links it.
- `release` Environment exists with a required reviewer; the main ruleset requires PR review and the CI checks; both verified via the GitHub API.
- `planlet validate initial-setup` passes.

## Verification

- Local, per task: `npm ci && npm run typecheck`, `npx actionlint`, `cmp .github/workflows/release.yml workflow/release.yml`, `npm pack --dry-run`, stub run. CI (ci.yml) runs the same checks on every PR; the main ruleset requires them.
- Reviewer-confirmed external gates: §5 interface invariants against the blueprint (review), and API-visible state for T5 (`gh api` queries for the Environment and the ruleset).
- Known limitation: workflow job bodies cannot execute until the CLI planlet provides the kit scripts and a consumer calls the workflow; functional verification is deferred, structural verification (actionlint, interface review, byte equality) is this planlet's bar.
- Secrets/variables presence before first release is documented (RELEASE.md), not created; the later `check` command verifies presence.

## Risks and Considerations

- The packaged workflow copy can drift from `.github/workflows/release.yml`; the CI byte-equality check is the guard.
- Job bodies calling not-yet-implemented scripts are inert (no caller exists) but must stay actionlint-clean; the CLI planlet must replace them before any consumer adopts the workflow.
- The main ruleset requires CI checks that only exist after this planlet lands; settings are applied last and the ruleset only starts enforcing once the checks run.
- actionlint is a third-party action in CI (assumption; drop if unwanted, GitHub's own YAML validation on push remains).
