import { runFromActionEnv } from './github-action.js';

try {
  process.exit(runFromActionEnv(process.env, process.cwd()));
} catch (err) {
  console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
