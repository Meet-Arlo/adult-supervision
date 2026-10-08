import type { DiffEntry } from './git.js';
import { matchesAny } from './glob.js';

const GUARDRAIL_PATTERNS = [
  '.slop-stop/**',
  '**/CODEOWNERS',
  '.github/**',
  '**/AGENTS.md',
  '**/CLAUDE.md',
  '.cursor/**',
  '.claude/**',
];

const MANIFEST_PATTERNS = [
  '**/package.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/Cargo.lock',
  '**/go.sum',
  '**/Gemfile.lock',
  '**/poetry.lock',
  '**/requirements.txt',
];

const ENV_PATTERNS = ['**/.env', '**/.env.*'];

/** Bidirectional and zero-width Unicode (emoji allowed). */
const DANGEROUS_UNICODE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;

export type TrapFinding = {
  code: string;
  message: string;
  path?: string;
};

export function trapGuardrailPaths(entries: DiffEntry[]): TrapFinding[] {
  const findings: TrapFinding[] = [];
  for (const entry of entries) {
    if (matchesAny(entry.path, GUARDRAIL_PATTERNS)) {
      findings.push({
        code: 'trap_guardrail',
        path: entry.path,
        message: `Builders cannot change guardrail files (${entry.path}).`,
      });
    }
  }
  return findings;
}

export function trapManifestChanges(entries: DiffEntry[]): TrapFinding[] {
  const findings: TrapFinding[] = [];
  for (const entry of entries) {
    if (matchesAny(entry.path, MANIFEST_PATTERNS)) {
      findings.push({
        code: 'trap_manifest',
        path: entry.path,
        message: `Dependency manifests are off limits (${entry.path}).`,
      });
    }
  }
  return findings;
}

export function trapEnvFiles(entries: DiffEntry[]): TrapFinding[] {
  const findings: TrapFinding[] = [];
  for (const entry of entries) {
    if (matchesAny(entry.path, ENV_PATTERNS)) {
      findings.push({
        code: 'trap_env',
        path: entry.path,
        message: `Environment files cannot be changed (${entry.path}).`,
      });
    }
  }
  return findings;
}

function nonEditFinding(entry: DiffEntry): TrapFinding | null {
  switch (entry.status) {
    case 'M':
      return null;
    case 'A':
      return {
        code: 'trap_create',
        path: entry.path,
        message: `Builders cannot add new files (${entry.path}).`,
      };
    case 'D':
      return {
        code: 'trap_delete',
        path: entry.path,
        message: `Builders cannot delete files (${entry.path}).`,
      };
    case 'R':
    case 'C':
      return {
        code: 'trap_rename',
        path: entry.path,
        message: `Builders cannot rename or copy files (${entry.oldPath} -> ${entry.path}).`,
      };
    case 'T':
    case 'U':
    case 'X':
      return {
        code: 'trap_file_type',
        path: entry.path,
        message:
          `Builders can only edit file contents; ${entry.path} changed type ` +
          '(for example became a symlink).',
      };
    default: {
      const unhandled: never = entry.status;
      throw new Error(`Unhandled diff status: ${String(unhandled)}`);
    }
  }
}

export function trapNonEdits(entries: DiffEntry[]): TrapFinding[] {
  return entries.map(nonEditFinding).filter((f): f is TrapFinding => f !== null);
}

export function scanUnicodeInPatch(patch: string, filePath: string): TrapFinding[] {
  const findings: TrapFinding[] = [];
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }
    const added = line.slice(1);
    if (DANGEROUS_UNICODE.test(added)) {
      findings.push({
        code: 'trap_unicode',
        path: filePath,
        message:
          `Hidden or bidirectional Unicode in ${filePath}. ` +
          'Remove zero-width or bidi override characters.',
      });
      break;
    }
  }
  return findings;
}

export function isLikelyBinaryPatch(patch: string): boolean {
  return patch.includes('Binary files') || patch.includes('GIT binary patch');
}

export function trapBinaryPatch(patch: string, filePath: string): TrapFinding[] {
  if (!isLikelyBinaryPatch(patch)) {
    return [];
  }
  return [
    {
      code: 'trap_binary',
      path: filePath,
      message: `Binary changes are not allowed (${filePath}).`,
    },
  ];
}

export function runTraps(
  entries: DiffEntry[],
  patches: Map<string, string>,
): TrapFinding[] {
  return [
    ...trapGuardrailPaths(entries),
    ...trapManifestChanges(entries),
    ...trapEnvFiles(entries),
    ...trapNonEdits(entries),
    ...entries.flatMap((entry) => {
      const patch = patches.get(entry.path) ?? '';
      return [
        ...trapBinaryPatch(patch, entry.path),
        ...scanUnicodeInPatch(patch, entry.path),
      ];
    }),
  ];
}
