# slop-stop threat model (v1)

## Goals

- Builders with agent assistance can **modify existing files** only inside declared zones.
- Guardrails (policy, CI, CODEOWNERS, workflows) require **owner** review to change.
- Builder PRs cannot merge without **human CODEOWNER** approval and passing required checks.
- Trusted CI **`slop-stop/check`** never executes code from the PR head; it treats the diff as data.

## Trust boundaries

| Layer | Trust level | Notes |
|-------|-------------|-------|
| `slop-stop/check` on `pull_request_target` | High | Runs from default-branch workflow; uses base-ref policy |
| `slop-stop/safety` on `pull_request` | Low (advisory) | Checks out PR head and runs `safety_check`; malicious PR could exfiltrate secrets if the command is unsafe |
| Local agent + skills | Low | Convenience; server checks are authoritative |
| `doctor` | Read-only | Does not change GitHub settings in v1 |

## Builder identity

- v1 identifies builder PRs by branch prefix `slop-stop/<builder>/*`, and the GitHub PR author login must equal `<builder>`.
- Git commit author fields are **not** used (spoofable); the PR author comes from the GitHub event.
- Owners should enforce branch prefix via GitHub Rulesets where available (`doctor` reports not enforceable on some tiers).
- `check` and `safety` live in separate workflow files, so neither event produces a skipped job with a required check's name.

## Enforced in check (builder PRs)

- Out-of-zone paths and global `deny` globs
- PR author must match the builder in the branch prefix
- Edits to `.slop-stop/**`, `.github/**`, any `CODEOWNERS`, `AGENTS.md`, or `CLAUDE.md`, agent hook dirs
- New, deleted, renamed, or copied files; file type changes (e.g. file to symlink); dependency manifests; `.env*`; binary patches
- Bidirectional / zero-width Unicode in added lines
- gitleaks (or built-in secret patterns if gitleaks missing)
- Zone invariants and one zone per PR
- Unguarded zones unless `accept_unguarded` is documented in policy

## Known bypasses and mitigations

1. **Malicious workflow on PR head** — A builder could edit `.github/workflows` to skip checks. **Mitigation:** trap rule blocks `.github/**` for builders; only owners merge workflow changes; pin Action tag to release.
2. **Safety job runs PR code** — `safety_check` must be a read-only test command chosen by the owner. **Mitigation:** label advisory in doctor; do not grant secrets to the safety job.
3. **Owner account compromise** — Out of scope; slop-stop assumes owners are trusted.
4. **Unguarded zone** — Weak or missing tests. **Mitigation:** canary in doctor; check blocks touches to unguarded zones unless `accept_unguarded`.
5. **Direct push to target** — **Mitigation:** branch protection; doctor audit.

## Non-goals (v1)

- GitLab / Bitbucket
- Auto-merge prevention via API apply
- AI reviewers as merge gates
- Builders adding dependencies (blocked by traps)
