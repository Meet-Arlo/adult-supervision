import { describe, expect, it } from 'vitest';
import { parseNameStatus } from '../src/git.js';
import { readInput, runFromActionEnv } from '../src/github-action.js';
import {
  AGENTS_BLOCK_END,
  AGENTS_BLOCK_START,
  mergeMarkedBlock,
  renderCheckWorkflow,
  renderSafetyWorkflow,
  SLOP_STOP_ACTION_REF,
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
    for (const wf of [check, safety]) {
      expect(wf).toContain(`uses: ${SLOP_STOP_ACTION_REF}`);
      expect(wf).toContain('branches: [develop]');
      expect(wf).toContain('fetch-depth: 0');
      expect(wf).toContain('timeout-minutes:');
    }
  });

  it('adds a block to an empty file without leading blank lines', () => {
    const block = `${AGENTS_BLOCK_START}\nhi\n${AGENTS_BLOCK_END}\n`;
    expect(mergeMarkedBlock('', block, AGENTS_BLOCK_START, AGENTS_BLOCK_END)).toBe(block);
  });

  it('replaces only the marked block and keeps the rest of the file', () => {
    const old = `# Team\n\n${AGENTS_BLOCK_START}\nold\n${AGENTS_BLOCK_END}\n\nfooter\n`;
    const block = `${AGENTS_BLOCK_START}\nnew\n${AGENTS_BLOCK_END}\n`;
    expect(mergeMarkedBlock(old, block, AGENTS_BLOCK_START, AGENTS_BLOCK_END)).toBe(
      `# Team\n\n${AGENTS_BLOCK_START}\nnew\n${AGENTS_BLOCK_END}\n\nfooter\n`,
    );
  });
});
