# Release prerequisites

This repository is the npm-release-flow kit: the `@vipentti/npm-release-flow` npm package and the
reusable `.github/workflows/release.yml` workflow (one repository, one version, blueprint §3).
This page is the release checklist for this repository, the kit releasing itself. Consumers
receive their own copy of these requirements when they adopt the kit.

Blueprint pin: `vipentti/agent-blueprints` @ `f9d06c77b9920e4cfab774d254f22d60894c1f05`,
`blueprints/npm-release-flow.md`. Section numbers below refer to that document.

## Secrets (Actions, repository scope)

All four are named in the reusable workflow with `required: true`; a caller missing one fails at
call time (T10).

| Secret | Purpose |
| --- | --- |
| `NPM_RELEASE_FLOW_GPG_PRIVATE_KEY` | GPG private key; signs the release tag (§6) |
| `NPM_RELEASE_FLOW_GPG_PASSPHRASE` | Passphrase for the private key (§6) |
| `NPM_RELEASE_FLOW_GPG_PUBLIC_KEY` | Public key; verify-only reruns, private key never loaded (§6) |
| `NPM_RELEASE_FLOW_APP_PRIVATE_KEY` | GitHub App private key; the only tag-push identity (T11) |

## Variables (Actions, repository scope)

| Variable | Purpose |
| --- | --- |
| `NPM_RELEASE_FLOW_GPG_FINGERPRINT` | Primary fingerprint the tag signature must match (§6) |
| `NPM_RELEASE_FLOW_GIT_NAME` | Git identity used for release commits and tags |
| `NPM_RELEASE_FLOW_GIT_EMAIL` | Git identity used for release commits and tags |
| `NPM_RELEASE_FLOW_APP_ID` | GitHub App id of the tag-push identity (§6) |

## Release environment

- A `release` Environment must exist: the GitHub Environment approval gates publication (T3).
  `environment: release` is a fixed convention, never an input.
- Current state (2026-08, initial setup): the Environment exists **without** a required reviewer:
  the `required_reviewers` protection rule is only available on public repositories under the
  current billing plan (planlet, public, has it; this repository is private). When the repository
  goes public (blueprint §10 step 2), add the rule with
  `gh api --method PUT repos/vipentti/npm-release-flow/environments/release --input env.json` and
  body `{"reviewers":[{"type":"User","id":<owner id>}]}`. Until then no approval gate exists;
  first release stays manual (checklist below).

## GitHub App

- The release App must be installed on this repository, scoped `contents: write`. It is the only
  identity allowed to push release tags; there is no `github.token` fallback (T11).

## Toolchain pins (§7)

- Protected job: Node `24.11.1` with npm `11.6.2`, asserted by exact version match, fail closed
  before any mutation.
- Verify job: the consumer's Node, read from `engines.node`; absent, fallback Node `22`.
- Floor (npm Trusted Publishing): npm CLI >= 11.5.1, Node >= 22.14.0. The v1 pin clears both.

## Trusted Publisher

- npm Trusted Publishing validates the **calling** workflow's filename, not the workflow that
  contains the publish command. A consumer's Trusted Publisher config must name the consumer's own
  workflow file, exactly. Strong recommendation: `.github/workflows/release.yml`. The kit cannot
  enforce the name; it is documented loudly instead.

## First-release checklist (§10)

1. Workflow file exists in the repository.
2. Manual first publish with a token, once: a brand-new package cannot OIDC-publish its first
   version (the trusted publisher must be configured on npmjs.com and the workflow file must
   already exist in the repository).
3. Configure the trusted publisher on npmjs.com: repository, workflow filename, allowed action
   `npm publish`.
4. Secrets and variables above.
5. `release` Environment with a required reviewer.
6. App installation (mandatory, §6).
7. `repository.url` in `package.json` exactly matches the GitHub repository.

After the first publish the kit releases itself with its own workflow (dogfooding, §10).
