import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { runCheck } from '../src/check.js';
import type { DiffEntry } from '../src/git.js';

const basePolicy = {
  version: 1,
  builders: ['builder-one', 'owner-one'],
  owners: ['owner-one'],
  target_branch: 'main',
  deny: ['**/*.py'],
  zones: [
    {
      id: 'copy',
      name: 'Marketing copy',
      description: 'Homepage text',
      allow: ['content/home.md'],
      safety_check: 'true',
      escalate_to: 'owner-one',
      invariants: [{ require_literal: 'KEEP_ME' }, { freeze_headings: true }],
    },
  ],
};

function policyYaml(): string {
  return yaml.dump(basePolicy);
}

function run(
  overrides: Partial<Parameters<typeof runCheck>[0]> & {
    headBranch?: string;
    prAuthor?: string;
  },
) {
  const headBranch = overrides.headBranch ?? 'slop-stop/builder-one/update-copy';
  const prAuthor = overrides.prAuthor ?? 'builder-one';
  const diffEntries: DiffEntry[] = overrides.diffEntries ?? [
    { status: 'M', path: 'content/home.md' },
  ];
  return runCheck({
    policyYaml: overrides.policyYaml ?? policyYaml(),
    baseRef: 'base',
    baseBranch: overrides.baseBranch ?? 'main',
    headRef: 'head',
    headBranch,
    prAuthor,
    diffEntries,
    fullDiff: overrides.fullDiff ?? '',
    patches: overrides.patches ?? new Map([['content/home.md', '']]),
    fileContentAtBase:
      overrides.fileContentAtBase ??
      ((p) => (p === 'content/home.md' ? '# Title\nKEEP_ME\n' : null)),
    fileContentAtHead:
      overrides.fileContentAtHead ??
      ((p) => (p === 'content/home.md' ? '# Title\nKEEP_ME\nUpdated.\n' : null)),
    fileExistsAtBase: overrides.fileExistsAtBase ?? ((p) => p === 'content/home.md'),
    ...overrides,
  });
}

describe('runCheck', () => {
  it('allows an in-zone builder edit', () => {
    const result = run({});
    expect(result.ok).toBe(true);
    expect(result.isBuilderPr).toBe(true);
  });

  it('blocks out-of-zone edits', () => {
    const result = run({
      diffEntries: [{ status: 'M', path: 'src/app.ts' }],
      patches: new Map([['src/app.ts', '']]),
      fileExistsAtBase: () => true,
      fileContentAtBase: () => 'x',
      fileContentAtHead: () => 'y',
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'out_of_zone')).toBe(true);
  });

  it('blocks non-owner PRs without builder branch prefix', () => {
    const result = run({
      headBranch: 'feature/random',
      prAuthor: 'rando',
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'non_owner_branch')).toBe(true);
  });

  it('allows owner-only PRs off the builder prefix', () => {
    const policyOnlyOwner = yaml.dump({
      ...basePolicy,
      builders: ['builder-one'],
    });
    const result = run({
      policyYaml: policyOnlyOwner,
      headBranch: 'feature/owner-fix',
      prAuthor: 'owner-one',
    });
    expect(result.ok).toBe(true);
  });

  it('requires builders on the slop-stop branch even when they are owners', () => {
    const result = run({
      headBranch: 'feature/owner-fix',
      prAuthor: 'owner-one',
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'builder_branch_required')).toBe(true);
  });

  it('blocks builder PRs that target the wrong base branch', () => {
    const result = run({ baseBranch: 'develop' });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'wrong_merge_target')).toBe(true);
  });

  it('blocks broken invariants', () => {
    const result = run({
      fileContentAtHead: () => '# Title\nOops removed literal\n',
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'invariant')).toBe(true);
  });

  it('blocks guardrail file edits', () => {
    const result = run({
      diffEntries: [{ status: 'M', path: '.github/workflows/ci.yml' }],
      patches: new Map([['.github/workflows/ci.yml', '']]),
      fileExistsAtBase: () => true,
      fileContentAtBase: () => 'a',
      fileContentAtHead: () => 'b',
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'trap_guardrail')).toBe(true);
  });

  it('blocks file creation', () => {
    const result = run({
      diffEntries: [{ status: 'A', path: 'content/new.md' }],
      patches: new Map(),
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'trap_create')).toBe(true);
  });

  it('blocks manifest changes', () => {
    const result = run({
      diffEntries: [{ status: 'M', path: 'package.json' }],
      patches: new Map([['package.json', '']]),
      fileExistsAtBase: () => true,
      fileContentAtBase: () => '{}',
      fileContentAtHead: () => '{"name":"x"}',
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'trap_manifest')).toBe(true);
  });

  it('blocks leaked secrets in diff', () => {
    const result = run({
      fullDiff: '+++ b/content/home.md\n+api_key=AKIAIOSFODNN7EXAMPLE\n',
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'secret_leak')).toBe(true);
  });

  it('blocks a builder branch opened by someone else', () => {
    const result = run({ prAuthor: 'mallory' });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toEqual(['builder_author_mismatch']);
  });

  it('blocks a file type change hidden next to a valid zone edit', () => {
    const result = run({
      diffEntries: [
        { status: 'M', path: 'content/home.md' },
        { status: 'T', path: 'src/app.py' },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'trap_file_type')).toBe(true);
  });

  it('blocks renames', () => {
    const result = run({
      diffEntries: [{ status: 'R', oldPath: 'content/home.md', path: 'content/home2.md' }],
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'trap_rename')).toBe(true);
  });

  it('reports a missing policy before trying to parse it', () => {
    const result = run({ policyYaml: '' });
    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => f.code)).toEqual(['policy_missing']);
  });

  it('blocks hidden unicode', () => {
    const result = run({
      patches: new Map([['content/home.md', '+++ b/content/home.md\n+\u200Bhidden\n']]),
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'trap_unicode')).toBe(true);
  });
});
