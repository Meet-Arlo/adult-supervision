import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseNameStatus } from '../src/git.js';
import { readInput, runFromActionEnv } from '../src/github-action.js';
import {
  GUARDRAIL_BLOCK_END,
  GUARDRAIL_BLOCK_START,
  mergeMarkedBlock,
  packagedSkillsRoot,
  renderCheckWorkflow,
  renderSafetyWorkflow,
  SLOP_STOP_ACTION_REF,
  writeInitArtifacts,
} from '../src/templates.js';
import { parsePolicyYaml } from '../src/policy.js';

const policy = parsePolicyYaml(`
version: 1
builders: [bea]
owners: [al]
target_branch: develop
zones:
  - id: home
    name: Home
    description: Home copy
    allow: [content/home.md]
    escalate_to: al
`);

describe('action inputs', () => {
  it('reads inputs the way the GitHub runner names them', () => {
    expect(readInput({ 'INPUT_BASE-REF': 'abc' }, 'base-ref')).toBe('abc');
    expect(readInput({ INPUT_BASEREF: 'abc' }, 'base-ref')).toBe('');
  });

  it('fails loudly instead of running with an empty base ref', () => {
    expect(() => runFromActionEnv({ INPUT_MODE: 'check' }, process.cwd())).toThrow(
      /Missing required action input: base-ref/,
    );
  });
});

describe('parseNameStatus', () => {
  it('keeps type changes, copies, and unknown letters instead of casting them', () => {
    const entries = parseNameStatus('T\tsrc/app.py\nC75\ta.md\tb.md\nZ\tweird\n');
    expect(entries).toEqual([
      { status: 'T', path: 'src/app.py' },
      { status: 'C', oldPath: 'a.md', path: 'b.md' },
      { status: 'X', path: 'weird' },
    ]);
  });
});

describe('templates', () => {
  it('splits check and safety so neither event leaves a skipped required job', () => {
    const check = renderCheckWorkflow(policy);
    const safety = renderSafetyWorkflow(policy);
    expect(check).toContain('pull_request_target:');
    expect(check).not.toMatch(/^\s+pull_request:/m);
    expect(safety).toMatch(/^\s+pull_request:/m);
    expect(safety).not.toContain('pull_request_target');
    expect(check).toContain('base-branch: ${{ github.event.pull_request.base.ref }}');
    expect(safety).toContain('base-branch: ${{ github.event.pull_request.base.ref }}');
    for (const wf of [check, safety]) {
      expect(wf).toContain(`uses: ${SLOP_STOP_ACTION_REF}`);
      expect(wf).toContain('branches: [develop]');
      expect(wf).toContain('fetch-depth: 0');
      expect(wf).toContain('persist-credentials: false');
      expect(wf).not.toContain('filter: blob:none');
      expect(wf).toContain('timeout-minutes:');
    }
  });

  it('checks out the base tree for check and does not persist the job token', () => {
    const check = renderCheckWorkflow(policy);
    const checkout = check.slice(
      check.indexOf('actions/checkout'),
      check.indexOf('Fetch PR head'),
    );
    expect(checkout).toContain('ref: ${{ github.event.pull_request.base.sha }}');
    expect(checkout).not.toContain('head.sha');
    expect(check).toContain('pull/${{ github.event.pull_request.number }}/head');
    expect(check).toContain('git -c "http.https://github.com/.extraheader=');
  });

  it('checks out the PR head for safety without leaving credentials in .git/config', () => {
    const safety = renderSafetyWorkflow(policy);
    expect(safety).toContain('ref: ${{ github.event.pull_request.head.sha }}');
    expect(safety).toContain('persist-credentials: false');
    expect(safety).not.toContain('Fetch PR head');
  });

  it('adds a block to an empty file without leading blank lines', () => {
    const block = `${GUARDRAIL_BLOCK_START}\nhi\n${GUARDRAIL_BLOCK_END}\n`;
    expect(mergeMarkedBlock('', block, GUARDRAIL_BLOCK_START, GUARDRAIL_BLOCK_END)).toBe(block);
  });

  it('copies packaged skills into skills/ and points CLAUDE.md at them', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-init-'));
    const otherSkill = path.join(repo, 'skills', 'other', 'SKILL.md');
    const staleSkillFile = path.join(repo, 'skills', 'guarded-change', 'old.md');
    fs.mkdirSync(path.dirname(otherSkill), { recursive: true });
    fs.writeFileSync(otherSkill, 'keep\n');
    fs.mkdirSync(path.dirname(staleSkillFile), { recursive: true });
    fs.writeFileSync(staleSkillFile, 'stale\n');

    try {
      const written = writeInitArtifacts(repo, policy);
      expect(written).toContain('skills/guarded-change/SKILL.md');
      expect(written).toContain('skills/slop-stop-setup/SKILL.md');

      const installed = fs.readFileSync(
        path.join(repo, 'skills', 'guarded-change', 'SKILL.md'),
        'utf8',
      );
      const packaged = fs.readFileSync(
        path.join(packagedSkillsRoot(), 'guarded-change', 'SKILL.md'),
        'utf8',
      );
      expect(installed).toBe(packaged);
      expect(fs.existsSync(staleSkillFile)).toBe(false);
      expect(fs.readFileSync(otherSkill, 'utf8')).toBe('keep\n');

      expect(written).toContain('CLAUDE.md');
      const claude = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
      expect(claude).toContain(
        'https://github.com/Meet-Arlo/adult-supervision/tree/main/skills',
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('moves an old AGENTS.md block into CLAUDE.md and keeps the rest of AGENTS.md', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-init-'));
    const oldBlock = `${GUARDRAIL_BLOCK_START}\nold\n${GUARDRAIL_BLOCK_END}\n`;
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), `# Team\n\n${oldBlock}`);
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Repo\n');
    try {
      const written = writeInitArtifacts(repo, policy);
      expect(written).toContain('AGENTS.md');
      expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8')).toBe('# Team\n');
      const claude = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
      expect(claude.startsWith('# Repo\n\n')).toBe(true);
      expect(claude).toContain(GUARDRAIL_BLOCK_START);
      expect(claude).not.toContain('\nold\n');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('deletes AGENTS.md when the old block was its only content', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-init-'));
    fs.writeFileSync(
      path.join(repo, 'AGENTS.md'),
      `${GUARDRAIL_BLOCK_START}\nold\n${GUARDRAIL_BLOCK_END}\n`,
    );
    try {
      writeInitArtifacts(repo, policy);
      expect(fs.existsSync(path.join(repo, 'AGENTS.md'))).toBe(false);
      expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).toContain(GUARDRAIL_BLOCK_START);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('replaces only the marked block and keeps the rest of the file', () => {
    const old = `# Team\n\n${GUARDRAIL_BLOCK_START}\nold\n${GUARDRAIL_BLOCK_END}\n\nfooter\n`;
    const block = `${GUARDRAIL_BLOCK_START}\nnew\n${GUARDRAIL_BLOCK_END}\n`;
    expect(mergeMarkedBlock(old, block, GUARDRAIL_BLOCK_START, GUARDRAIL_BLOCK_END)).toBe(
      `# Team\n\n${GUARDRAIL_BLOCK_START}\nnew\n${GUARDRAIL_BLOCK_END}\n\nfooter\n`,
    );
  });
});
