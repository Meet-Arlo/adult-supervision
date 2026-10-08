# slop-stop

This repo (`adult-supervision`) is the home of **slop-stop**: `@meet-arlo/slop-stop`. It is the only tool here today.

slop-stop lets a non-engineer (or their agent) open pull requests that can only **edit existing files** you already listed. GitHub will not merge a builder PR that steps outside that list.

## Why slop-stop exists and its origin

At [Arlo](https://meetarlo.ai), the weekly CMO report is driven by markdown skill instructions. Engineers own Python, pipelines, and infra. The report's voice, analysis rules, and recommendations change weekly, and the people who should change them are not engineers.

We built an isolated agent with a hard file allowlist and a plain-language workflow so a non-technical co-founder could open safe PRs without touching production code. slop-stop is that pattern as a product: a policy file, trusted CI on GitHub, CODEOWNERS, and portable agent instructions that speak human (works with any coding agent that can read repo docs or skill files).

The name is the point. Stop the slop from reaching `main`.

## How it works

Two roles. Everything else follows from that.

| Role | GitHub access | What they can change |
|------|---------------|----------------------|
| **Owner** (not in `builders`) | Admin on the repo | Anything, including policy, CI, and CODEOWNERS. Their PRs skip zone rules on any branch. |
| **Builder** | Write, never Admin (enforced by `join`/`doctor`, not `check`) | Modify existing files inside **one** zone, branch `slop-stop/<login>/<slug>`, PR into `target_branch` only. |

Anyone in `builders` always follows the builder path, even if they are also an owner. Git commit author fields are ignored (they are easy to fake).

**Policy is a YAML file.** A zone is a named allowlist: which existing files the builder may edit, who reviews them (`escalate_to`), and either a `safety_check` shell command or an explicit `accept_unguarded`. Optional invariants can require a literal string to stay in the file, or freeze markdown headings. A top-level `deny` list blocks paths even if a zone would allow them.

There are two policy files you will see. They are not equals:

- `--policy-file` on `init` is a **draft**. `init` reads it once, then copies it.
- `.slop-stop/policy.yml` is the **canonical** file. `join`, `doctor`, `check`, and `safety` only read this path. `check` and `safety` read it from the **PR base commit** (usually `main`), not from the PR head and not from a leftover draft at the repo root.

If a draft and `.slop-stop/policy.yml` differ, the draft is dead weight. Re-running `init` with a stale draft overwrites the canonical file.

**CI is the real gate.** Local agent workflows and `check` are convenience. Two workflow files, two events, so a required check is never "skipped":

- `slop-stop/check` runs on `pull_request_target`. Trusted. Uses the pinned Action from this repo. Reads policy from the **base** commit. Treats the diff as data. **Never executes PR-head code.**
- `slop-stop/safety` runs on `pull_request`. Advisory. Checks out the PR head and runs that zone's `safety_check`. This **does** run PR-head code, so the owner must pick a read-only test and grant the job no secrets.

Owner-only PRs (in `owners`, not in `builders`, any branch) pass `check` without looking at the diff. Listed builders must use `slop-stop/<login>/<slug>` and target `policy.target_branch`. A builder PR whose author login does not match the branch login fails.

CODEOWNERS (written by `init`) makes owners review policy and CI, and makes each zone's `escalate_to` review the allowlisted paths. Branch protection / rulesets must require a PR, one approval including a CODEOWNER, dismiss stale approvals, block force pushes, and require both status checks. `doctor` audits that. It does not change GitHub for you.

Threat model: [tools/slop-stop/docs/threat-model.md](tools/slop-stop/docs/threat-model.md).

## What it does, and what you get

On the **consumer** repo (your app), `init` writes:

- `.slop-stop/policy.yml` — builders, owners, target branch, deny globs, zones
- a marked `# slop-stop:start` block in CODEOWNERS (existing file if GitHub already has one, else a new root `CODEOWNERS`)
- `.github/workflows/slop-stop-check.yml` and `slop-stop-safety.yml`, pinned to `Meet-Arlo/adult-supervision/tools/slop-stop@slop-stop-v1.1.0`
- a marked `<!-- slop-stop:start -->` block in `AGENTS.md`

Re-running `init` replaces only those marked blocks. Text outside the markers stays.

For a **builder PR**, `check` fails on:

- unknown builder, or PR author ≠ branch login
- paths outside every zone, or matching `deny`
- more than one zone in one PR
- new, deleted, renamed, or copied files; file type changes; binary patches
- edits to `.slop-stop/**`, `.github/**`, CODEOWNERS, `AGENTS.md`, `CLAUDE.md`, `.cursor/**`, `.claude/**`
- dependency manifests and `.env*`
- hidden or bidirectional Unicode in added lines
- secrets (gitleaks if installed, else a small built-in regex set)
- zone invariants
- a zone with no `safety_check` and no `accept_unguarded`

You also get two **agent workflow docs** (markdown under `tools/slop-stop/skills/` in this repo; copy or symlink them into whatever your team uses — `AGENTS.md`, Claude/Cursor skill dirs, etc.). They are not auto-invoked; the human or agent loads them on purpose:

- [slop-stop-setup](tools/slop-stop/skills/slop-stop-setup/SKILL.md) — owner interviews for policy, runs `init`, walks `doctor` failures
- [guarded-change](tools/slop-stop/skills/guarded-change/SKILL.md) — builder: `join`, one zone, local `check`, PR from `slop-stop/<login>/<slug>`

What v1 does **not** do: GitLab/Bitbucket, applying GitHub settings via API, AI reviewers as a merge gate, builders adding dependencies.

## Setup and installation

Needs Node 20+ and a GitHub `origin` remote. Run commands from the **app repo** root, not from this repo, unless you are changing slop-stop itself.

### Owner: first install

1. Invite each builder with **Write** (not Admin).
2. Draft a policy. Start from [tools/slop-stop/examples/demo-policy.yml](tools/slop-stop/examples/demo-policy.yml). Every zone needs `allow`, `escalate_to`, and either `safety_check` or `accept_unguarded`.
3. From the app repo:

   ```bash
   npx @meet-arlo/slop-stop init --policy-file ./path/to/draft-policy.yml
   npx @meet-arlo/slop-stop doctor
   ```

4. Commit what `init` wrote to the target branch (`main` unless policy says otherwise).
5. Fix every `[FAIL]` in GitHub Settings until `doctor` passes. Add the two required status checks **after** the workflows exist on the target branch, or every PR waits on checks that never run.
6. Point builders at the [guarded-change](tools/slop-stop/skills/guarded-change/SKILL.md) workflow doc (however your agent product loads instructions).

Prove it: open a PR that touches a file outside the zone. `slop-stop/check` should fail.

### Owner: change the policy later

`.slop-stop/policy.yml` is the file to edit. Builders cannot change it (trap + CODEOWNERS).

- **Policy-only** (builders list, `deny`, `safety_check`, invariants): edit `.slop-stop/policy.yml`, owner-PR to the target branch.
- **Also regenerates CODEOWNERS / workflows / AGENTS.md** (zones, `allow`, `escalate_to`, `owners`, `target_branch`): edit the YAML, then

  ```bash
  npx @meet-arlo/slop-stop init --policy-file .slop-stop/policy.yml
  ```

  Passing the canonical file as `--policy-file` dumps it back onto itself and refreshes the marked blocks.

`check` and `safety` read policy from the PR **base**. A new zone does nothing for builder PRs until that commit is on the target branch.

Do not keep a stale draft (for example `slop-policy.yml` at repo root) and pass it to `init` later. That overwrites the canonical file.

### Builder

Load the [guarded-change](tools/slop-stop/skills/guarded-change/SKILL.md) workflow in your agent (or follow it by hand). First run:

```bash
npx @meet-arlo/slop-stop join
```

`join` writes nothing. It proves the token is a listed builder with Write-not-Admin, then runs a builder-scoped `doctor`. If it fails, stop and fix that before editing.

Then describe the change in plain English. Stay in one zone, run local `check` (and `safety_check` if set), and open a PR from `slop-stop/<your-login>/<slug>` to the policy `target_branch`. Request review from the zone's `escalate_to`.

### Developing slop-stop (this repo)

```bash
npm ci
npm run build -w @meet-arlo/slop-stop
npm test -w @meet-arlo/slop-stop
npm run bundle -w @meet-arlo/slop-stop   # rebuild action/index.cjs; commit it
```

This repo's own workflow (`.github/workflows/slop-stop.yml`) builds, tests, and fails if the committed Action bundle does not match source.

## Commands

All commands are `npx @meet-arlo/slop-stop <command>`. `--repo-root` defaults to the current directory; slop-stop then finds the git root.

### `init` (owner)

Writes guardrail files into the consumer repo, then runs owner `doctor`.

```bash
npx @meet-arlo/slop-stop init --policy-file ./path/to/draft-policy.yml
```

- **Reads:** the draft you passed. Validates it (version 1, builders, owners, target branch, at least one zone).
- **Writes:** `.slop-stop/policy.yml` (overwrite), CODEOWNERS marked block, two workflows, `AGENTS.md` marked block.
- **Does not write:** GitHub settings. You still click those after `doctor`.
- Needs `origin` parseable as `github.com/owner/repo`. Token optional here; without one, `doctor` will fail on auth after the files are written.

### `doctor` (owner; also run by `init` and `join`)

Read-only GitHub audit. Does not change settings.

```bash
npx @meet-arlo/slop-stop doctor
```

- **Reads:** `.slop-stop/policy.yml` on disk (working tree), plus GitHub via `GITHUB_TOKEN` or `gh auth token`.
- **Owner audience** (this command): rulesets **and** classic branch protection; auto-merge must be off; every builder must be Write or Maintain, not Admin.
- **Builder audience** (via `join`): rulesets only (classic protection needs admin to read). No rulesets → `INFO`, not a fail. Also checks this user cannot bypass the ruleset.
- Exit `0` if every item is pass, info, or not-enforceable. Any `[FAIL]` → exit `1`. Prints the Settings path for each fail.

### `join` (builder)

Handshake. Writes nothing. Registers nothing.

```bash
npx @meet-arlo/slop-stop join
# optional: --builder <login>  (must match the token)
```

Order:

1. Load `.slop-stop/policy.yml` from the working tree. Missing → fail (`run init first`).
2. Parse `origin` for owner/repo.
3. Token from `GITHUB_TOKEN` or `gh auth token`.
4. `users.getAuthenticated` → login. `--builder` must match if passed.
5. Login must be in `policy.builders`. Being an owner is not enough.
6. Collaborator role must not be `admin`.
7. Print `join: <login> has <role> access (ok)`.
8. Run `doctor` with `audience: builder`. That step is what requires Write (or Maintain). Exit code is doctor's.

If `join` prints the green line and then fails, identity passed and GitHub settings did not.

### `check` (CI and local)

Zone, trap, identity, invariant, and secret checks. This is the merge gate.

```bash
npx @meet-arlo/slop-stop check \
  --base-ref origin/main \
  --base-branch main \
  --head-ref HEAD \
  --head-branch "$(git branch --show-current)" \
  --pr-author YOUR_GITHUB_LOGIN
```

All flags are required. In GitHub Actions, `init`'s workflow passes them from the pull-request event (`base.sha`, `base.ref`, `head.sha`, `head.ref`, `user.login`).

- **Reads policy from the base ref**, not the working tree. No policy on base → fail closed.
- Builder branches: diffs base…head and applies the rules in [What it does](#what-it-does-and-what-you-get). Base branch must equal `policy.target_branch`.
- Owner-only authors on any branch: pass without inspecting the diff.
- Builders off the `slop-stop/…` prefix: fail (`builder_branch_required`).
- Everyone else: fail (`non_owner_branch`).

### `safety` (CI; local if you have checked out the PR head)

Runs each touched zone's `safety_check` against the current tree.

```bash
npx @meet-arlo/slop-stop safety \
  --base-ref origin/main \
  --head-ref HEAD \
  --head-branch "$(git branch --show-current)"
```

- **Reads policy from the base ref.**
- Skips (exit 0) if the branch is not a listed builder branch.
- Runs `/bin/sh -c <safety_check>` with a locked-down `PATH` (no inherited parent PATH). No secrets in the workflow `init` writes.
- One command per zone touched. First failure → exit 1.

---

MIT. See [LICENSE](LICENSE).
