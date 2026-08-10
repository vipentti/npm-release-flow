# Main protection ruleset: admin-role bypass

## Summary

Amend the live `main protection` branch ruleset (created by the `initial-setup` planlet, task T5) so the repository owner (admin role) can self-merge while non-admins still require 1 approving review. The ruleset currently has `required_approving_review_count: 1` and no `bypass_actors`; GitHub never counts the PR author's approval, so it blocks the owner's own merges. The gate stays for everyone else.

## Amendment record

Amends the `initial-setup` planlet's T5 ruleset body for `vipentti/npm-release-flow` `main protection` (ruleset id `20612037`): adds `"bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]` to the existing body, where RepositoryRole actor_id 5 is the predefined admin role on GitHub.com. Every other field of the existing body is preserved unchanged. This planlet is the amendment record; the `initial-setup` plan files are not edited.

## Scope

- Adds the admin-role `bypass_actors` entry to the single existing `main protection` ruleset (id `20612037`), `target: branch`, `enforcement: active`.
- Pull-request rule parameters unchanged: `required_approving_review_count: 1`; `required_status_checks` with context `ci` still required.
- Everything else untouched: the tag rulesets (`release-tag creation`, `release-tag immutability`), the `release` Environment, and all product code.

## Approach

- Implementation is the live mutation, not file changes: `gh-axi api PUT /repos/vipentti/npm-release-flow/rulesets/20612037 --field body=@ruleset.json`, where `ruleset.json` is the current GET body plus the `bypass_actors` array (and only that change).
- Verify with a GET of the same ruleset.
- The PR carries only the planlet files; the ruleset mutation is done directly against the live ruleset.

## Acceptance Criteria

- GET of ruleset `20612037` shows `bypass_actors` containing `{actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always"}`.
- `enforcement` still `active`; `required_approving_review_count` still `1`; `required_status_checks` still contains context `ci`.
- Owner (admin) can merge without a review; a non-admin still needs 1 approving review.
- `planlet validate main-protection-bypass` passes.

## Verification

- Per task, GET-based checks via `gh-axi api` with `--jq` filters (handled in tasks.md): bypass actor present, review count still 1, `ci` required status check still present, enforcement active, and a read-only confirmation that the ruleset's conditions still include `refs/heads/main`.
- The self-merge behavior itself is the purpose of the change; the acceptance criteria capture the observable state that establishes it.

## Risks and Considerations

- Admin-role bypass is the intended tradeoff made by the captain: the owner retains the review gate for everyone else while unblocking their own merges.
- The ruleset mutation is a live change to the default-branch protection; it is applied during this planlet's implementation and does not wait for the PR merge.
