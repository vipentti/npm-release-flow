# Changelog

## [Unreleased]

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

[Unreleased]: https://github.com/vipentti/npm-release-flow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/vipentti/npm-release-flow/compare/v0.0.0...v0.1.0
