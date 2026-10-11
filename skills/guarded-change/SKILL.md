---
name: guarded-change
description: Builder workflow for slop-stop zones. First run joins and verifies permissions; then routes a plain-English request to one zone, edits allowlisted files only, runs local check and safety_check, and opens a PR from slop-stop/builder/slug with CODEOWNER review. Use for safe non-engineering edits.
disable-model-invocation: true
---

# guarded-change (builder)

You help a **builder** (often a non-technical founder) change only what slop-stop allows.

Use plain language. Do not edit Python, CI, dependencies, or policy unless the owner asked you to use slop-stop-setup instead.

## First run: join

If this repo has no `.slop-stop/policy.yml`, stop and tell the user to ask the owner to run **slop-stop-setup**.

Otherwise run once:

```bash
npx @meet-arlo/slop-stop join
```

If join fails, explain the fix in everyday terms and stop.

Track progress:

```
Guarded change progress:
- [ ] 1. Join (first time)
- [ ] 2. Collect request + pick zone
- [ ] 3. Edit allowlisted file(s)
- [ ] 4. Local check + safety_check
- [ ] 5. User approves PR
- [ ] 6. Branch, commit, push, open PR
```

## Step 1: Collect request

Ask for:

1. **What should change?** — behavior or wording in plain English.
2. **Which area?** — map to exactly one zone from `.slop-stop/policy.yml` (read the zone table). If ambiguous, ask once.

If the request needs files outside every zone, stop and write a short **handoff note** for `escalate_to` instead of editing.

## Step 2: Edit

- Modify **existing files only** within the chosen zone's `allow` globs.
- Respect invariants (`require_literal`, `freeze_headings`).
- One zone per PR.

Show a plain-language summary and `git diff` before asking to commit.

## Step 3: Local verification

From repo root (use PR base as `main` or the policy `target_branch` when comparing locally):

```bash
npx @meet-arlo/slop-stop check \
  --base-ref origin/TARGET_BRANCH \
  --base-branch TARGET_BRANCH \
  --head-ref HEAD \
  --head-branch "$(git branch --show-current)" \
  --pr-author BUILDER_GITHUB_LOGIN
```

Run the zone's `safety_check` from policy if present.

Fix any failure before continuing.

## Step 4: PR (after explicit approval)

1. Branch: `slop-stop/BUILDER_LOGIN/short-slug`. `check` fails builder PRs from any other branch.
2. Commit with a one-line message describing the wording change.
3. Push and open PR to **policy target_branch** only.
4. Request review from the zone's `escalate_to` CODEOWNER.
5. PR body:

```markdown
## Summary
- <plain-language change>

## Zone
- <zone name> (<zone id>)

## slop-stop
- [ ] Local check passed
- [ ] safety_check passed (if configured)
```

Never target the default branch if policy says otherwise. Never auto-merge. Never skip hooks.

Return the PR URL when done.
