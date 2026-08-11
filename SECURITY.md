# Security Policy

## Supported versions

This project is pre-first-stable-release: there are no supported versions
yet. Once the first stable version is published, this policy will name the
supported release line(s). Until then, only the current `main` branch is
supported.

## Reporting a vulnerability

Do not file vulnerabilities as public issues or PRs. Report them through
GitHub private vulnerability reporting (the repository's Security tab) so
the maintainer can respond before the issue is disclosed. If private
vulnerability reporting is unavailable, contact the maintainer privately
through a GitHub profile; there is no public contact address.

## Scope

Reports that matter most to this project:

- Release workflow privilege boundaries: consumer code escaping the
  unprivileged `verify` job or reaching the protected `release` job.
- Credential and secret exposure: release secrets, the GitHub App private
  key, or GPG private material leaking into logs, artifacts, or the tarball.
- GitHub App token handling: token minting, scoping, or misuse of the
  tag-push identity.
- GPG signing: signature forgery, weak key handling, or bypass of the
  signed-tag requirement.
- npm Trusted Publishing and provenance: impersonation, registry
  redirection, or tampering with the published artifact.
- Tag protections: unauthorized tag creation or divergence from the verified
  release merge.
- Release validation bypasses: revalidation, artifact-integrity, or
  pin-agreement checks being skipped or weakened.

Out of scope: issues in the consumer's own release configuration or
repository settings that the kit documents but cannot enforce.
