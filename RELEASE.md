# Release checklist

This repository is the npm-release-flow kit: the `@vipentti/npm-release-flow`
npm package and the reusable `.github/workflows/release.yml` workflow (one
repository, one version). This page is the self-release checklist for this
repository; consumers receive their own copy of the requirements when they
adopt the workflow (see README.md).

Everything a reader needs is in this file. Historical provenance only: the
accepted architecture lives in `vipentti/agent-blueprints`
(`blueprints/npm-release-flow.md`, pinned to commit
`f9d06c77b9920e4cfab774d254f22d60894c1f05`); nothing below requires access
to it.

## Automated / repository state (implemented)

- Reusable workflow `.github/workflows/release.yml`: `detect`, `verify`, and
  a protected `release` job. No inputs; four named, required secrets. See
  README.md for the caller contract.
- Self-release caller `.github/workflows/self-release.yml`: pushes to `main`
  only, pinned to the full commit SHA `764e09cf642997b736663e1711e69bbb6d71a43e`
  (the kit at version `0.0.0`).
- CI `.github/workflows/ci.yml`: the full local suite in a single `ci` job,
  plus actionlint on every workflow file.
- Rulesets (active): `main` (no deletion, no non-fast-forward, required
  linear history, squash-only pull requests, required signatures), `main
protection` (one approving review, required status check `ci`), `release-tag
creation`, and `release-tag immutability`.
- The `release` Environment exists, **without** a required reviewer: the
  `required_reviewers` protection rule is only available on public
  repositories, and this repository is still private. Add the rule when it
  goes public (see below).
- The kit's own mandatory consumer prerequisites are in place:
  `CHANGELOG.md` with a non-empty `## [Unreleased]` and the `release:verify`
  script.
- CLI `prepare` / `tag` / `check` with dry-run default and `--execute`.

## Human-required setup

### Secrets (Actions, repository scope)

| Secret                             | Purpose                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| `NPM_RELEASE_FLOW_GPG_PRIVATE_KEY` | GPG private key; signs the release tag                   |
| `NPM_RELEASE_FLOW_GPG_PASSPHRASE`  | Passphrase for the private key                           |
| `NPM_RELEASE_FLOW_GPG_PUBLIC_KEY`  | Public key; verify-only reruns, private key never loaded |
| `NPM_RELEASE_FLOW_APP_PRIVATE_KEY` | GitHub App private key; the only tag-push identity       |

All four are named in the reusable workflow with `required: true`; a caller
missing one fails at call time. Each release path asserts non-empty the
secrets it actually uses before mutation (see Secret contract below).

### Variables (Actions, repository scope)

| Variable                           | Purpose                                          |
| ---------------------------------- | ------------------------------------------------ |
| `NPM_RELEASE_FLOW_GPG_FINGERPRINT` | Primary fingerprint the tag signature must match |
| `NPM_RELEASE_FLOW_GIT_NAME`        | Git identity used for release commits and tags   |
| `NPM_RELEASE_FLOW_GIT_EMAIL`       | Git identity used for release commits and tags   |
| `NPM_RELEASE_FLOW_APP_ID`          | GitHub App id of the tag-push identity           |

### GitHub App

Install the release App on this repository, scoped `contents: write`. It is
the only identity allowed to push release tags; there is no `github.token`
fallback.

### Release Environment required reviewer

When the repository is public, add the required-reviewer rule with (replace
`<owner id>` with the reviewer's GitHub user id):

```sh
gh api --method PUT repos/vipentti/npm-release-flow/environments/release \
  --input - <<'EOF'
{"reviewers":[{"type":"User","id":<owner id>}]}
EOF
```

Until then no approval gate exists and the first release stays manual
(bootstrap below).

### Trusted Publisher

npm Trusted Publishing validates the **calling** workflow's filename, not
the workflow that contains the publish command. For this kit the caller is
`.github/workflows/self-release.yml`, so the Trusted Publisher on npmjs.com
must name exactly that file (repository `vipentti/npm-release-flow`, allowed
action `npm publish`).

## Before making the repository public

In order:

1. Complete the pre-public checks from this plan's verification:
   `npm run release:verify`, actionlint on all workflow files,
   `npm pack --dry-run` inspection, and the gitleaks history scan (a full
   local clone; if the scan could not run, run it before the visibility
   change).
2. Make the repository public (Settings, Danger Zone). This is what unlocks
   the `required_reviewers` Environment rule.

## First npm release (exact bootstrap order)

The first release is delicate because the package does not exist on the
registry yet and the release-diff allowlist permits exactly
`CHANGELOG.md`, `package.json`, and `package-lock.json` in a release PR.
Follow this order exactly:

1. Complete the pre-public checks and make the repository public (above).
2. In an **ordinary PR**, remove `"private": true` while the version stays
   `0.0.0`, and merge it. It cannot be removed inside the release PR: that
   would change a fourth file and invalidate the release diff.
3. From that `0.0.0` main, run
   `npm-release-flow prepare --version <first>` (for example `1.0.0`). The
   release PR body marker stays `Kit: @vipentti/npm-release-flow@0.0.0`
   because the prepared kit checkout is still the pinned `0.0.0` commit,
   which matches the caller pin.
4. **Before merging the release PR**, manually publish the prepared version:
   a brand-new package cannot OIDC-publish its first version. This must be a
   tarball-path publish of the exact prepared tarball:
   - On the release branch, produce the tarball: `npm pack` (the packed
     files are identical between the release branch and the merge commit, so
     `npm pack` yields the byte-identical tarball the verify job produces;
     npm pack output is deterministic).
   - Publish by tarball path with an npm auth token:
     `npm publish <tarball>.tgz`. A tarball-path publish records **no**
     `gitHead` in the registry manifest.
   - Verify the registry metadata before merging: `name`, `version`,
     `repository.url`, and `dist.integrity` equal to the local tarball's
     sha512 integrity, and **no incompatible `gitHead`**.
     Why: the release step's `publishedIdentityProblems` (src/release.mjs,
     covered in test/release.test.mjs) checks name, version, repository, and
     integrity unconditionally, and checks `gitHead` only when present. The
     eventual merge commit does not exist at manual-publish time, so a normal
     publish from the release branch would record a `gitHead` that cannot
     equal it, and the post-merge verify would hard-fail. A tarball-path
     publish omits `gitHead`, so the check is skipped and the identity/
     integrity checks pass.
5. Configure the Trusted Publisher for `.github/workflows/self-release.yml`,
   the secrets and variables above, the required reviewer on the `release`
   Environment, and the App installation.
6. Merge the release PR. Its `0.0.0` marker matches the pinned workflow, so
   the self-release runs; the tag/publish steps are verify-or-idempotent
   against the manual publish.
7. Afterward, advance the caller pin in an **ordinary PR** (below).

## After each release (caller pin advance)

The self-release caller pins the workflow to a full 40-character commit SHA.
After each self-release, advance the pin to the release commit in a follow-up
ordinary PR, always a full 40-character SHA (never a branch or tag). The
release-diff allowlist is exactly the three control files, so the pin cannot
move inside a release PR; and a stale pin fails the next release's marker
check (`detect` compares the PR body's `Kit: @vipentti/npm-release-flow@<v>`
marker against the kit checkout version at the pin).

## Secret contract

Unset secret expressions evaluate to the empty string (GitHub-documented).
Ordinary pushes are non-release detection runs and stay green; only release
attempts cannot complete until the secrets a path needs exist. Each release
path asserts non-empty the secrets it actually uses before any mutation: the
verify-only path (`tag-exists=true`) asserts `NPM_RELEASE_FLOW_GPG_PUBLIC_KEY`;
the tag-creation path (`tag-exists=false`) asserts
`NPM_RELEASE_FLOW_GPG_PRIVATE_KEY`, `NPM_RELEASE_FLOW_GPG_PASSPHRASE`, and
`NPM_RELEASE_FLOW_APP_PRIVATE_KEY`.
