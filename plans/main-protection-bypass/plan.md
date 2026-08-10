# Main protection ruleset: admin-role bypass

## Summary

Amend the live `main protection` branch ruleset (created by the `initial-setup` planlet, task T5) so the repository owner (admin role) can self-merge while non-admins still require 1 approving review. The ruleset currently has `required_approving_review_count: 1` and no `bypass_actors`; GitHub never counts the PR author's approval, so it blocks the owner's own merges. `bypass_mode: "always"` is a ruleset-level bypass: it exempts admins from BOTH the review requirement and the required `ci` status check, while both rules remain enforced for non-admins. The gate stays for everyone else.

## Amendment record

Amends the `initial-setup` planlet's T5 ruleset body for `vipentti/npm-release-flow` `main protection` (ruleset id `20612037`): adds `"bypass_actors": [{"actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always"}]` to the existing body, where RepositoryRole actor_id 5 is the predefined admin role on GitHub.com. Every other field of the existing body is preserved unchanged. This planlet is the amendment record; the `initial-setup` plan files are not edited.

## Scope

- Adds the admin-role `bypass_actors` entry to the single existing `main protection` ruleset (id `20612037`), `target: branch`, `enforcement: active`.
- Pull-request rule parameters unchanged: `required_approving_review_count: 1`; `required_status_checks` with context `ci` still configured. GitHub defines bypass permissions at ruleset level, not per rule, so the admin-role `always` bypass exempts admins from BOTH the review requirement and the `ci` status-check requirement; non-admins are still subject to both.
- Everything else untouched: the tag rulesets (`release-tag creation`, `release-tag immutability`), the `release` Environment, and all product code.

## Approach

- Implementation is the live mutation, not file changes: `gh api --method PUT /repos/vipentti/npm-release-flow/rulesets/20612037 --input ruleset.json`, where `ruleset.json` is initial-setup T5's writable ruleset body (name `main protection`, target branch, enforcement active, conditions ref_name include `refs/heads/main` / exclude empty, the pull_request rule with all five parameters and `required_approving_review_count: 1`, required_status_checks with context `ci` and strict policy true) plus ONLY the `bypass_actors` array (the one admin-role entry).
- Verify with a GET of the same ruleset via `gh api`.
- The PR carries only the planlet files; the ruleset mutation is done directly against the live ruleset.

## Acceptance Criteria

- GET of ruleset `20612037` shows `bypass_actors` containing `{actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always"}`.
- `enforcement` still `active`; `required_approving_review_count` still `1`; `required_status_checks` still contains context `ci` (both rules still enforced for non-admins; admins bypass both through the ruleset-level `always` bypass).
- Owner (admin) can merge without a review and without the `ci` check; a non-admin still needs 1 approving review and the `ci` check.
- `planlet validate main-protection-bypass` passes.
- The planlet task checklist (T1-T3 checked) is committed and pushed with the PR head; task state does not trail committed state.

## Verification

- Per task, read-only GET-based checks via `gh api` with `--jq` filters (handled in tasks.md): bypass actor present, full main config matches the expected amended T5 body, `ci` required status check still present (configured, enforced for non-admins), enforcement active, and both tag rulesets unchanged.
- The self-merge behavior itself is the purpose of the change; the acceptance criteria capture the observable state that establishes it.

## Risks and Considerations

- Admin-role bypass is the intended tradeoff made by the captain: the owner retains the review gate for everyone else while unblocking their own merges.
- The ruleset mutation is a live change to the default-branch protection; it is applied during this planlet's implementation and does not wait for the PR merge.
