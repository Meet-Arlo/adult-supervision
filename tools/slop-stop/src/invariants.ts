import type { Zone } from './policy.js';

export type InvariantFinding = {
  path: string;
  message: string;
};

function parseMarkdownHeading(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('#')) {
    return null;
  }
  let level = 0;
  while (level < trimmed.length && level < 6 && trimmed[level] === '#') {
    level += 1;
  }
  if (level < 1 || level > 6 || trimmed[level] !== ' ') {
    return null;
  }
  const text = trimmed.slice(level + 1).trim();
  return text.length > 0 ? text : null;
}

function extractMarkdownHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split('\n')) {
    const heading = parseMarkdownHeading(line);
    if (heading !== null) {
      headings.push(heading);
    }
  }
  return headings;
}

function literalPreview(text: string): string {
  const max = 60;
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}

function checkRequireLiteral(
  filePath: string,
  headContent: string,
  literal: string,
): InvariantFinding[] {
  if (headContent.includes(literal)) {
    return [];
  }
  return [
    {
      path: filePath,
      message:
        `Required text must stay in ${filePath}: "${literalPreview(literal)}"`,
    },
  ];
}

function checkFreezeHeadings(
  filePath: string,
  baseContent: string,
  headContent: string,
): InvariantFinding[] {
  const baseHeadings = extractMarkdownHeadings(baseContent);
  const headHeadings = extractMarkdownHeadings(headContent);
  const baseSet = new Set(baseHeadings);
  const headSet = new Set(headHeadings);
  const findings: InvariantFinding[] = [];

  for (const heading of headHeadings) {
    if (!baseSet.has(heading)) {
      findings.push({
        path: filePath,
        message: `New heading not allowed in ${filePath}: "${heading}"`,
      });
    }
  }
  for (const heading of baseHeadings) {
    if (!headSet.has(heading)) {
      findings.push({
        path: filePath,
        message: `Removed heading not allowed in ${filePath}: "${heading}"`,
      });
    }
  }
  return findings;
}

function findingsForInvariant(
  rule: NonNullable<Zone['invariants']>[number],
  filePath: string,
  baseContent: string,
  headContent: string,
): InvariantFinding[] {
  if ('require_literal' in rule) {
    return checkRequireLiteral(filePath, headContent, rule.require_literal);
  }
  if ('freeze_headings' in rule && rule.freeze_headings) {
    return checkFreezeHeadings(filePath, baseContent, headContent);
  }
  return [];
}

export function checkZoneInvariants(
  zone: Zone,
  filePath: string,
  baseContent: string,
  headContent: string,
): InvariantFinding[] {
  if (!zone.invariants?.length) {
    return [];
  }
  return zone.invariants.flatMap((rule) =>
    findingsForInvariant(rule, filePath, baseContent, headContent),
  );
}
