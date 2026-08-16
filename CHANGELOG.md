# Changelog

## [Unreleased]

## [0.1.2] - 2026-08-16

### Changed

- The reusable workflow now checks out the kit to
  `${{ runner.temp }}/npm-release-flow-kit` outside the consumer worktree
  so consumer tooling never scans kit internals. Consumers still pinned to
  `e2e32a7` and earlier must exclude `.npm-release-flow/` locally (gitignore,
  knip, eslint, prettier) until the pin is advanced.

## [0.1.1] - 2026-08-16

### Fixed

- Command-failure `Found:` messages now prefer captured stderr and fall back
  to captured stdout when stderr is empty (capped at 8192 characters including
  `\n...[truncated]`). This surfaces stdout-only failures such as
  `git diff --exit-code` at the end of `release:verify` instead of falling back
  to the generic message.

## [0.1.0] - 2026-08-12

- CLI commands `prepare`, `tag`, and `check` with a dry-run default and an
  `--execute` mutation flag.
- Reusable GitHub Actions workflow `release.yml` with no inputs and four
  named, required secrets (`detect`, `verify`, and a protected `release` job).
- GPG-signed release tags, pushed exclusively as the release GitHub App (no
  `github.token` tag-push fallback).
- npm publication through Trusted Publishing with provenance, registry
  pinned to npmjs.com.
- Consumer-controlled code runs only in the unprivileged `verify` job; the
  protected `release` job never installs consumer dependencies and loads
  secret material only after revalidation.

[Unreleased]: https://github.com/vipentti/npm-release-flow/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/vipentti/npm-release-flow/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/vipentti/npm-release-flow/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/vipentti/npm-release-flow/compare/v0.0.0...v0.1.0
