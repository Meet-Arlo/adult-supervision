import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

const invariantSchema = z.union([
  z.object({ require_literal: z.string().min(1) }),
  z.object({ freeze_headings: z.literal(true) }),
]);

const acceptUnguardedSchema = z.object({
  by: z.string().min(1),
  reason: z.string().min(1),
});

const zoneSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'Zone id must be lowercase letters, numbers, and hyphens'),
  name: z.string().min(1),
  description: z.string().min(1),
  allow: z.array(z.string().min(1)).min(1),
  safety_check: z.string().min(1).optional(),
  invariants: z.array(invariantSchema).optional(),
  escalate_to: z.string().min(1),
  guarded: z.boolean().optional(),
  accept_unguarded: acceptUnguardedSchema.optional(),
});

export const policySchema = z.object({
  version: z.literal(1),
  builders: z.array(z.string().min(1)).min(1),
  owners: z.array(z.string().min(1)).min(1),
  target_branch: z.string().min(1),
  deny: z.array(z.string()).default([]),
  zones: z.array(zoneSchema).min(1),
});

export type Policy = z.infer<typeof policySchema>;
export type Zone = z.infer<typeof zoneSchema>;

export function parsePolicyYaml(raw: string): Policy {
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Policy YAML is invalid: ${msg}`);
  }
  const result = policySchema.safeParse(parsed);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'policy'}: ${issue.message}`,
    );
    throw new Error(`Policy failed validation:\n- ${lines.join('\n- ')}`);
  }
  return result.data;
}

export function loadPolicyFromFile(filePath: string): Policy {
  const raw = fs.readFileSync(filePath, 'utf8');
  return parsePolicyYaml(raw);
}

export const POLICY_REL_PATH = '.slop-stop/policy.yml';

export function policyPathInRepo(repoRoot: string): string {
  return path.join(repoRoot, POLICY_REL_PATH);
}
