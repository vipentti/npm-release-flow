# Initial setup of the npm-release-flow kit

## Summary

Bootstrap the kit repository (`vipentti/npm-release-flow`) to the point where a follow-up planlet can implement the CLI (`prepare`/`tag`/`check`) and the workflow job bodies: npm package skeleton, the reusable `release.yml` workflow interface (blueprint §5, literal), packaged workflow copy with a drift guard, CI verification scaffolding, release-prerequisites documentation, and the repo settings (`release` Environment, main ruleset) that must exist before first release. Nothing is published; the package stays `private: true`.

Blueprint pin: every §N reference in this plan and in tasks.md resolves to `vipentti/agent-blueprints` at commit `f9d06c77b9920e4cfab774d254f22d60894c1f05`, file `blueprints/npm-release-flow.md`. No other blueprint revision is authoritative for this work.

## Scope

- `package.json` skeleton: name `@vipentti/npm-release-flow`, `private: true` (first publish is manual per blueprint §10 step 3; captain flips it), `version: 0.0.0` placeholder, `type: module`, `engines.node >= 22.14.0` (npm Trusted Publishing floor, §7), `files` (`bin`, `src`, `workflow`), `main: "./src/index.mjs"`, root `exports` mapping to `"./src/index.mjs"`, `bin.npm-release-flow: "./bin/npm-release-flow.mjs"`, `license: MIT`, `repository: { type: "git", url: "git+https://github.com/vipentti/npm-release-flow.git" }` (npm's git+https form of the GitHub repository; §10 requires `repository.url` to exactly match the GitHub repository), zero runtime dependencies (§3). `LICENSE` file: MIT, `Copyright (c) 2026 Ville Penttinen` (matching sibling repos). `package-lock.json` committed (the kit is its own first consumer; lockfile is a mandatory control file, §4). `.gitignore` (node_modules, *.tgz).
- `src/index.mjs` and `bin/npm-release-flow.mjs`: minimal placeholders (usage text, exit 1) that the CLI planlet replaces. Plain `.mjs`, no build step (§3).
- `.github/workflows/release.yml`: blueprint §5 normative `workflow_call` interface (no inputs; the four `NPM_RELEASE_FLOW_*` secrets, all `required: true`; outputs `is-release`/`version`; top-level `permissions: {}`), jobs `detect`/`verify`/`release` with the §5 per-job permissions (`contents: read` on the first two; `contents: write` + `id-token: write` + `environment: release` on `release` only, T3/T6), the kit-checkout guard and checkout at `job.workflow_sha` into `.npm-release-flow` (T8), using `actions/checkout` pinned to `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1, matching the existing planlet release workflow). Job bodies are shells invoking kit scripts at `.npm-release-flow/src/...`; the logic itself ships in the CLI planlet.
- `workflow/release.yml`: packaged copy of the workflow (the package ships the workflow YAML as data, §3); CI asserts byte equality with `.github/workflows/release.yml` (drift guard).
- `tsconfig.json`: explicit typecheck scope, `include` of `src/**/*.mjs` and `bin/**/*.mjs` only, with `checkJs`, `noEmit`, `allowJs`, `module`/`moduleResolution: NodeNext`, `target: "ES2023"` (matching the planlet TypeScript config), `strict`, `types: ["node"]`.
- `.github/workflows/ci.yml`: single job named `ci` (the required check context for the T5 ruleset) running npm ci on Node 24, `tsc` against `tsconfig.json` (JSDoc typecheck, §3), actionlint pinned v1.7.12 (release-binary download, one acquisition shared with local runs) on both workflow files, byte-equality check (`cmp`), pack smoke (`npm pack --dry-run`, bin stub runs and exits 1).
- `RELEASE.md`: blueprint §6 secret/variable fixed names, §7 toolchain pins (protected job Node 24.11.1 + npm 11.6.2; verify fallback Node 22), `release` Environment requirement (T3), App installation (T11), trusted-publisher workflow-filename note, §10 first-release checklist. README links it.
- Repo settings, applied during implementation via gh-axi (npm package, pinned 0.1.30, invoked as `npx -y gh-axi`): `release` Environment with a required reviewer (repo owner assumed; blueprint T3 needs approval to gate) and a main ruleset requiring PR review + the `ci` check (§9: PR review is the release gate; the kit enforces it on itself). Concrete configuration: resolve the owner's user id via `gh-axi api users/<owner>`; create the Environment with `gh-axi api -X PUT /repos/vipentti/npm-release-flow/environments/release` and body `{"protection_rules":[{"type":"required_reviewers","parameters":{"reviewer_ids":[<owner id>]}}]}`; create the ruleset with `gh-axi api -X POST /repos/vipentti/npm-release-flow/rulesets` and body `{"name":"main protection","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["refs/heads/main"],"exclude":[]}},"rules":[{"type":"pull_request","parameters":{"required_approving_review_count":1}},{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,"contexts":["ci"]}}]}`.

Out of scope, later planlets or captain: CLI logic and workflow job-body logic, secret/variable *values* (key generation, App installation, secrets creation are captain/vault actions; this planlet only documents them), making the repo public (§10 step 2), first publish, consumer migrations.

## Approach

- One repository, one version, two artifacts (§3); the workflow never carries a version input, so both artifacts stay in lockstep (T8).
- Bin name `npm-release-flow`, single binary with subcommands `prepare`/`tag`/`check` (§8); the blueprint fixes the command set, not the binary name.
- Workflow written directly from the blueprint's literal YAML; structural completeness (interface, permissions, checkout plumbing) is this planlet's deliverable, functional completeness is the CLI planlet's.
- No build step: checked-in `.mjs` is what executes; type safety via JSDoc + `tsc` against the `tsconfig.json` scope in CI.
- actionlint pinned to v1.7.12, acquired identically in CI and locally from the pinned release tarball (`https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_x86_64.tar.gz`), always invoked on the same two workflow files (`.github/workflows/release.yml`, `.github/workflows/ci.yml`); no unpinned or alternative acquisition.
- Repo settings applied last so nothing gates this planlet's own PR.

## Acceptance Criteria

- Fresh-checkout `npm ci` succeeds; `npm pack --dry-run` lists only `bin`/`src`/`workflow` files plus package.json/README/LICENSE; `repository.url` equals `git+https://github.com/vipentti/npm-release-flow.git`; package.json contains exactly `main: "./src/index.mjs"`, root `exports` mapping to `"./src/index.mjs"`, and `bin.npm-release-flow: "./bin/npm-release-flow.mjs"`; `node bin/npm-release-flow.mjs` prints usage and exits 1.
- `tsc` against the `tsconfig.json` scope (`target: "ES2023"`, explicit) passes with zero errors; actionlint v1.7.12 (pinned acquisition) is clean on both workflow files; CI is green on the implementation branch.
- `release.yml` matches §5: no `inputs`; exactly the four `NPM_RELEASE_FLOW_*` secrets, all `required: true`; outputs `is-release`/`version`; `permissions: {}`; `environment: release` and `id-token: write` on the `release` job only.
- `workflow/release.yml` is byte-identical to `.github/workflows/release.yml` (CI-enforced); both copies pin `actions/checkout` at exactly `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1).
- RELEASE.md names every §6 secret/variable exactly and both §7 pins; README links it.
- `release` Environment exists with the owner as required reviewer; the main ruleset (gh-axi 0.1.30) requires PR review and the `ci` check context; both verified via `gh-axi api`.
- `planlet validate initial-setup` passes.

## Verification

- Local, per task: `npm ci && npm run typecheck` (tsc against `tsconfig.json`), actionlint via the pinned v1.7.12 release-binary download (`curl -fsSL https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_x86_64.tar.gz | tar -xz actionlint`, then `./actionlint .github/workflows/release.yml .github/workflows/ci.yml`), `cmp .github/workflows/release.yml workflow/release.yml`, `npm pack --dry-run`, stub run. CI (ci.yml) runs the same checks, same pinned acquisition and invocation, on every PR; the main ruleset requires them.
- Reviewer-confirmed external gates: §5 interface invariants against the blueprint (review), and API-visible state for T5 (`gh-axi api` queries for the Environment and the ruleset).
- Known limitation: workflow job bodies cannot execute until the CLI planlet provides the kit scripts and a consumer calls the workflow; functional verification is deferred, structural verification (actionlint, interface review, byte equality) is this planlet's bar.
- Secrets/variables presence before first release is documented (RELEASE.md), not created; the later `check` command verifies presence.

## Risks and Considerations

- The packaged workflow copy can drift from `.github/workflows/release.yml`; the CI byte-equality check is the guard.
- Job bodies calling not-yet-implemented scripts are inert (no caller exists) but must stay actionlint-clean; the CLI planlet must replace them before any consumer adopts the workflow.
- The main ruleset requires CI checks that only exist after this planlet lands; settings are applied last and the ruleset only starts enforcing once the checks run.
- actionlint v1.7.12 is a pinned third-party binary download; upgrades are deliberate version bumps in the one shared acquisition step, so CI and local runs stay in lockstep by construction.
