import { parseBuilderBranch } from './branch.js';
import type { DiffEntry } from './git.js';
import { matchesAny } from './glob.js';
import { checkZoneInvariants } from './invariants.js';
import { scanSecretsInDiff } from './gitleaks.js';
import { type Policy, type Zone, parsePolicyYaml, POLICY_REL_PATH } from './policy.js';
import { runTraps } from './traps.js';
import { stdoutStyle, type Style } from './style.js';

export type CheckInput = {
  policyYaml: string;
  baseRef: string;
  baseBranch: string;
  headRef: string;
  headBranch: string;
  prAuthor: string;
  diffEntries: DiffEntry[];
  fullDiff: string;
  fileContentAtBase: (path: string) => string | null;
  fileContentAtHead: (path: string) => string | null;
  fileExistsAtBase: (path: string) => boolean;
  patches: Map<string, string>;
};

export type CheckFinding = {
  level: 'error' | 'warn';
  code: string;
  message: string;
};

export type CheckResult = {
  ok: boolean;
  findings: CheckFinding[];
  isBuilderPr: boolean;
};

function zoneForPath(policy: Policy, filePath: string): Zone | null {
  if (matchesAny(filePath, policy.deny)) {
    return null;
  }
  for (const zone of policy.zones) {
    if (matchesAny(filePath, zone.allow)) {
      return zone;
    }
  }
  return null;
}

function zoneHasSafetyCommand(zone: Zone): boolean {
  return Boolean(zone.safety_check) || Boolean(zone.accept_unguarded);
}

function addFinding(
  findings: CheckFinding[],
  level: CheckFinding['level'],
  code: string,
  message: string,
): void {
  findings.push({ level, code, message });
}

export function runCheck(input: CheckInput): CheckResult {
  const findings: CheckFinding[] = [];
  const builderId = parseBuilderBranch(input.headBranch);
  const isBuilderBranch = builderId !== null;

  if (!input.policyYaml.trim()) {
    addFinding(
      findings,
      'error',
      'policy_missing',
      `No policy at ${POLICY_REL_PATH} on base ref; every PR fails closed.`,
    );
    return { ok: false, findings, isBuilderPr: false };
  }

  let policy: Policy;
  try {
    policy = parsePolicyYaml(input.policyYaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addFinding(findings, 'error', 'policy_invalid', msg);
    return { ok: false, findings, isBuilderPr: false };
  }

  const authorInBuilders = policy.builders.includes(input.prAuthor);

  if (authorInBuilders && !isBuilderBranch) {
    addFinding(
      findings,
      'error',
      'builder_branch_required',
      `Author "${input.prAuthor}" is a builder and must use branch ` +
        `slop-stop/${input.prAuthor}/<slug> (got "${input.headBranch}").`,
    );
    return { ok: false, findings, isBuilderPr: false };
  }

  if (!isBuilderBranch) {
    if (policy.owners.includes(input.prAuthor)) {
      return { ok: true, findings, isBuilderPr: false };
    }
    addFinding(
      findings,
      'error',
      'non_owner_branch',
      `PR branch "${input.headBranch}" is not a builder branch ` +
        `(use slop-stop/<builder>/<slug>), and author "${input.prAuthor}" ` +
        'is not listed in policy owners.',
    );
    return { ok: false, findings, isBuilderPr: false };
  }

  if (input.baseBranch !== policy.target_branch) {
    addFinding(
      findings,
      'error',
      'wrong_merge_target',
      `Builder PRs must target "${policy.target_branch}" (got "${input.baseBranch}").`,
    );
    return { ok: false, findings, isBuilderPr: true };
  }

  if (!policy.builders.includes(builderId)) {
    addFinding(
      findings,
      'error',
      'unknown_builder',
      `Branch prefix slop-stop/${builderId}/ is not in policy builders list.`,
    );
    return { ok: false, findings, isBuilderPr: true };
  }

  if (input.prAuthor !== builderId) {
    addFinding(
      findings,
      'error',
      'builder_author_mismatch',
      `Branch slop-stop/${builderId}/ belongs to ${builderId}, but the PR was opened ` +
        `by "${input.prAuthor}".`,
    );
    return { ok: false, findings, isBuilderPr: true };
  }

  for (const trap of runTraps(input.diffEntries, input.patches)) {
    addFinding(findings, 'error', trap.code, trap.message);
  }

  for (const secret of scanSecretsInDiff(input.fullDiff)) {
    addFinding(findings, 'error', 'secret_leak', secret.message);
  }

  const modified = input.diffEntries.filter((e) => e.status === 'M');
  if (modified.length === 0 && input.diffEntries.length > 0) {
    addFinding(
      findings,
      'error',
      'no_modify',
      'Builder PRs must only modify existing files within a zone.',
    );
  }

  const zonesTouched = new Set<string>();

  for (const entry of modified) {
    const filePath = entry.path;
    if (!input.fileExistsAtBase(filePath)) {
      addFinding(
        findings,
        'error',
        'file_not_on_base',
        `${filePath} does not exist on the base branch; builders cannot add files.`,
      );
      continue;
    }

    const zone = zoneForPath(policy, filePath);
    if (!zone) {
      addFinding(
        findings,
        'error',
        'out_of_zone',
        `${filePath} is outside every builder zone (or matches deny list).`,
      );
      continue;
    }

    zonesTouched.add(zone.id);

    if (!zoneHasSafetyCommand(zone)) {
      addFinding(
        findings,
        'error',
        'no_safety_check',
        `Zone "${zone.name}" (${zone.id}) has no safety_check. Add one, or accept_unguarded in policy.`,
      );
    }

    const baseContent = input.fileContentAtBase(filePath) ?? '';
    const headContent = input.fileContentAtHead(filePath) ?? '';
    for (const inv of checkZoneInvariants(zone, filePath, baseContent, headContent)) {
      addFinding(findings, 'error', 'invariant', inv.message);
    }
  }

  if (zonesTouched.size > 1) {
    addFinding(
      findings,
      'error',
      'multi_zone',
      'Builder PRs may touch only one zone per PR.',
    );
  }

  const hasError = findings.some((f) => f.level === 'error');
  return { ok: !hasError, findings, isBuilderPr: true };
}

export function formatCheckReport(result: CheckResult, style: Style = stdoutStyle()): string {
  if (result.ok) {
    const kind = result.isBuilderPr ? 'builder PR' : 'owner PR';
    return `${style.green(style.bold('✔ slop-stop check passed'))} ${style.dim(`(${kind})`)}`;
  }
  const count = result.findings.length;
  const lines = [
    style.red(style.bold('✖ slop-stop check failed')) +
      style.dim(` (${count} problem${count === 1 ? '' : 's'})`),
    ...result.findings.map((f) => `  ${style.red('•')} ${f.message}`),
  ];
  return lines.join('\n');
}
