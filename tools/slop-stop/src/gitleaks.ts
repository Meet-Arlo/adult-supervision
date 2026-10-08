import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExecutable, trustedExecEnv } from './trusted-exec.js';

function resolveGitleaksBinary(): string | null {
  return resolveExecutable('gitleaks');
}

export type SecretFinding = {
  path: string;
  message: string;
};

/** Fallback when the gitleaks binary is not installed. */
const FALLBACK_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/ },
  {
    name: 'GitHub token',
    regex: /ghp_[A-Za-z0-9]{20,}/,
  },
  {
    name: 'Private key block',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
];

function scanAddedLinesWithFallback(diffText: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let currentFile = 'unknown';
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }
    const added = line.slice(1);
    for (const pattern of FALLBACK_PATTERNS) {
      if (pattern.regex.test(added)) {
        findings.push({
          path: currentFile,
          message: `Possible secret (${pattern.name}) in diff for ${currentFile}.`,
        });
        break;
      }
    }
  }
  return findings;
}

function runGitleaksBinary(diffText: string): SecretFinding[] | null {
  const gitleaksPath = resolveGitleaksBinary();
  if (!gitleaksPath) {
    return null;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-gitleaks-'));
  const patchFile = path.join(tmpDir, 'change.patch');
  try {
    fs.writeFileSync(patchFile, diffText, 'utf8');
    let stdout = '';
    let status = 0;
    try {
      stdout = execFileSync(
        gitleaksPath,
        ['detect', '--source', tmpDir, '--no-git', '--redact', '--verbose'],
        { encoding: 'utf8', env: trustedExecEnv() },
      );
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err) {
        status = Number((err as { status?: number }).status) || 1;
        stdout = String((err as { stdout?: string }).stdout ?? '');
        stdout += String((err as { stderr?: string }).stderr ?? '');
      } else {
        throw err;
      }
    }
    if (status === 0) {
      return [];
    }
    const findings: SecretFinding[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.includes('Secret')) {
        continue;
      }
      findings.push({
        path: 'diff',
        message: line.trim(),
      });
    }
    if (findings.length === 0 && status !== 0) {
      findings.push({
        path: 'diff',
        message: 'gitleaks reported a possible secret in this change.',
      });
    }
    return findings;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function scanSecretsInDiff(diffText: string): SecretFinding[] {
  if (!diffText.trim()) {
    return [];
  }
  try {
    const fromBinary = runGitleaksBinary(diffText);
    if (fromBinary !== null) {
      return fromBinary;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`slop-stop: gitleaks failed (${msg}); using built-in secret patterns.`);
  }
  return scanAddedLinesWithFallback(diffText);
}

export function gitleaksAvailable(): boolean {
  const gitleaksPath = resolveGitleaksBinary();
  if (!gitleaksPath) {
    return false;
  }
  try {
    execFileSync(gitleaksPath, ['version'], {
      stdio: 'ignore',
      env: trustedExecEnv(),
    });
    return true;
  } catch {
    return false;
  }
}
