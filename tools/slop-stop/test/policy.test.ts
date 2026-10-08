import { describe, expect, it } from 'vitest';
import { parsePolicyYaml } from '../src/policy.js';

describe('parsePolicyYaml', () => {
  it('accepts a valid policy', () => {
    const policy = parsePolicyYaml(`
version: 1
builders: [alice]
owners: [bob]
target_branch: main
deny: []
zones:
  - id: z1
    name: Zone one
    description: Test
    allow: ["docs/**"]
    escalate_to: bob
`);
    expect(policy.zones[0].id).toBe('z1');
  });

  it('rejects invalid zone ids', () => {
    expect(() =>
      parsePolicyYaml(`
version: 1
builders: [alice]
owners: [bob]
target_branch: main
zones:
  - id: Bad_ID
    name: Zone
    description: Test
    allow: ["a.md"]
    escalate_to: bob
`),
    ).toThrow(/Zone id/);
  });
});
