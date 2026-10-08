import { resolveRepoRoot, runCheckCli } from './check-runner.js';
import { runSafetyChecks } from './safety.js';

/** GitHub keeps hyphens in input env names: `base-ref` arrives as INPUT_BASE-REF. */
export function readInput(env: NodeJS.ProcessEnv, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

function requireInput(env: NodeJS.ProcessEnv, name: string): string {
  const value = readInput(env, name);
  if (!value) {
    throw new Error(`Missing required action input: ${name}`);
  }
  return value;
}

export function runFromActionEnv(env: NodeJS.ProcessEnv, cwd: string): number {
  const mode = requireInput(env, 'mode');
  const repoRoot = resolveRepoRoot(cwd);
  const baseRef = requireInput(env, 'base-ref');
  const headRef = requireInput(env, 'head-ref');
  const headBranch = requireInput(env, 'head-branch');

  if (mode === 'check') {
    return runCheckCli({
      repoRoot,
      baseRef,
      baseBranch: requireInput(env, 'base-branch'),
      headRef,
      headBranch,
      prAuthor: requireInput(env, 'pr-author'),
    });
  }
  if (mode === 'safety') {
    return runSafetyChecks({ repoRoot, baseRef, headRef, headBranch });
  }
  throw new Error(`Unknown action mode: ${mode}`);
}
