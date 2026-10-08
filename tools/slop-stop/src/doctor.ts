import { Octokit } from '@octokit/rest';
import type { Policy } from './policy.js';
import { runAllCanaries, type CanaryResult } from './canary.js';
import { builderBranchPrefix } from './branch.js';
import { gitleaksAvailable } from './gitleaks.js';

export type DoctorStatus = 'pass' | 'fail' | 'info' | 'not_enforceable';

export type DoctorItem = {
  id: string;
  status: DoctorStatus;
  title: string;
  detail: string;
  fix?: string;
};

export type DoctorReport = {
  items: DoctorItem[];
  canaries: CanaryResult[];
  ok: boolean;
};

export type DoctorContext = {
  policy: Policy;
  repoRoot: string;
  owner: string;
  repo: string;
  token?: string;
  /** Builders lack admin, so owner-only GitHub settings are reported as info. */
  audience: 'owner' | 'builder';
};

function builderRoleItem(builder: string, role: string): DoctorItem {
  const title = `Builder @${builder} permissions`;
  if (role === 'admin') {
    return {
      id: `builder_admin_${builder}`,
      status: 'fail',
      title,
      detail: 'Builder has admin access.',
      fix: `Settings → Collaborators → @${builder}: set role to Write, not Admin.`,
    };
  }
  if (role === 'write' || role === 'maintain') {
    return { id: `builder_write_${builder}`, status: 'pass', title, detail: `Role is ${role} (not admin).` };
  }
  return {
    id: `builder_write_${builder}`,
    status: 'fail',
    title,
    detail: `Role is ${role}; need at least write.`,
    fix: `Invite @${builder} with Write access.`,
  };
}

async function builderPermissionItem(
  octokit: Octokit,
  owner: string,
  repo: string,
  builder: string,
): Promise<DoctorItem> {
  try {
    const perm = await octokit.repos.getCollaboratorPermissionLevel({ owner, repo, username: builder });
    return builderRoleItem(builder, perm.data.permission);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: `builder_collab_${builder}`,
      status: 'fail',
      title: `Builder @${builder} collaborator`,
      detail: `Could not read collaborator permissions (${msg}).`,
      fix: `Add @${builder} as a collaborator with Write access.`,
    };
  }
}

async function githubItems(ctx: DoctorContext): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  if (!ctx.token) {
    items.push({
      id: 'github_auth',
      status: 'fail',
      title: 'GitHub token',
      detail: 'Set GITHUB_TOKEN or run gh auth login.',
      fix: 'Export GITHUB_TOKEN with repo read access, or use gh auth token.',
    });
    return items;
  }

  const octokit = new Octokit({ auth: ctx.token });
  const { owner, repo } = ctx;
  const target = ctx.policy.target_branch;

  let defaultBranch = target;
  try {
    const repoMeta = await octokit.repos.get({ owner, repo });
    defaultBranch = repoMeta.data.default_branch;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    items.push({
      id: 'repo_access',
      status: 'fail',
      title: 'Repository access',
      detail: msg,
      fix: 'Confirm owner/repo and token scopes (repo or public_repo).',
    });
    return items;
  }

  for (const builder of ctx.policy.builders) {
    items.push(await builderPermissionItem(octokit, owner, repo, builder));
  }

  items.push({
    id: 'builder_branch_rules',
    status: 'not_enforceable',
    title: 'Builder branch prefix rules',
    detail:
      `Each builder should only push to ${ctx.policy.builders
        .map((b) => `"${builderBranchPrefix(b)}"`)
        .join(', ')}. GitHub Rulesets can enforce this on paid plans.`,
    fix:
      'Settings → Rules → Rulesets → restrict pushes by ref name ' +
      '(slop-stop/BUILDER/*) for builder accounts.',
  });

  if (ctx.audience === 'owner') {
    items.push(...(await branchProtectionItems(octokit, owner, repo, target)));
  } else {
    items.push({
      id: 'branch_protection',
      status: 'info',
      title: `Branch protection on ${target}`,
      detail: 'Owner-only check (reading branch protection needs admin); run doctor as an owner.',
    });
  }

  if (defaultBranch === target) {
    items.push({
      id: 'direct_push',
      status: 'info',
      title: 'Direct pushes to target',
      detail:
        'Confirm branch protection blocks direct pushes for builders ' +
        '(owners may need bypass to merge).',
      fix: 'Branch protection: restrict who can push; allow owner bypass only.',
    });
  }

  items.push(
    {
      id: 'auto_merge',
      status: 'not_enforceable',
      title: 'Auto-merge disabled',
      detail: 'Confirm auto-merge is off for the repo (Settings → General).',
      fix: 'Settings → General → uncheck "Allow auto-merge".',
    },
    {
      id: 'ai_reviewers',
      status: 'info',
      title: 'AI code reviewers',
      detail:
        'If Copilot or other AI reviewers are enabled, treat them as advisory only. ' +
        'Human CODEOWNER approval is the merge gate.',
    },
  );

  return items;
}

type BranchProtection = Awaited<
  ReturnType<Octokit['repos']['getBranchProtection']>
>['data'];

function passOrFail(
  ok: boolean,
  item: { id: string; title: string; pass: string; fail: string; fix: string },
): DoctorItem {
  return ok
    ? { id: item.id, status: 'pass', title: item.title, detail: item.pass }
    : { id: item.id, status: 'fail', title: item.title, detail: item.fail, fix: item.fix };
}

function protectionSettingsItems(protection: BranchProtection, target: string): DoctorItem[] {
  const reviews = protection.required_pull_request_reviews;
  const contexts = protection.required_status_checks?.contexts ?? [];
  const items: DoctorItem[] = [
    passOrFail(!protection.allow_force_pushes?.enabled, {
      id: 'branch_force_push',
      title: `${target} force pushes`,
      pass: 'Force pushes blocked.',
      fail: 'Force pushes are allowed.',
      fix: `Settings → Branches → ${target}: disable allow force pushes.`,
    }),
    passOrFail(Boolean(reviews?.require_code_owner_reviews), {
      id: 'codeowners_required',
      title: 'CODEOWNER reviews',
      pass: 'Required on pull requests.',
      fail: 'Not required.',
      fix: `Settings → Branches → ${target} protection: enable "Require review from Code Owners".`,
    }),
    passOrFail(Boolean(reviews?.dismiss_stale_reviews), {
      id: 'stale_reviews',
      title: 'Stale review dismissal',
      pass: 'Enabled.',
      fail: 'Not enabled.',
      fix: `Branch protection for ${target}: enable dismiss stale reviews.`,
    }),
  ];
  for (const required of ['slop-stop/check', 'slop-stop/safety']) {
    items.push(
      passOrFail(contexts.includes(required), {
        id: `status_${required}`,
        title: `Required status: ${required}`,
        pass: 'Listed on branch protection.',
        fail: 'Missing from branch protection.',
        fix: `After the slop-stop workflows run once, add "${required}" to required checks for ${target}.`,
      }),
    );
  }
  return items;
}

async function branchProtectionItems(
  octokit: Octokit,
  owner: string,
  repo: string,
  target: string,
): Promise<DoctorItem[]> {
  try {
    const protection = await octokit.repos.getBranchProtection({ owner, repo, branch: target });
    return protectionSettingsItems(protection.data, target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        id: 'branch_protection',
        status: 'fail',
        title: `Branch protection on ${target}`,
        detail: `No protection rules found, or the token lacks admin (${msg}).`,
        fix:
          `Settings → Branches → Add rule for ${target}: require PR, ` +
          'required status checks, no force push.',
      },
    ];
  }
}

export async function runDoctor(ctx: DoctorContext): Promise<DoctorReport> {
  const items = await githubItems(ctx);

  if (gitleaksAvailable()) {
    items.push({
      id: 'gitleaks_local',
      status: 'pass',
      title: 'gitleaks binary',
      detail: 'Installed for local secret scans.',
    });
  } else {
    items.push({
      id: 'gitleaks_local',
      status: 'info',
      title: 'gitleaks binary',
      detail: 'Not installed; check uses built-in secret patterns.',
      fix: 'Install gitleaks for stronger local scans (optional).',
    });
  }

  const canaries = runAllCanaries(ctx.repoRoot, ctx.policy);
  for (const canary of canaries) {
    items.push({
      id: `canary_${canary.zoneId}`,
      status: canary.guarded ? 'pass' : 'fail',
      title: `Canary: ${canary.zoneId}`,
      detail: canary.message,
      fix: canary.guarded
        ? undefined
        : 'Fix safety_check, or add accept_unguarded to policy with owner sign-off.',
    });
  }

  const ok = items.every(
    (item) =>
      item.status === 'pass' ||
      item.status === 'info' ||
      item.status === 'not_enforceable',
  );

  return { items, canaries, ok };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['slop-stop doctor', ''];
  for (const item of report.items) {
    const tag = item.status.toUpperCase();
    lines.push(`[${tag}] ${item.title}`, `  ${item.detail}`);
    if (item.fix) {
      lines.push(`  Fix: ${item.fix}`);
    }
    lines.push('');
  }
  lines.push(report.ok ? 'Overall: PASS' : 'Overall: FAIL');
  return lines.join('\n');
}
