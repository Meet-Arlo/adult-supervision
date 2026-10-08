import fs from 'node:fs';
import path from 'node:path';

/** System bin dirs only (not user-writable) for subprocess PATH. */
export const TRUSTED_BIN_DIRS = [
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/opt/homebrew/bin',
  '/snap/bin',
] as const;

export const TRUSTED_SH = '/bin/sh';

/**
 * Env for subprocesses: never inherit PATH from the parent process.
 * The bin dir of the Node running slop-stop is added so npm/npx resolve under nodenv, nvm, or volta.
 */
export function trustedExecEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: [path.dirname(process.execPath), ...TRUSTED_BIN_DIRS].join(path.delimiter),
  };
  for (const key of ['LANG', 'HOME'] as const) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

export function resolveExecutable(name: string): string | null {
  for (const dir of TRUSTED_BIN_DIRS) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
