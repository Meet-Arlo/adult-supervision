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

/** Env for subprocesses: never inherit PATH from the parent process. */
export function trustedExecEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: TRUSTED_BIN_DIRS.join(path.delimiter),
  };
  const lang = process.env.LANG;
  if (lang) {
    env.LANG = lang;
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
