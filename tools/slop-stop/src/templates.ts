import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Policy } from './policy.js';

/** Consumer workflows pin this repo + tag in `uses:`; the tag must exist on GitHub. */
export const SLOP_STOP_ACTION_REF = 'Meet-Arlo/adult-supervision/tools/slop-stop@slop-stop-v1.1.0';
export const SLOP_STOP_PACKAGE = '@meet-arlo/slop-stop';

export const CHECK_WORKFLOW_FILE = 'slop-stop-check.yml';
export const SAFETY_WORKFLOW_FILE = 'slop-stop-safety.yml';

/** GitHub reads the first CODEOWNERS it finds, in this order. */
const CODEOWNERS_LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

export const AGENTS_BLOCK_START = '<!-- slop-stop:start -->';
export const AGENTS_BLOCK_END = '<!-- slop-stop:end -->';
export const CODEOWNERS_BLOCK_START = '# slop-stop:start';
export const CODEOWNERS_BLOCK_END = '# slop-stop:end';

export function renderPolicyYaml(policy: Policy): string {
  return yaml.dump(policy, { lineWidth: 100, noRefs: true });
}

/** Last matching CODEOWNERS rule wins, so this block goes at the end of the file. */
export function renderCodeownersBlock(policy: Policy): string {
  const owners = policy.owners.map((o) => `@${o}`).join(' ');
  const lines = [
    CODEOWNERS_BLOCK_START,
    `.slop-stop/** ${owners}`,
    `.github/** ${owners}`,
    `**/CODEOWNERS ${owners}`,
  ];
  for (const zone of policy.zones) {
    for (const allow of zone.allow) {
      lines.push(`${allow} @${zone.escalate_to}`);
    }
  }
  lines.push(CODEOWNERS_BLOCK_END, '');
  return lines.join('\n');
}

export function renderAgentsBlock(policy: Policy): string {
  return [
    AGENTS_BLOCK_START,
    '## slop-stop (builder guardrails)',
    '',
    'If you are making product copy or prompt changes as a **builder**, follow the',
    '`guarded-change` agent workflow (`tools/slop-stop/skills/guarded-change/SKILL.md` in',
    'the slop-stop package, or your team\'s copy). Stay inside your zone; do not edit Python, CI, or policy.',
    '',
    'Before opening a PR, run:',
    '',
    '```bash',
    `npx ${SLOP_STOP_PACKAGE} check --base-ref origin/${policy.target_branch} \\`,
    `  --base-branch ${policy.target_branch} --head-ref HEAD \\`,
    '  --head-branch "$(git branch --show-current)" --pr-author YOUR_GITHUB_LOGIN',
    '```',
    AGENTS_BLOCK_END,
    '',
  ].join('\n');
}

/** Replaces an existing marked block, or appends one. Text outside the markers is kept. */
export function mergeMarkedBlock(
  existing: string,
  block: string,
  start: string,
  end: string,
): string {
  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);
  if (startIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + block.trimEnd() + existing.slice(endIdx + end.length);
  }
  const head = existing.trimEnd();
  return head ? `${head}\n\n${block}` : block;
}

const CHECKOUT_FULL_HISTORY = `      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          filter: blob:none`;

export function renderCheckWorkflow(policy: Policy): string {
  return `# Written by slop-stop init. Trusted: runs the pinned action, never PR code.
name: slop-stop-check

on:
  pull_request_target:
    types: [opened, synchronize, reopened]
    branches: [${policy.target_branch}]

permissions:
  contents: read
  pull-requests: read

concurrency:
  group: slop-stop-check-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  check:
    name: slop-stop/check
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
${CHECKOUT_FULL_HISTORY}
      - uses: ${SLOP_STOP_ACTION_REF}
        with:
          mode: check
          base-ref: \${{ github.event.pull_request.base.sha }}
          base-branch: \${{ github.event.pull_request.base.ref }}
          head-ref: \${{ github.event.pull_request.head.sha }}
          head-branch: \${{ github.event.pull_request.head.ref }}
          pr-author: \${{ github.event.pull_request.user.login }}
`;
}

export function renderSafetyWorkflow(policy: Policy): string {
  return `# Written by slop-stop init. Advisory: runs zone safety_check against PR code, no secrets.
name: slop-stop-safety

on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [${policy.target_branch}]

permissions:
  contents: read

concurrency:
  group: slop-stop-safety-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  safety:
    name: slop-stop/safety
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
${CHECKOUT_FULL_HISTORY}
      - uses: ${SLOP_STOP_ACTION_REF}
        with:
          mode: safety
          base-ref: \${{ github.event.pull_request.base.sha }}
          head-ref: \${{ github.event.pull_request.head.sha }}
          head-branch: \${{ github.event.pull_request.head.ref }}
`;
}

export function codeownersPath(repoRoot: string): string {
  const found = CODEOWNERS_LOCATIONS.find((rel) => fs.existsSync(path.join(repoRoot, rel)));
  return path.join(repoRoot, found ?? 'CODEOWNERS');
}

function writeMergedFile(filePath: string, block: string, start: string, end: string): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  fs.writeFileSync(filePath, mergeMarkedBlock(existing, block, start, end), 'utf8');
}

export function writeInitArtifacts(repoRoot: string, policy: Policy): string[] {
  const policyPath = path.join(repoRoot, '.slop-stop', 'policy.yml');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, renderPolicyYaml(policy), 'utf8');

  const ownersPath = codeownersPath(repoRoot);
  writeMergedFile(
    ownersPath,
    renderCodeownersBlock(policy),
    CODEOWNERS_BLOCK_START,
    CODEOWNERS_BLOCK_END,
  );

  const workflowDir = path.join(repoRoot, '.github', 'workflows');
  fs.mkdirSync(workflowDir, { recursive: true });
  const checkPath = path.join(workflowDir, CHECK_WORKFLOW_FILE);
  const safetyPath = path.join(workflowDir, SAFETY_WORKFLOW_FILE);
  fs.writeFileSync(checkPath, renderCheckWorkflow(policy), 'utf8');
  fs.writeFileSync(safetyPath, renderSafetyWorkflow(policy), 'utf8');

  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  writeMergedFile(agentsPath, renderAgentsBlock(policy), AGENTS_BLOCK_START, AGENTS_BLOCK_END);

  return [policyPath, ownersPath, checkPath, safetyPath, agentsPath].map((p) =>
    path.relative(repoRoot, p),
  );
}
