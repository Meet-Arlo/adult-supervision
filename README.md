# slop-stop

This repo (`adult-supervision`) publishes **slop-stop** (`@meet-arlo/slop-stop`). A non-engineer, or their coding agent, can open pull requests that only edit files you already listed. GitHub will not merge a builder PR that steps outside that list.

## Why slop-stop

At [Arlo](https://meetarlo.ai), the weekly CMO report is driven by markdown skill instructions. Engineers own Python, pipelines, and infra. The report's voice and analysis rules change often, and the people who should change them are not engineers.

We built an isolated agent with a hard file allowlist so a non-technical co-founder could open safe PRs. slop-stop is that pattern as a product: a policy file, trusted CI, CODEOWNERS, and two agent skills. The name is the point. Stop the slop from reaching `main`.

Two roles. Anyone listed in `builders` always takes the builder path, even if they are also an owner. Git author fields are ignored.

| Role | GitHub access | What they can change |
|------|---------------|----------------------|
| **Owner** (not in `builders`) | Admin | Anything, including policy and CI. Their PRs skip zone rules. |
| **Builder** | Write, never Admin | Existing files in **one** zone, on branch `slop-stop/<login>/<slug>`, into `target_branch` only. |

A **zone** is a named allowlist of existing files, a reviewer (`escalate_to`), and either a `safety_check` shell command or an explicit `accept_unguarded`. Optional invariants can require a literal string to stay in a file, or freeze markdown headings. A top-level `deny` list blocks paths even when a zone would allow them.

**CI is the gate.** Local `check` is for the agent before it opens the PR. Two workflows, so a required check is never skipped:

- `slop-stop/check` runs on `pull_request_target`. It reads policy from the PR **base** and treats the diff as data. It never runs PR-head code.
- `slop-stop/safety` runs on `pull_request`. It checks out the PR head and runs that zone's `safety_check`. That job runs PR-head code, so the command must be read-only and the job gets no secrets.

`check` fails a builder PR when:

- the PR author login does not match the branch login, or the branch is not `slop-stop/<login>/<slug>`
- the diff leaves the zone, hits `deny`, or touches more than one zone
- a file is added, deleted, renamed, copied, or changes type (including binary patches)
- the diff touches `.slop-stop/**`, `.github/**`, CODEOWNERS, `AGENTS.md`, `CLAUDE.md`, `.cursor/**`, `.claude/**`, dependency manifests, or `.env*`
- added lines hide Unicode, look like secrets, or break a zone invariant
- a zone has neither `safety_check` nor `accept_unguarded`

v1 is GitHub. `doctor` audits branch protection; you still set it in GitHub Settings. Threat model: [tools/slop-stop/docs/threat-model.md](tools/slop-stop/docs/threat-model.md).

## Installation

Needs Node 20+ and a GitHub `origin` remote. Run commands from the **app repo** root (the repo builders will edit).

```bash
npx @meet-arlo/slop-stop --help
```

Nothing to install globally. `npx` runs the published package.

To change slop-stop itself, from this repo:

```bash
npm ci
npm test
npm run build
npm run bundle -w @meet-arlo/slop-stop   # rebuild action/index.cjs; commit it
```

## Setup

The owner does this once per app repo, then again only when the allowlist or reviewers change. Builders do not run `init`.

1. Invite each builder with **Write** (not Admin).
2. Draft a policy. Start from [tools/slop-stop/examples/demo-policy.yml](tools/slop-stop/examples/demo-policy.yml).
3. From the app repo:

   ```bash
   npx @meet-arlo/slop-stop init --policy-file ./path/to/draft-policy.yml
   npx @meet-arlo/slop-stop doctor
   ```

4. Commit what `init` wrote and push it to the target branch (`main` unless the policy says otherwise).
5. Fix every `[FAIL]` until `doctor` passes. Require a PR, one approval including a CODEOWNER, dismiss stale approvals, block force pushes, require both status checks, and turn auto-merge off. Add the two status checks **after** the workflows are on the target branch, or every PR waits on checks that never run.

`init` writes `.slop-stop/policy.yml`, a marked `# slop-stop:start` block in CODEOWNERS, `.github/workflows/slop-stop-check.yml` and `slop-stop-safety.yml` (pinned to a tag in this repo), and a marked `<!-- slop-stop:start -->` block in `AGENTS.md`. Re-running `init` replaces only those marked blocks.

**One policy file counts.** `--policy-file` is a draft. `init` copies it to `.slop-stop/policy.yml`, and every later command reads that path. `check` and `safety` read it from the PR **base** commit, so a new zone does nothing until that commit is on the target branch. When you re-run `init`, pass `.slop-stop/policy.yml`. A leftover draft at the repo root overwrites the canonical file.

Later edits:

- Builders, `deny`, `safety_check`, invariants: edit `.slop-stop/policy.yml` and open an owner PR.
- Zones, `allow`, `escalate_to`, `owners`, `target_branch`: edit that same file, then run `npx @meet-arlo/slop-stop init --policy-file .slop-stop/policy.yml` so CODEOWNERS, workflows, and `AGENTS.md` refresh.

## Skills

Two markdown skills. They are workflow instructions, loaded on purpose (`disable-model-invocation: true` in each file). Copy or symlink the skill folders into the place your agent reads skills. For Cursor, that is `.cursor/skills/` in the app repo, or your user skills directory. `init` does not copy the skill files. It only points `AGENTS.md` at `guarded-change`.

Use one skill per seat:

| Skill | Who | When |
|-------|-----|------|
| [slop-stop-setup](tools/slop-stop/skills/slop-stop-setup/SKILL.md) | Owner | First install, and when zones or reviewers change |
| [guarded-change](tools/slop-stop/skills/guarded-change/SKILL.md) | Builder | Every wording or prompt change inside a zone |

Engineers who are not in `builders` keep their normal PRs for code, CI, and infra. An engineer who is also listed as a builder still has to use the builder branch and stay inside one zone.

### slop-stop-setup

Owner skill. It interviews you, writes a draft policy, runs `init`, and walks every `doctor` failure until GitHub matches the policy.

Load it when you are putting slop-stop on a repo, adding a zone, or changing who reviews a zone. Day-to-day copy edits use `guarded-change` instead.

A session should go like this:

1. Confirm GitHub, admin on the repo, and `gh auth login` (or `GITHUB_TOKEN`).
2. Collect builders, owners, target branch, and each zone: name, allow globs, `escalate_to`, and a `safety_check` or `accept_unguarded`. Show the YAML and wait for an explicit yes before `init`.
3. Run `init`. Commit and push to the target branch before any builder starts.
4. Run `doctor`. For each `[FAIL]`, say what it means in one sentence, give the Settings path from the output, wait, and re-run. Add the two status checks last.
5. Invite builders with Write, and tell them to load `guarded-change`.

Prompt: "Use the slop-stop-setup skill. Sam should be able to edit homepage copy only."

Done when `doctor` is clean and every zone has a `safety_check` or a written `accept_unguarded`.

### guarded-change

Builder skill. It turns a plain-English request into one allowlisted PR. If the request needs files outside every zone, the agent stops and writes a short handoff for `escalate_to`. It does not edit those files.

Load it for each builder change. If the repo has no `.slop-stop/policy.yml`, stop and send the person back to the owner.

A session should go like this:

1. `npx @meet-arlo/slop-stop join` once per machine. It writes nothing. It checks the token is a listed builder with Write (not Admin), then runs a builder-scoped `doctor`. A green join line followed by a failure means identity passed and GitHub settings did not.
2. Map the request to exactly one zone in `.slop-stop/policy.yml`. If it is ambiguous, ask once.
3. Edit existing files inside that zone's `allow` globs. Keep invariants (`require_literal`, `freeze_headings`). Show a plain-language summary and `git diff` before committing.
4. Run local `check`, then the zone's `safety_check`. Fix failures before opening the PR.
5. After the human approves: branch `slop-stop/<login>/<slug>`, one-line commit, push, PR into `target_branch` only, review requested from `escalate_to`. Leave auto-merge off.

Prompt: "Use the guarded-change skill. Change the homepage hero so it says we publish a weekly report."

## Working example

Alex owns the repo. Sam should change homepage copy and nothing else.

**Alex loads slop-stop-setup.** Invite `sam` with Write. Approve this draft:

```yaml
version: 1
builders: [sam]
owners: [alex]
target_branch: main
deny: ['**/*.ts', '**/package*.json']
zones:
  - id: marketing-copy
    name: Marketing copy
    description: Homepage hero and subhead
    allow: ['content/home.md']
    safety_check: 'npm test -- --grep home'
    escalate_to: alex
```

```bash
npx @meet-arlo/slop-stop init --policy-file ./draft-policy.yml
npx @meet-arlo/slop-stop doctor
```

Commit `.slop-stop/`, the two workflows, the CODEOWNERS block, and the `AGENTS.md` block. Push to `main`. Clear every `[FAIL]`, including both required checks.

**Sam loads guarded-change.** "Change the hero so it says we publish a weekly report, not a dashboard."

```bash
npx @meet-arlo/slop-stop join
git checkout -b slop-stop/sam/weekly-report-hero
# edit content/home.md only
npx @meet-arlo/slop-stop check \
  --base-ref origin/main \
  --base-branch main \
  --head-ref HEAD \
  --head-branch slop-stop/sam/weekly-report-hero \
  --pr-author sam
npm test -- --grep home
```

Open the PR into `main` and request review from `alex`.

A second PR that also touches `src/app.ts` fails `slop-stop/check`. So does a branch named `sam/quick-fix`. A three-zone sample (invariants and an unguarded zone) is in [tools/slop-stop/examples/demo-policy.yml](tools/slop-stop/examples/demo-policy.yml).

---

MIT. See [LICENSE](LICENSE).
