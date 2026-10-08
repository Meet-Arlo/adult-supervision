import type { Octokit } from '@octokit/rest';
import type { DoctorItem } from './doctor.js';

type ClassicProtection = Awaited<ReturnType<Octokit['repos']['getBranchProtection']>>['data'];
type BranchRule = Awaited<ReturnType<Octokit['repos']['getBranchRules']>>['data'][number];

const REQUIRED_CHECKS = ['slop-stop/check', 'slop-stop/safety'];

/** Classic branch protection and rulesets both apply; GitHub enforces the strictest of the two. */
export type TargetProtection = {
  requiresPr: boolean;
  approvals: number;
  codeOwners: boolean;
  staleDismissed: boolean;
  forcePushBlocked: boolean;
  checks: Set<string>;
  rulesetIds: Set<number>;
};

export function emptyProtection(): TargetProtection {
  return {
    requiresPr: false,
    approvals: 0,
    codeOwners: false,
    staleDismissed: false,
    forcePushBlocked: false,
    checks: new Set(),
    rulesetIds: new Set(),
  };
}

export function addClassic(p: TargetProtection, classic: ClassicProtection): TargetProtection {
  const reviews = classic.required_pull_request_reviews;
  const contexts = [
    ...(classic.required_status_checks?.contexts ?? []),
    ...(classic.required_status_checks?.checks ?? []).map((c) => c.context),
  ];
  return {
    ...p,
    requiresPr: p.requiresPr || Boolean(reviews),
    approvals: Math.max(p.approvals, reviews?.required_approving_review_count ?? 0),
    codeOwners: p.codeOwners || Boolean(reviews?.require_code_owner_reviews),
    staleDismissed: p.staleDismissed || Boolean(reviews?.dismiss_stale_reviews),
    forcePushBlocked: p.forcePushBlocked || !classic.allow_force_pushes?.enabled,
    checks: new Set([...p.checks, ...contexts]),
  };
}

export function addRules(p: TargetProtection, rules: BranchRule[]): TargetProtection {
  const next = { ...p, checks: new Set(p.checks), rulesetIds: new Set(p.rulesetIds) };
  for (const rule of rules) {
    if (rule.ruleset_id !== undefined) {
      next.rulesetIds.add(rule.ruleset_id);
    }
    if (rule.type === 'non_fast_forward') {
      next.forcePushBlocked = true;
    }
    if (rule.type === 'pull_request' && rule.parameters) {
      next.requiresPr = true;
      next.approvals = Math.max(next.approvals, rule.parameters.required_approving_review_count);
      next.codeOwners ||= rule.parameters.require_code_owner_review;
      next.staleDismissed ||= rule.parameters.dismiss_stale_reviews_on_push;
    }
    if (rule.type === 'required_status_checks' && rule.parameters) {
      for (const check of rule.parameters.required_status_checks) {
        next.checks.add(check.context);
      }
    }
  }
  return next;
}

function rulesetFix(target: string, rule: string): string[] {
  return [
    `Settings → Rules → Rulesets → open the ruleset targeting ${target} (or New branch ruleset → Target: ${target}).`,
    rule,
    'Bypass list: Repository admin, set to "For pull requests only". Never add Write; builders have it.',
  ];
}

function item(ok: boolean, id: string, title: string, pass: string, fail: string, fix: string[]): DoctorItem {
  return ok ? { id, status: 'pass', title, detail: pass } : { id, status: 'fail', title, detail: fail, fix };
}

/** Pure: turns merged protection into doctor items for the policy's target branch. */
export function protectionItems(p: TargetProtection, target: string): DoctorItem[] {
  const items = [
    item(
      p.requiresPr,
      'target_requires_pr',
      `Builders can't push to ${target}`,
      `Changes to ${target} must go through a pull request.`,
      `Anyone with Write access can push straight to ${target}.`,
      rulesetFix(target, 'Turn on "Require a pull request before merging".'),
    ),
    item(
      p.approvals >= 1 && p.codeOwners,
      'codeowners_required',
      'CODEOWNER approval required',
      `At least ${p.approvals} approval, including a CODEOWNER.`,
      `Required approvals: ${p.approvals}; CODEOWNER review ${p.codeOwners ? 'on' : 'off'}. A builder could merge their own PR.`,
      rulesetFix(target, 'Under the pull request rule: Required approvals 1, and "Require review from Code Owners".'),
    ),
    item(
      p.staleDismissed,
      'stale_reviews',
      'Stale approvals dismissed',
      'A new push clears earlier approvals.',
      'Approvals survive new pushes, so a builder can change a PR after it is approved.',
      rulesetFix(target, 'Under the pull request rule: "Dismiss stale pull request approvals when new commits are pushed".'),
    ),
    item(
      p.forcePushBlocked,
      'branch_force_push',
      `${target} force pushes`,
      'Force pushes blocked.',
      'Force pushes are allowed.',
      rulesetFix(target, 'Turn on "Block force pushes".'),
    ),
  ];
  for (const check of REQUIRED_CHECKS) {
    items.push(
      item(
        p.checks.has(check),
        `status_${check}`,
        `Required status: ${check}`,
        `Required on ${target}.`,
        `Not required on ${target}.`,
        rulesetFix(
          target,
          `Merge the slop-stop workflows to ${target} first, then turn on "Require status checks to pass" and add "${check}".`,
        ),
      ),
    );
  }
  return items;
}

async function readClassic(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<ClassicProtection | null> {
  try {
    return (await octokit.repos.getBranchProtection({ owner, repo, branch })).data;
  } catch (err) {
    if ((err as { status?: number }).status === 404) {
      return null;
    }
    throw err;
  }
}

async function builderBypassItems(
  octokit: Octokit,
  owner: string,
  repo: string,
  rulesetIds: Set<number>,
): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  for (const id of rulesetIds) {
    const ruleset = (await octokit.repos.getRepoRuleset({ owner, repo, ruleset_id: id, includes_parents: true })).data;
    items.push(
      item(
        ruleset.current_user_can_bypass === 'never',
        `builder_bypass_${id}`,
        `Builder can't bypass "${ruleset.name}"`,
        'No bypass for this builder.',
        `This builder can bypass "${ruleset.name}" (${ruleset.current_user_can_bypass}).`,
        ['Settings → Rules → Rulesets → open the ruleset → remove the Write role or the builder\'s team from the bypass list.'],
      ),
    );
  }
  return items;
}

/**
 * Reads classic branch protection and rulesets for the target branch.
 * Classic protection needs admin to read, so builders only see rulesets.
 */
export async function fetchProtectionItems(
  octokit: Octokit,
  owner: string,
  repo: string,
  target: string,
  audience: 'owner' | 'builder',
): Promise<DoctorItem[]> {
  try {
    const rules = (await octokit.repos.getBranchRules({ owner, repo, branch: target, per_page: 100 })).data;
    let protection = addRules(emptyProtection(), rules);
    if (audience === 'owner') {
      const classic = await readClassic(octokit, owner, repo, target);
      protection = classic ? addClassic(protection, classic) : protection;
      return protectionItems(protection, target);
    }
    if (protection.rulesetIds.size === 0) {
      return [
        {
          id: 'branch_protection',
          status: 'info',
          title: `Protection on ${target}`,
          detail: 'No rulesets on this branch, and classic branch protection needs admin to read. Ask an owner to run doctor.',
        },
      ];
    }
    return [
      ...protectionItems(protection, target),
      ...(await builderBypassItems(octokit, owner, repo, protection.rulesetIds)),
    ];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        id: 'branch_protection',
        status: 'fail',
        title: `Protection on ${target}`,
        detail: `Could not read branch protection or rulesets (${msg}).`,
        fix: 'Confirm the token can read the repo. Private repos need GitHub Pro, Team, or Enterprise for protection.',
      },
    ];
  }
}
