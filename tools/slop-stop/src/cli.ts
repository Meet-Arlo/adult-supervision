#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { Octokit } from '@octokit/rest';
import { Command } from 'commander';
import { parsePolicyYaml, policyPathInRepo, type Policy } from './policy.js';
import { resolveRepoRoot, runCheckCli } from './check-runner.js';
import { formatDoctorReport, runDoctor, type DoctorContext } from './doctor.js';
import { applyCanaryResultsToPolicy, runAllCanaries } from './canary.js';
import { writeInitArtifacts } from './templates.js';
import { runSafetyChecks } from './safety.js';
import { tryGit } from './git.js';

function readGhToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

function parseRemoteOwnerRepo(repoRoot: string): { owner: string; repo: string } {
  const url = tryGit(repoRoot, ['remote', 'get-url', 'origin']) ?? '';
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) {
    throw new Error(`Could not parse GitHub owner/repo from origin: ${url || '(empty)'}`);
  }
  return { owner: match[1], repo: match[2] };
}

function loadRepoPolicy(repoRoot: string, command: string): Policy {
  const policyPath = policyPathInRepo(repoRoot);
  if (!fs.existsSync(policyPath)) {
    throw new Error(`${command}: ${policyPath} is missing. Run slop-stop init first.`);
  }
  return parsePolicyYaml(fs.readFileSync(policyPath, 'utf8'));
}

async function printDoctor(ctx: DoctorContext): Promise<number> {
  const report = await runDoctor(ctx);
  console.log(formatDoctorReport(report));
  return report.ok ? 0 : 1;
}

const program = new Command();
program.name('slop-stop').description('Guardrailed development for non-technical builders');

program
  .command('check')
  .description('Run zone and trap checks (CI and local)')
  .option('--repo-root <path>', 'Git repository root', process.cwd())
  .requiredOption('--base-ref <sha>', 'Base commit SHA or ref')
  .requiredOption('--head-ref <sha>', 'Head commit SHA or ref')
  .requiredOption('--head-branch <name>', 'PR head branch name')
  .requiredOption('--pr-author <login>', 'GitHub PR author login')
  .action((opts) => {
    process.exitCode = runCheckCli({
      repoRoot: resolveRepoRoot(opts.repoRoot),
      baseRef: opts.baseRef,
      headRef: opts.headRef,
      headBranch: opts.headBranch,
      prAuthor: opts.prAuthor,
    });
  });

program
  .command('safety')
  .description('Run zone safety_check commands (PR head checkout required)')
  .option('--repo-root <path>', 'Git repository root', process.cwd())
  .requiredOption('--base-ref <sha>', 'Base commit SHA or ref')
  .requiredOption('--head-ref <sha>', 'Head commit SHA or ref')
  .requiredOption('--head-branch <name>', 'PR head branch name')
  .action((opts) => {
    process.exitCode = runSafetyChecks({
      repoRoot: resolveRepoRoot(opts.repoRoot),
      baseRef: opts.baseRef,
      headRef: opts.headRef,
      headBranch: opts.headBranch,
    });
  });

program
  .command('doctor')
  .description('Audit GitHub settings and run zone canaries (owner)')
  .option('--repo-root <path>', 'Git repository root', process.cwd())
  .option('--owner <login>', 'GitHub org or user (default: from origin)')
  .option('--repo <name>', 'Repository name (default: from origin)')
  .action(async (opts) => {
    const repoRoot = resolveRepoRoot(opts.repoRoot);
    const remote = parseRemoteOwnerRepo(repoRoot);
    process.exitCode = await printDoctor({
      policy: loadRepoPolicy(repoRoot, 'doctor'),
      repoRoot,
      owner: opts.owner ?? remote.owner,
      repo: opts.repo ?? remote.repo,
      token: readGhToken(),
      audience: 'owner',
    });
  });

program
  .command('init')
  .description('Write policy, CODEOWNERS, workflows, and AGENTS.md block (owner)')
  .option('--repo-root <path>', 'Git repository root', process.cwd())
  .requiredOption('--policy-file <path>', 'Policy YAML with builders, owners, and zones')
  .action(async (opts) => {
    const repoRoot = resolveRepoRoot(opts.repoRoot);
    const remote = parseRemoteOwnerRepo(repoRoot);
    const draft = parsePolicyYaml(fs.readFileSync(opts.policyFile, 'utf8'));
    const policy = applyCanaryResultsToPolicy(draft, runAllCanaries(repoRoot, draft));
    const written = writeInitArtifacts(repoRoot, policy);
    console.log(`Wrote:\n${written.map((p) => `  ${p}`).join('\n')}\n\nRunning doctor...`);
    process.exitCode = await printDoctor({
      policy,
      repoRoot,
      owner: remote.owner,
      repo: remote.repo,
      token: readGhToken(),
      audience: 'owner',
    });
  });

program
  .command('join')
  .description('Builder setup: verify token permissions and run doctor')
  .option('--repo-root <path>', 'Git repository root', process.cwd())
  .option('--builder <login>', 'Builder GitHub login to verify')
  .action(async (opts) => {
    const repoRoot = resolveRepoRoot(opts.repoRoot);
    const policy = loadRepoPolicy(repoRoot, 'join');
    const remote = parseRemoteOwnerRepo(repoRoot);
    const token = readGhToken();
    if (!token) {
      throw new Error('join: set GITHUB_TOKEN or run gh auth login.');
    }
    const octokit = new Octokit({ auth: token });
    const login = (await octokit.users.getAuthenticated()).data.login;
    if (opts.builder && opts.builder !== login) {
      throw new Error(`join: authenticated as ${login}, expected ${opts.builder}.`);
    }
    if (!policy.builders.includes(login)) {
      throw new Error(`join: ${login} is not in policy builders list.`);
    }
    const perm = await octokit.repos.getCollaboratorPermissionLevel({
      owner: remote.owner,
      repo: remote.repo,
      username: login,
    });
    if (perm.data.permission === 'admin') {
      throw new Error('join: builders should not use admin tokens.');
    }
    console.log(`join: ${login} has ${perm.data.permission} access (ok).`);
    process.exitCode = await printDoctor({
      policy,
      repoRoot,
      owner: remote.owner,
      repo: remote.repo,
      token,
      audience: 'builder',
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
