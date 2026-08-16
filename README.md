# npm-release-flow

Reusable npm release toolkit: a GitHub Actions release workflow plus the
`@vipentti/npm-release-flow` CLI package. A repository that adopts the
workflow gains a release pipeline that detects release merges, verifies and
packs the consumer, GPG-signs the release tag, pushes it as the release
GitHub App, and publishes to npm through Trusted Publishing with provenance.

## Status

The repository is public and the package is published at version `0.1.1`.
The kit releases itself with its own workflow; see [RELEASE.md](RELEASE.md).

Supported Node: `>=22.14.0` (from `engines`). The protected release job pins
Node `24.11.1` / npm `11.6.2` and asserts both by exact version; the verify
job runs on the consumer's Node from `package.json` `engines.node`.

## Installation

Once published, a consumer installs the CLI as an exact devDependency:

```sh
npm install --save-dev --save-exact @vipentti/npm-release-flow
```

The installed devDependency version must correspond to the workflow's pinned
commit (see [Reusable workflow](#reusable-workflow)); both move together in a
single upgrade PR. The verify job hard-fails a normal consumer whose
installed kit copy is absent or version-mismatched, so this pin is
mandatory, not optional.

Until the first real release, use the CLI from a checkout with
`node bin/npm-release-flow.mjs` (the development commands below run it
locally); the published `0.0.0` is a bootstrap placeholder and is
deprecated once the real release lands.

## CLI

```
usage: npm-release-flow <prepare|tag|check> [--execute] [--version X.Y.Z]
```

Every command is **dry-run by default** and prints its planned mutations;
pass `--execute` to perform them. Exit codes: `0` success, `1` a failed
precondition or mutation, `2` a detected-already-present release.

- `check` - non-mutating validation of every release prerequisite (control
  files, secrets and variables by name, the `release` Environment, the App
  installation, local git/gh state, and both signing preflights). Lists every
  problem, not just the first. `--execute` is accepted as a no-op.
- `prepare --version X.Y.Z` - cut a `release/vX.Y.Z` branch with the release
  changes (changelog cut, version bump in `package.json` and
  `package-lock.json`, signed commit), push it, and open the release PR with
  the kit-version skew marker in the body.
- `tag --version X.Y.Z` - create the annotated, GPG-signed tag `vX.Y.Z` on
  the release merge at `origin/main` and push it authenticated as the release
  GitHub App. Refuses unsigned or lightweight tags; a valid remote tag
  verifies without pushing.

## Release flow

1. `prepare` opens a release PR. Merging it pushes a commit to `main` whose
   diff is exactly `CHANGELOG.md`, `package.json`, and `package-lock.json`
   with a strict stable version increase.
2. The reusable workflow's `detect` job classifies the push
   (`is-release`/`version`), then the `verify` job runs the consumer's
   `npm run release:verify`, packs the tarball, and hands off its sha256.
3. The protected `release` job revalidates, GPG-signs the tag, pushes it as
   the release GitHub App, and publishes to npm (verify-or-idempotent).

## Reusable workflow

The workflow takes **no inputs**. It reads the package name, version, and
tarball from the consumer's `package.json` at the triggering commit and runs
the fixed `npm run release:verify` convention. All four secrets are passed
by name (never `secrets: inherit`):

| Secret                             | Purpose                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| `NPM_RELEASE_FLOW_GPG_PRIVATE_KEY` | GPG private key; signs the release tag                   |
| `NPM_RELEASE_FLOW_GPG_PASSPHRASE`  | Passphrase for the private key                           |
| `NPM_RELEASE_FLOW_GPG_PUBLIC_KEY`  | Public key; verify-only reruns, private key never loaded |
| `NPM_RELEASE_FLOW_APP_PRIVATE_KEY` | GitHub App private key; the only tag-push identity       |

Call it at a **full 40-character commit SHA**, never a branch or tag. The
caller contract (identical to this repository's own
`.github/workflows/self-release.yml`):

```yaml
name: release

on:
  push:
    branches: [main]

permissions: {}

concurrency:
  group: release-main
  cancel-in-progress: false
  queue: max

jobs:
  release:
    uses: vipentti/npm-release-flow/.github/workflows/release.yml@e2e32a756c374d62f35e460cc4020b071d449750
    permissions:
      contents: write
      pull-requests: read
      id-token: write
    secrets:
      NPM_RELEASE_FLOW_GPG_PRIVATE_KEY: ${{ secrets.NPM_RELEASE_FLOW_GPG_PRIVATE_KEY }}
      NPM_RELEASE_FLOW_GPG_PASSPHRASE: ${{ secrets.NPM_RELEASE_FLOW_GPG_PASSPHRASE }}
      NPM_RELEASE_FLOW_GPG_PUBLIC_KEY: ${{ secrets.NPM_RELEASE_FLOW_GPG_PUBLIC_KEY }}
      NPM_RELEASE_FLOW_APP_PRIVATE_KEY: ${{ secrets.NPM_RELEASE_FLOW_APP_PRIVATE_KEY }}
```

- Top-level `permissions: {}`; the calling job's permissions
  `contents: write` + `pull-requests: read` + `id-token: write` are the union
  the workflow's jobs need (the workflow narrows them per job).
- `concurrency` group `release-main` with `cancel-in-progress: false` (a
  pushed tag must never end up without a package) and `queue: max` (the
  default `queue: single` replaces a pending run in the same group, which
  could silently drop a release-triggering push; `queue: max` allows up to
  100 pending runs).
- The pin must advance to the next release commit after each release, in an
  ordinary PR, always to a full 40-character SHA. A stale pin fails the next
  release's marker check.
- Secret contract: unset secret expressions evaluate to the empty string.
  Ordinary pushes are non-release detection runs and stay green; a release
  attempt cannot complete until the secrets a path needs exist (each release
  path asserts non-empty the secrets it actually uses before mutation).
- Kit checkout: the workflow checks out the kit to
  `${{ runner.temp }}/npm-release-flow-kit` outside the consumer worktree so
  consumer tooling (knip, lint, format, git) never scans kit internals.
  Consumers still pinned to `e2e32a7` and earlier vendor the kit at
  `.npm-release-flow/` inside the worktree; until you advance the pin,
  exclude that path locally:

  `.gitignore`

  ```gitignore
  .npm-release-flow/
  ```

  `knip.json`

  ```json
  {
    "ignore": [".npm-release-flow/**"]
  }
  ```

  `eslint.config.mjs`

  ```js
  export default [{ ignores: [".npm-release-flow/"] }];
  ```

  `.prettierignore`

  ```gitignore
  .npm-release-flow/
  ```

## Consumer prerequisites

Run `npm-release-flow check` from the consumer root; it validates all of the
following:

- `CHANGELOG.md` with exactly one bare `## [Unreleased]` section containing
  non-empty notes.
- A `release:verify` npm script (the fixed convention the workflow runs).
- A committed `package-lock.json`.
- The four `NPM_RELEASE_FLOW_*` secrets and four `NPM_RELEASE_FLOW_*`
  variables set on the repository (secrets are checked by name only).
- A `release` Environment with required-reviewer protection.
- The release GitHub App installed with `contents: write`.
- The exact `@vipentti/npm-release-flow` devDependency matching the workflow
  pin (normal consumers; the kit itself is exempt).
- Local `gh` authentication, a git identity, a commit-signing key, and the
  release GPG fingerprint's secret key in the local keyring.

## Failure diagnostics

Command-failure `Found:` messages prefer captured stderr and fall back to
captured stdout when stderr is empty (for example, `git diff --exit-code` at
the end of `release:verify` writing a diff to stdout). The selected detail is
capped so the returned string including `\n...[truncated]` is at most
8192 characters.

## Security and trust model

- Consumer-controlled code (dependency installs, `release:verify`, build)
  runs only in the unprivileged `verify` job, which has no `id-token`.
- The protected `release` job never installs consumer dependencies and
  executes no repository-owned code.
- Release secrets are scoped late: loaded only after revalidation, per path,
  and never on verify-only reruns.
- Tags are GPG-signed; the GitHub App is the only tag-push identity (no
  `github.token` fallback).
- npm publication uses Trusted Publishing with provenance, registry pinned to
  npmjs.com.
- The App-token minting, signing, and release mutations are covered by tests
  (`test/`), and `release:verify` gates every release.

## Development

From a checkout:

```sh
npm ci
npm run lint        # eslint
npm run format:check # prettier
npm run typecheck   # tsc
npm run knip        # unused-code and dependency checks
npm test            # node --test (real git/gpg fixtures)
npm run release:verify  # all of the above, in order
```

The CI workflow runs two jobs: `ci` on Linux runs the full authoritative
suite (lint, format:check, typecheck, knip, tests, actionlint, pack/CLI
smoke) and is the branch-protection required check; `windows` is additive
coverage running the test suite on Windows, which is what exercises the
Windows-specific path handling (MSYS gpg/tar, cmd spawn, git signing). See
[RELEASE.md](RELEASE.md) for the release checklist and the exact human
sequences (going public, first npm release).

On Windows, the kit's signing and pack-extraction paths support both the
Git for Windows / MSYS2 toolchain (the default when Git for Windows is on
PATH) and native tar: the Git-bundled `gpg` and GNU `tar` receive paths in
MSYS form, while a native `tar` (Windows ships bsdtar) is detected and
receives native paths. Only a custom native (non-MSYS) `gpg.program`
remains unsupported: gpg always receives the MSYS path form.

## License

MIT. See [LICENSE](https://github.com/vipentti/npm-release-flow/blob/main/LICENSE).
