import { execFileSync } from 'node:child_process';
import { resolveExecutable, trustedExecEnv } from './trusted-exec.js';

/** Lockfile and generated-file diffs routinely exceed Node's 1 MB default. */
const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

function gitExecutable(): string {
  const gitPath = resolveExecutable('git');
  if (!gitPath) {
    throw new Error('git not found in trusted bin directories.');
  }
  return gitPath;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync(gitExecutable(), args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: trustedExecEnv(),
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  }).trim();
}

export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** Fails loudly when a SHA is missing, e.g. a shallow checkout without fetch-depth: 0. */
export function assertCommitExists(cwd: string, ref: string, label: string): void {
  if (tryGit(cwd, ['cat-file', '-e', `${ref}^{commit}`]) === null) {
    throw new Error(
      `${label} commit ${ref} is not in this clone. ` +
        'Check out with fetch-depth: 0 so base and head history are present.',
    );
  }
}

/** Caller must assertCommitExists(ref) first; null then means the file is absent. */
export function readFileAtRef(cwd: string, ref: string, filePath: string): string | null {
  return tryGit(cwd, ['show', `${ref}:${filePath}`]);
}

/** Raw `git diff --name-status` letters. Anything other than M/A/D/R is a non-content change. */
export type DiffStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X';

const KNOWN_STATUSES: ReadonlySet<string> = new Set(['M', 'A', 'D', 'R', 'C', 'T', 'U']);

export type DiffEntry = {
  path: string;
  status: DiffStatus;
  oldPath?: string;
};

export function parseNameStatus(output: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    if (parts.length < 2) {
      continue;
    }
    const letter = parts[0][0];
    const status = (KNOWN_STATUSES.has(letter) ? letter : 'X') as DiffStatus;
    if (status === 'R' || status === 'C') {
      entries.push({ status, oldPath: parts[1], path: parts[2] ?? parts[1] });
      continue;
    }
    entries.push({ status, path: parts[1] });
  }
  return entries;
}

export function diffNameStatus(
  cwd: string,
  baseRef: string,
  headRef: string,
): DiffEntry[] {
  const out = git(cwd, ['diff', '--name-status', `${baseRef}...${headRef}`]);
  return parseNameStatus(out);
}

export function unifiedDiff(
  cwd: string,
  baseRef: string,
  headRef: string,
  filePath?: string,
): string {
  const args = ['diff', `${baseRef}...${headRef}`];
  if (filePath) {
    args.push('--', filePath);
  }
  return git(cwd, args);
}
