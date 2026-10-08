import { describe, expect, it } from 'vitest';
import {
  addClassic,
  addRules,
  emptyProtection,
  protectionItems,
  type TargetProtection,
} from '../src/protection.js';

type Rules = Parameters<typeof addRules>[1];
type Classic = Parameters<typeof addClassic>[1];

const strictPrRule = {
  type: 'pull_request',
  ruleset_id: 7,
  parameters: {
    required_approving_review_count: 1,
    require_code_owner_review: true,
    dismiss_stale_reviews_on_push: true,
    require_last_push_approval: false,
    required_review_thread_resolution: false,
  },
};

const statusRule = {
  type: 'required_status_checks',
  ruleset_id: 7,
  parameters: {
    strict_required_status_checks_policy: false,
    required_status_checks: [{ context: 'slop-stop/check' }, { context: 'slop-stop/safety' }],
  },
};

function statusById(p: TargetProtection): Record<string, string> {
  return Object.fromEntries(protectionItems(p, 'main').map((i) => [i.id, i.status]));
}

describe('protection from rulesets', () => {
  it('passes everything for a strict ruleset with both required checks', () => {
    const p = addRules(emptyProtection(), [{ type: 'non_fast_forward', ruleset_id: 7 }, strictPrRule, statusRule] as Rules);
    expect(Object.values(statusById(p)).every((s) => s === 'pass')).toBe(true);
    expect([...p.rulesetIds]).toEqual([7]);
  });

  it('fails CODEOWNER approval when the PR rule needs 0 approvals', () => {
    const loose = { ...strictPrRule, parameters: { ...strictPrRule.parameters, required_approving_review_count: 0 } };
    const status = statusById(addRules(emptyProtection(), [loose] as Rules));
    expect(status.target_requires_pr).toBe('pass');
    expect(status.codeowners_required).toBe('fail');
  });

  it('fails every item when the branch has no rules', () => {
    const status = statusById(emptyProtection());
    expect(Object.values(status).every((s) => s === 'fail')).toBe(true);
  });

  it('gives ruleset click paths as numbered fix steps', () => {
    const fix = protectionItems(emptyProtection(), 'main')[0].fix;
    expect(Array.isArray(fix)).toBe(true);
    expect([fix].flat().join('\n')).toContain('Settings → Rules → Rulesets');
  });
});

describe('protection from classic branch protection', () => {
  it('merges with rulesets, keeping the strictest setting', () => {
    const classic = {
      allow_force_pushes: { enabled: false },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        require_code_owner_reviews: true,
        dismiss_stale_reviews: false,
      },
      required_status_checks: { contexts: ['slop-stop/check'], checks: [] },
    } as unknown as Classic;
    const p = addClassic(addRules(emptyProtection(), [strictPrRule] as Rules), classic);
    expect(p.approvals).toBe(2);
    expect(p.staleDismissed).toBe(true);
    expect(p.forcePushBlocked).toBe(true);
    expect(statusById(p)['status_slop-stop/check']).toBe('pass');
    expect(statusById(p)['status_slop-stop/safety']).toBe('fail');
  });
});
