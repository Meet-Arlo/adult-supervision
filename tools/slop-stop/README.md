# slop-stop

Guardrailed agent development for non-technical builders.

## Origin story

At [Arlo](https://meetarlo.ai), the weekly CMO report is driven by dozens of markdown skill instructions. Engineers own Python, data pipelines, and infra—but the report's voice, analysis rules, and recommendations change weekly. We built an isolated agent with a hard file allowlist, plain-language workflow, and Cursor hooks so a non-technical co-founder could open safe PRs without touching prod.

**slop-stop** generalizes that pattern: machine-readable **zones**, trusted CI on GitHub, CODEOWNERS, and skills that speak human. The name is intentional—stop the slop from reaching main.

## Quickstart (about 5 minutes)

Requires Node 20+ and a GitHub `origin` remote.

1. **Owner** — from your app repo root, draft a policy (see [examples/demo-policy.yml](examples/demo-policy.yml)), then:

   ```bash
   npx @meet-arlo/slop-stop init --policy-file ./path/to/policy.yml
   npx @meet-arlo/slop-stop doctor
   ```

   `init` writes `.slop-stop/policy.yml`, two workflows, a marked block in your existing CODEOWNERS (or a new root `CODEOWNERS`), and a marked block in `AGENTS.md`. Re-running replaces only the marked blocks. Commit the result, then fix every `[FAIL]` in GitHub Settings until doctor passes.

2. **Builder** — install the [guarded-change](skills/guarded-change/SKILL.md) skill in your agent, then describe the change in plain English. The skill runs `join`, edits one zone, runs `check`, and opens a PR from `slop-stop/<you>/<slug>`.

3. **Prove the guardrail** — open a PR that touches a file outside the zone; `slop-stop/check` should fail.

## Commands

| Command | Who | Purpose |
|---------|-----|---------|
| `init` | Owner | Write policy, CODEOWNERS block, workflows, AGENTS.md block |
| `join` | Builder | Verify write-not-admin token, run builder-level doctor |
| `doctor` | Owner | GitHub audit (needs admin to read branch protection) + zone canaries |
| `check` | CI / local | Identity, zone, trap, invariant, secret checks |
| `safety` | CI (advisory) | Run zone `safety_check` on PR head |

## GitHub Action

`init` writes two workflows so each check only exists on its own event:

- `slop-stop-check.yml` — `pull_request_target`, trusted `slop-stop/check`. Never runs PR code.
- `slop-stop-safety.yml` — `pull_request`, advisory `slop-stop/safety`. Runs zone `safety_check` against PR code with no secrets.

Both pin `uses: Meet-Arlo/adult-supervision/tools/slop-stop@slop-stop-v1.0.0` and check out with `fetch-depth: 0` plus `filter: blob:none`, so history is present but file contents download only for diffed paths.

## Threat model

See [docs/threat-model.md](docs/threat-model.md).

## Development

```bash
npm ci            # from the repo root (npm workspace)
npm run build -w @meet-arlo/slop-stop
npm test -w @meet-arlo/slop-stop
npm run bundle -w @meet-arlo/slop-stop   # rebuild action/index.cjs; commit it
```

## License

MIT. See [LICENSE](LICENSE).
