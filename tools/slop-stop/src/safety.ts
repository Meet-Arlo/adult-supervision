import { execFileSync } from 'node:child_process';
import { assertCommitExists, diffNameStatus, readFileAtRef } from './git.js';
import { matchesAny } from './glob.js';
import { parsePolicyYaml, POLICY_REL_PATH } from './policy.js';
import { parseBuilderBranch } from './branch.js';
import { TRUSTED_SH, trustedExecEnv } from './trusted-exec.js';

export function runSafetyChecks(options: {
  repoRoot: string;
  baseRef: string;
  headRef: string;
  headBranch: string;
}): number {
  assertCommitExists(options.repoRoot, options.baseRef, 'Base');
  assertCommitExists(options.repoRoot, options.headRef, 'Head');
  const policyRaw = readFileAtRef(options.repoRoot, options.baseRef, POLICY_REL_PATH);
  if (!policyRaw) {
    console.error('slop-stop/safety: no policy on base ref.');
    return 1;
  }
  const policy = parsePolicyYaml(policyRaw);
  const builderId = parseBuilderBranch(options.headBranch);
  if (!builderId || !policy.builders.includes(builderId)) {
    console.log('slop-stop/safety: skipped (not a builder PR).');
    return 0;
  }

  const entries = diffNameStatus(options.repoRoot, options.baseRef, options.headRef);
  const modified = entries.filter((e) => e.status === 'M');
  const zonesRun = new Set<string>();

  for (const entry of modified) {
    for (const zone of policy.zones) {
      if (!matchesAny(entry.path, zone.allow)) {
        continue;
      }
      if (!zone.safety_check || zonesRun.has(zone.id)) {
        continue;
      }
      zonesRun.add(zone.id);
      console.log(`Running safety_check for zone ${zone.id}: ${zone.safety_check}`);
      try {
        execFileSync(TRUSTED_SH, ['-c', zone.safety_check], {
          cwd: options.repoRoot,
          stdio: 'inherit',
          env: trustedExecEnv(),
        });
      } catch {
        console.error(`slop-stop/safety: safety_check failed for zone ${zone.id}.`);
        return 1;
      }
    }
  }

  console.log('slop-stop/safety: passed.');
  return 0;
}
