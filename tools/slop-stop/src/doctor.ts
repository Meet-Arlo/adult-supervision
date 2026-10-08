import { Octokit } from '@octokit/rest';
import type { Policy } from './policy.js';
import { fetchProtectionItems } from './protection.js';
import { stdoutStyle, type Style } from './style.js';
import { gitleaksAvailable } from './gitleaks.js';

export type DoctorStatus = 'pass' | 'fail' | 'info' | 'not_enforceable';

export type DoctorItem = {
  id: string;
  status: DoctorStatus;
  title: string;
  detail: string;
  /** One string, or ordered steps when the fix takes several clicks. */
  fix?: string | string[];
};

export type DoctorReport = {
  items: DoctorItem[];
  ok: boolean;
};

export type DoctorContext = {
  policy: Policy;
  repoRoot: string;
  owner: string;
  repo: string;
  token?: string;
  /** Builders lack admin, so settings only admins can read are reported as info. */
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

const noop = (): void => undefined;

/** Octokit logs every non-2xx response; callers catch and report errors themselves. */
export function quietOctokit(token: string): Octokit {
  return new Octokit({ auth: token, log: { debug: noop, info: noop, warn: console.warn, error: noop } });
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

  const octokit = quietOctokit(ctx.token);
  const { owner, repo } = ctx;
  const target = ctx.policy.target_branch;

  let allowAutoMerge: boolean | undefined;
  try {
    const repoMeta = await octokit.repos.get({ owner, repo });
    allowAutoMerge = repoMeta.data.allow_auto_merge;
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

  items.push(...(await fetchProtectionItems(octokit, owner, repo, target, ctx.audience)));

  items.push(
    autoMergeItem(allowAutoMerge),
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

/** GitHub only returns allow_auto_merge to admins, so builders see this as info. */
function autoMergeItem(allowAutoMerge: boolean | undefined): DoctorItem {
  const title = 'Auto-merge disabled';
  if (allowAutoMerge === undefined) {
    return { id: 'auto_merge', status: 'info', title, detail: 'Owner-only setting; ask an owner to run doctor.' };
  }
  if (allowAutoMerge) {
    return {
      id: 'auto_merge',
      status: 'fail',
      title,
      detail: 'Auto-merge is on, so an approved PR can merge without a person clicking merge.',
      fix: 'Settings → General → Pull Requests → uncheck "Allow auto-merge".',
    };
  }
  return { id: 'auto_merge', status: 'pass', title, detail: 'Auto-merge is off.' };
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

  const ok = items.every(
    (item) =>
      item.status === 'pass' ||
      item.status === 'info' ||
      item.status === 'not_enforceable',
  );

  return { items, ok };
}

const BADGE_COLOR = {
  pass: 'green',
  fail: 'red',
  not_enforceable: 'yellow',
  info: 'cyan',
} as const;

const BADGE_LABEL: Record<DoctorStatus, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  not_enforceable: 'N/E ',
  info: 'INFO',
};

const INDENT = '         ';

function fixLines(fix: string | string[], style: Style): string[] {
  if (typeof fix === 'string') {
    return [`${INDENT}${style.yellow('→ Fix:')} ${fix}`];
  }
  return [
    `${INDENT}${style.yellow('→ Fix:')}`,
    ...fix.map((step, i) => `${INDENT}  ${style.dim(`${i + 1}.`)} ${step}`),
  ];
}

function itemLines(item: DoctorItem, style: Style): string[] {
  const title = item.status === 'fail' ? style.bold(item.title) : item.title;
  const lines = [
    `  ${style.badge(BADGE_LABEL[item.status], BADGE_COLOR[item.status])} ${title}`,
    `${INDENT}${style.dim(item.detail)}`,
  ];
  if (item.fix && item.status !== 'pass') {
    lines.push(...fixLines(item.fix, style));
  }
  return lines;
}

function summaryLine(items: DoctorItem[], style: Style): string {
  const count = (status: DoctorStatus) => items.filter((i) => i.status === status).length;
  const parts = [
    style.green(`${count('pass')} passed`),
    style.red(`${count('fail')} failed`),
    style.yellow(`${count('not_enforceable')} not enforceable`),
    style.cyan(`${count('info')} info`),
  ];
  return `  ${parts.join(style.dim(' · '))}`;
}

export function formatDoctorReport(report: DoctorReport, style: Style = stdoutStyle()): string {
  const failures = report.items.filter((i) => i.status === 'fail').length;
  const lines = ['', `  ${style.bold('slop-stop doctor')}`, ''];
  for (const item of report.items) {
    lines.push(...itemLines(item, style), '');
  }
  lines.push(summaryLine(report.items, style), '');
  lines.push(
    report.ok
      ? `  ${style.green(style.bold('✔ All required checks pass.'))} ${style.dim('Review N/E items by hand.')}`
      : `  ${style.red(style.bold(`✖ ${failures} ${failures === 1 ? 'item needs' : 'items need'} fixing.`))} ` +
        style.dim('Follow each → Fix, then re-run slop-stop doctor.'),
    '',
  );
  return lines.join('\n');
}
