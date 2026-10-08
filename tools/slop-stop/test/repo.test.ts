import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { runCheckInRepo } from '../src/check-runner.js';
import { parsePolicyYaml } from '../src/policy.js';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
}

const policy = parsePolicyYaml(
  yaml.dump({
    version: 1,
    builders: ['bea'],
    owners: ['al'],
    target_branch: 'main',
    zones: [
      {
        id: 'home',
        name: 'Home',
        description: 'Home copy',
        allow: ['content/home.md'],
        safety_check: 'node check.cjs',
        escalate_to: 'al',
      },
    ],
  }),
);

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  write('content/home.md', '# Home\nWelcome\n');
  write(
    'check.cjs',
    "if (!require('fs').readFileSync('content/home.md', 'utf8').trim()) process.exit(1);\n",
  );
  write('.slop-stop/policy.yml', yaml.dump(policy));
  git('add', '-A');
  git('commit', '-qm', 'base');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('runCheckInRepo', () => {
  it('handles an owner PR with a diff over 1 MB', () => {
    git('checkout', '-q', '-b', 'feature/big');
    write('data.txt', 'x'.repeat(60).concat('\n').repeat(40_000));
    git('add', '-A');
    git('commit', '-qm', 'big');
    const result = runCheckInRepo({
      repoRoot: repo,
      baseRef: 'main',
      baseBranch: 'main',
      headRef: 'HEAD',
      headBranch: 'feature/big',
      prAuthor: 'al',
    });
    expect(result.ok).toBe(true);
  });

  it('explains a missing base commit instead of reporting a missing policy', () => {
    expect(() =>
      runCheckInRepo({
        repoRoot: repo,
        baseRef: '0'.repeat(40),
        baseBranch: 'main',
        headRef: 'HEAD',
        headBranch: 'slop-stop/bea/x',
        prAuthor: 'bea',
      }),
    ).toThrow(/Base commit .* is not in this clone/);
  });

  it('blocks a denied file swapped for a symlink', () => {
    write('src/app.py', 'print(1)\n');
    git('add', '-A');
    git('commit', '-qm', 'app');
    git('checkout', '-q', '-b', 'slop-stop/bea/link');
    write('content/home.md', '# Home\nWelcome back\n');
    fs.rmSync(path.join(repo, 'src/app.py'));
    fs.symlinkSync('/etc/passwd', path.join(repo, 'src/app.py'));
    git('add', '-A');
    git('commit', '-qm', 'link');
    const result = runCheckInRepo({
      repoRoot: repo,
      baseRef: 'main',
      baseBranch: 'main',
      headRef: 'HEAD',
      headBranch: 'slop-stop/bea/link',
      prAuthor: 'bea',
    });
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.code === 'trap_file_type')).toBe(true);
  });
});
