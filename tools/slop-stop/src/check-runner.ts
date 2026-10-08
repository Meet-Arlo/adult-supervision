import path from 'node:path';
import {
  assertCommitExists,
  diffNameStatus,
  readFileAtRef,
  tryGit,
  unifiedDiff,
  type DiffEntry,
} from './git.js';
import { parseBuilderBranch } from './branch.js';
import { POLICY_REL_PATH } from './policy.js';
import { formatCheckReport, runCheck, type CheckResult } from './check.js';

export type RunCheckOptions = {
  repoRoot: string;
  baseRef: string;
  headRef: string;
  headBranch: string;
  prAuthor: string;
};

type DiffData = {
  diffEntries: DiffEntry[];
  fullDiff: string;
  patches: Map<string, string>;
};

function loadDiff(cwd: string, baseRef: string, headRef: string): DiffData {
  const diffEntries = diffNameStatus(cwd, baseRef, headRef);
  const patches = new Map<string, string>();
  for (const entry of diffEntries) {
    patches.set(entry.path, unifiedDiff(cwd, baseRef, headRef, entry.path));
  }
  return { diffEntries, fullDiff: unifiedDiff(cwd, baseRef, headRef), patches };
}

export function runCheckInRepo(options: RunCheckOptions): CheckResult {
  const { repoRoot, baseRef, headRef, headBranch, prAuthor } = options;
  assertCommitExists(repoRoot, baseRef, 'Base');
  assertCommitExists(repoRoot, headRef, 'Head');

  const policyYaml = readFileAtRef(repoRoot, baseRef, POLICY_REL_PATH) ?? '';
  // Only builder branches are diffed; owner and non-builder PRs are decided on identity alone.
  const diff: DiffData =
    parseBuilderBranch(headBranch) === null
      ? { diffEntries: [], fullDiff: '', patches: new Map() }
      : loadDiff(repoRoot, baseRef, headRef);

  return runCheck({
    policyYaml,
    baseRef,
    headRef,
    headBranch,
    prAuthor,
    ...diff,
    fileContentAtBase: (p) => readFileAtRef(repoRoot, baseRef, p),
    fileContentAtHead: (p) => readFileAtRef(repoRoot, headRef, p),
    fileExistsAtBase: (p) => readFileAtRef(repoRoot, baseRef, p) !== null,
  });
}

export function runCheckCli(options: RunCheckOptions): number {
  const result = runCheckInRepo(options);
  console.log(formatCheckReport(result));
  return result.ok ? 0 : 1;
}

export function resolveRepoRoot(cwd: string): string {
  const root = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) {
    throw new Error('Run slop-stop from inside a git repository.');
  }
  return path.resolve(root);
}
