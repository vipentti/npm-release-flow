# Release checklist

This repository is the npm-release-flow kit: the `@vipentti/npm-release-flow`
npm package and the reusable `.github/workflows/release.yml` workflow (one
repository, one version). This page is the self-release checklist for this
repository; consumers receive their own copy of the requirements when they
adopt the workflow (see README.md).

Everything a reader needs is in this file.

## Automated / repository state (implemented)

- Reusable workflow `.github/workflows/release.yml`: `detect`, `verify`, and
  a protected `release` job. No inputs; four named, required secrets. See
  README.md for the caller contract.
- Self-release caller `.github/workflows/self-release.yml`: pushes to `main`
  only, pinned to the full commit SHA `2ddb84caa71d25946a8c718d9364ef6db2699704`
  (the 0.1.0 release). The pin advances
  again, in an ordinary PR, after each release (see below).
- CI `.github/workflows/ci.yml`: the full local suite in the `ci` job
  (Linux, the required status check) plus actionlint on every workflow
  file, with additive Windows test coverage in the separate `windows` job.
- Rulesets (active): `main` (no deletion, no non-fast-forward, required
  linear history, squash-only pull requests, required signatures), `main
protection` (one approving review, required status check `ci`), `release-tag
creation`, and `release-tag immutability`.
- The `release` Environment exists, **without** a required reviewer yet:
  the `required_reviewers` protection rule is only available on public
  repositories. The repository is public now, so add the rule before the
  first release (see below).
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
the workflow that contains the publish command. npm matches the filename
only, so the Trusted Publisher on npmjs.com must name exactly
`self-release.yml` (repository `vipentti/npm-release-flow`, environment
`release`, allowed action `npm publish`). Bind the environment field to
`release`: that is where the OIDC-bearing publish job is gated by the
Environment approval.

## Making the repository public (completed)

The repository was made public in this order:

1. The release-bootstrap PR (#6) merged while the repository was still
   private: going public first would have exposed the old README, no
   SECURITY.md, the old CI, and no self-release caller for some interval.
   It landed on `main` before the visibility change.
2. The resulting `main` CI (the `ci` check) was confirmed green.
3. The final pre-public checks ran against that `main`:
   `npm run release:verify`, actionlint on all workflow files,
   `npm pack --dry-run` inspection, and the gitleaks history scan.
4. The repository was made public (Settings, Danger Zone), which is what
   unlocks the `required_reviewers` Environment rule (still to be added;
   see Human-required setup below).

## First npm release (exact bootstrap order)

The package does not exist on the registry yet, and a brand-new package
cannot OIDC-publish its first version: npm requires the package to already
exist before Trusted Publishing can be configured. So the bootstrap
publishes a throwaway `0.0.0` under a non-default `bootstrap` dist-tag, and
the first real automated release (for example `1.0.0`) is the one published
through Trusted Publishing with provenance. The release-diff allowlist
permits exactly `CHANGELOG.md`, `package.json`, and `package-lock.json` in a
release PR, so the control-file changes below live in ordinary PRs. Follow
this order exactly:

1. The release-bootstrap PR (#6) merged, its resulting `main` CI (the `ci`
   check) was confirmed green, and the final pre-public checks ran against
   that `main`, all while the repository was still private; then the
   repository was made public (above).
2. An **ordinary PR** advanced the caller pin to this PR's **actual
   squash-merge commit on `main`** and removed `"private": true`, keeping
   the version `0.0.0`: it updated `.github/workflows/self-release.yml` and
   the README caller example to that commit's SHA (full 40-character SHA)
   and dropped `"private": true` from `package.json`. The pin is the commit
   that landed on `main` after the squash merge, not the PR head and not
   GitHub's pre-merge synthetic merge SHA. The pin advance is required
   before the first release: the called workflow checks out the kit at the
   pin, and the skew guard compares only the semantic version, so a stale
   pin would run the pre-merge kit source while passing the guard as
   equivalent (`0.0.0` == `0.0.0`). `"private": true` cannot be removed
   inside a release PR: that would change a fourth file and invalidate the
   release diff.
3. Manually publish `0.0.0` as a bootstrap-tagged package (the registry
   prerequisite) with an npm auth token, explicitly public and pinned to
   npmjs.org:

   ```sh
   npm publish --tag bootstrap --access public --registry https://registry.npmjs.org
   ```

   The package is scoped (`@vipentti/npm-release-flow`), so an initial
   public scoped publish must pass `--access public`; and `--registry`
   pins npmjs.org so a scope-level registry redirect cannot route the
   first publication elsewhere (the automated release pins the same
   registry). The workflow never verifies or publishes `0.0.0` (the first
   automated release is a higher version), so no `gitHead` handling is
   needed; deprecate it later if desired:

   ```sh
   npm deprecate @vipentti/npm-release-flow@0.0.0 "bootstrap version"
   ```

4. Configure Trusted Publishing on npmjs.com (filename `self-release.yml`,
   environment `release`, see above), set the secrets and variables above,
   add the required reviewer on the `release` Environment, and install the
   App.
5. From that `0.0.0` main, run (from a checkout, as the package is not yet
   releasable)
   `node bin/npm-release-flow.mjs prepare --version <first>` (for example
   `1.0.0`). The release PR body marker stays
   `Kit: @vipentti/npm-release-flow@0.0.0` because the kit checkout at the
   pin is still `0.0.0`, which matches the marker.
6. Merge the release PR. The self-release runs; the `release` job waits on
   the Environment approval gate, then creates the tag and publishes
   `<first>` through `npm publish --provenance` (the absent-version path;
   verify-or-idempotent against the registry).
7. Afterward, advance the caller pin in an ordinary PR (below).

## After each release (caller pin advance)

The self-release caller pins the workflow to a full 40-character commit SHA,
and the README caller example carries the same pin. After each self-release,
advance both to the release commit in a follow-up ordinary PR, always a full
40-character SHA (never a branch or tag). The release-diff allowlist is
exactly the three control files, so the pin cannot move inside a release PR;
and a stale pin fails the next release's marker check (`detect` compares the
PR body's `Kit: @vipentti/npm-release-flow@<v>` marker against the kit
checkout version at the pin) or runs the wrong kit source while the version
guard still passes.

## Secret contract

Unset secret expressions evaluate to the empty string (GitHub-documented).
Ordinary pushes are non-release detection runs and stay green; only release
attempts cannot complete until the secrets a path needs exist. Each release
path asserts non-empty the secrets it actually uses before any mutation: the
verify-only path (`tag-exists=true`) asserts `NPM_RELEASE_FLOW_GPG_PUBLIC_KEY`;
the tag-creation path (`tag-exists=false`) asserts
`NPM_RELEASE_FLOW_GPG_PRIVATE_KEY`, `NPM_RELEASE_FLOW_GPG_PASSPHRASE`, and
`NPM_RELEASE_FLOW_APP_PRIVATE_KEY`.
