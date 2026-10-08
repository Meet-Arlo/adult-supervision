import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Policy, Zone } from './policy.js';
import { resolveExecutable, TRUSTED_SH, trustedExecEnv } from './trusted-exec.js';

export type CanaryResult = {
  zoneId: string;
  guarded: boolean;
  message: string;
};

function runShell(cwd: string, command: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(TRUSTED_SH, ['-c', command], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: trustedExecEnv(),
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    const output =
      err && typeof err === 'object' && 'stdout' in err
        ? String((err as { stdout?: string }).stdout ?? '')
        : '';
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: string }).stderr ?? '')
        : '';
    return { ok: false, output: `${output}\n${stderr}`.trim() };
  }
}

export function runZoneCanary(repoRoot: string, zone: Zone): CanaryResult {
  if (!zone.safety_check) {
    return {
      zoneId: zone.id,
      guarded: false,
      message: `Zone "${zone.name}" has no safety_check; treated as unguarded.`,
    };
  }

  const allowPath = zone.allow[0];
  if (!allowPath) {
    return {
      zoneId: zone.id,
      guarded: false,
      message: `Zone "${zone.id}" has empty allow list.`,
    };
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-stop-canary-'));
  const worktreePath = path.join(tmpBase, 'wt');
  try {
    const gitPath = resolveExecutable('git');
    if (!gitPath) {
      throw new Error('git not found in trusted bin directories.');
    }
    execFileSync(gitPath, ['worktree', 'add', '--detach', worktreePath, 'HEAD'], {
      cwd: repoRoot,
      stdio: 'ignore',
      env: trustedExecEnv(),
    });
    const target = path.join(worktreePath, allowPath);
    if (!fs.existsSync(target)) {
      return {
        zoneId: zone.id,
        guarded: false,
        message: `Canary skipped: ${allowPath} missing in repo.`,
      };
    }
    const baseline = runShell(worktreePath, zone.safety_check);
    if (!baseline.ok) {
      return {
        zoneId: zone.id,
        guarded: false,
        message:
          `safety_check already fails on a clean tree for "${zone.name}". ` +
          'Fix the command before relying on it.',
      };
    }
    fs.writeFileSync(target, '', 'utf8');
    const afterBreak = runShell(worktreePath, zone.safety_check);
    if (afterBreak.ok) {
      return {
        zoneId: zone.id,
        guarded: false,
        message:
          `safety_check did not fail after emptying ${allowPath}. ` +
          'Zone is unguarded until tests catch this break.',
      };
    }
    return {
      zoneId: zone.id,
      guarded: true,
      message: `Zone "${zone.name}" is guarded (safety_check failed after canary break).`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      zoneId: zone.id,
      guarded: false,
      message: `Canary error for "${zone.name}": ${msg}`,
    };
  } finally {
    removeCanaryWorktree(repoRoot, worktreePath, tmpBase);
  }
}

function removeCanaryWorktree(repoRoot: string, worktreePath: string, tmpBase: string): void {
  const gitPath = resolveExecutable('git');
  try {
    if (gitPath && fs.existsSync(worktreePath)) {
      execFileSync(gitPath, ['worktree', 'remove', '--force', worktreePath], {
        cwd: repoRoot,
        stdio: 'ignore',
        env: trustedExecEnv(),
      });
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`slop-stop: could not clean up canary worktree ${worktreePath}: ${msg}`);
  }
}

export function runAllCanaries(repoRoot: string, policy: Policy): CanaryResult[] {
  return policy.zones.map((zone) => runZoneCanary(repoRoot, zone));
}

export function applyCanaryResultsToPolicy(policy: Policy, results: CanaryResult[]): Policy {
  const byId = new Map(results.map((r) => [r.zoneId, r.guarded]));
  return {
    ...policy,
    zones: policy.zones.map((zone) => ({
      ...zone,
      guarded: byId.get(zone.id) ?? zone.guarded ?? false,
    })),
  };
}
