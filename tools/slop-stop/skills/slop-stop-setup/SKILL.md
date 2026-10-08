---
name: slop-stop-setup
description: Owner setup for slop-stop guardrails. Interviews for builders, owners, target branch, and zones, then runs slop-stop init and walks through every doctor failure until GitHub is configured. Use when onboarding a repo for a non-technical builder.
disable-model-invocation: true
---

# slop-stop setup (owner)

You are helping the **repo owner** (admin) configure slop-stop so a non-technical builder can open safe PRs.

Speak in plain language. The owner may not know git internals.

## Before you start

- Confirm GitHub is the git host (v1 is GitHub-only).
- Confirm the owner has admin on the repository.
- Confirm `gh auth login` or `GITHUB_TOKEN` works for this repo.

## Interview (collect before running init)

Ask for:

1. **Builders** — GitHub usernames who will use the guarded-change skill (comma-separated).
2. **Owners** — GitHub usernames who approve guardrails and zone files (comma-separated).
3. **Target branch** — where builder PRs merge (for example `main` or `development`).
4. **Zones** — for each zone:
   - plain-language **name** and **description**
   - **allow** globs (which existing files they may edit)
   - **escalate_to** (CODEOWNER username for that zone)
   - optional **safety_check** shell command (must fail when zone content breaks)
   - optional **invariants** (`require_literal` strings, `freeze_headings: true`)

Build a draft `.slop-stop/policy.yml` from answers. Show it to the owner and get explicit approval.

## Run init

From the repository root:

```bash
npx @meet-arlo/slop-stop init --policy-file /path/to/draft-policy.yml
```

Record what was written (init prints the list):

- `.slop-stop/policy.yml`
- slop-stop block in the CODEOWNERS file GitHub reads (`.github/`, root, or `docs/`)
- `.github/workflows/slop-stop-check.yml` and `.github/workflows/slop-stop-safety.yml`
- `AGENTS.md` slop-stop block

Commit and push these to the target branch before the builder starts.

## Walk doctor failures

Run:

```bash
npx @meet-arlo/slop-stop doctor
```

For every `[FAIL]` item:

- Explain what it means in one sentence.
- Give the owner the exact GitHub Settings path from the doctor output.
- Wait for them to fix it, then re-run `doctor` until only PASS, INFO, or NOT_ENFORCEABLE remain.

Call out `[NOT_ENFORCEABLE]` items: document them for the team; they are not automatic passes. When target-branch items fail, walk the owner through the numbered Fix steps in the GitHub UI one at a time. Add the two required status checks last, after the slop-stop workflows are merged to the target branch, or every PR waits on checks that never run.

## Handoff to builder

Tell the owner to invite each builder with **Write** access (not Admin) and share the `guarded-change` workflow doc path (`tools/slop-stop/skills/guarded-change/SKILL.md`, or wherever the team installs agent instructions).

Done when `doctor` overall is PASS and each zone has a `safety_check` or documented `accept_unguarded`.
