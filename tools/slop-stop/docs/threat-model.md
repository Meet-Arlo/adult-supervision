# slop-stop threat model (v1)

## Goals

- Builders with agent assistance can **modify existing files** only inside declared zones.
- Guardrails (policy, CI, CODEOWNERS, workflows) require **owner** review to change.
- Builder PRs cannot merge without **human CODEOWNER** approval and passing required checks.
- Trusted CI **`slop-stop/check`** never executes code from the PR head; it treats the diff as data.

## Trust boundaries

| Layer | Trust level | Notes |
|-------|-------------|-------|
| `slop-stop/check` on `pull_request_target` | High | Default-branch workflow; checks out **base** SHA; fetches head as objects only; `persist-credentials: false` |
| `slop-stop/safety` on `pull_request` | Low (advisory) | Checks out PR head and runs `safety_check`; `persist-credentials: false` so the job token is not in `.git/config`. The runner process still has `GITHUB_TOKEN` (GitHub Actions). Do not grant extra secrets. |
| Local agent + skills | Low | Convenience; server checks are authoritative |
| `doctor` | Read-only | Does not change GitHub settings in v1 |

## Builder identity

- v1 identifies builder PRs by branch prefix `slop-stop/<builder>/*`, and the GitHub PR author login must equal `<builder>`.
- Git commit author fields are **not** used (spoofable); the PR author comes from the GitHub event.
- Builders can push to any branch except the target. The target branch needs a ruleset (or classic branch protection) that requires a PR with 1 approval including a CODEOWNER, dismisses stale approvals, blocks force pushes, and requires `slop-stop/check` and `slop-stop/safety`. Only the admin role should bypass, set to "For pull requests only". `doctor` reads both rulesets and classic protection and fails on any gap.
- The branch prefix is a convention, not a push restriction. Anyone listed in `builders` must use `slop-stop/<login>/<slug>` or `check` fails (`builder_branch_required`), even if they are also an owner. Owners who are not builders may use any branch; zone rules are skipped on those PRs.
- Builder PRs must target `policy.target_branch` (`wrong_merge_target` if not).
- Known gap: `check` skips zone rules on owner-only PRs, and a builder can push commits to an owner's PR branch. A new push dismisses earlier approvals, but an owner merging with admin bypass skips approvals entirely, so owners should review the commit list before merging their own PRs.
- `check` and `safety` live in separate workflow files, so neither event produces a skipped job with a required check's name.

## Enforced in check (builder PRs)

- Out-of-zone paths and global `deny` globs
- PR author must match the builder in the branch prefix
- Edits to `.slop-stop/**`, `.github/**`, any `CODEOWNERS`, `AGENTS.md`, or `CLAUDE.md`, agent hook dirs
- New, deleted, renamed, or copied files; file type changes (e.g. file to symlink); dependency manifests; `.env*`; binary patches
- Bidirectional / zero-width Unicode in added lines
- gitleaks (or built-in secret patterns if gitleaks missing)
- Zone invariants and one zone per PR
- Zones with no `safety_check` (and no `accept_unguarded`) block builder PRs in `check`

## Known bypasses and mitigations

1. **Malicious workflow on PR head** — A builder could edit `.github/workflows` to skip checks. **Mitigation:** trap rule blocks `.github/**` for builders; only owners merge workflow changes; pin Action tag to release.
2. **Safety job runs PR code** — `safety_check` must be a read-only test command chosen by the owner. **Mitigation:** `persist-credentials: false`; no extra secrets on the job; treat the job as advisory.
3. **Owner account compromise** — Out of scope; slop-stop assumes owners are trusted.
4. **Zone with no safety command** — Builder touches a zone with no `safety_check`. **Mitigation:** `check` fails until owner adds `safety_check` or `accept_unguarded`.
5. **Direct push to target** — **Mitigation:** branch protection; doctor audit.
6. **Untrusted tree + persisted token on `pull_request_target`** — checking out PR HEAD used to leave the base-repo token in `.git/config`. **Mitigation:** check checks out the base SHA; head is a one-shot `git fetch` of `pull/<n>/head`; `persist-credentials: false` on both workflows.

## Non-goals (v1)

- GitLab / Bitbucket
- Auto-merge prevention via API apply
- AI reviewers as merge gates
- Builders adding dependencies (blocked by traps)
