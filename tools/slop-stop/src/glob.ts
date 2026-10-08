import { minimatch } from 'minimatch';

export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}
