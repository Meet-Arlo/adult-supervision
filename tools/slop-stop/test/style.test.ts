import { describe, expect, it } from 'vitest';
import { createStyle, stdoutStyle } from '../src/style.js';
import { formatDoctorReport, type DoctorReport } from '../src/doctor.js';
import { formatCheckReport, type CheckResult } from '../src/check.js';

const ANSI = /\u001b\[/;

const report: DoctorReport = {
  ok: false,
  items: [
    { id: 'a', status: 'pass', title: 'Passing item', detail: 'Fine.', fix: 'hidden on pass' },
    { id: 'b', status: 'fail', title: 'Broken item', detail: 'Broken.', fix: ['Step one.', 'Step two.'] },
    { id: 'c', status: 'not_enforceable', title: 'Manual item', detail: 'Check by hand.' },
  ],
};

describe('stdoutStyle', () => {
  it('always enables ANSI for CLI output', () => {
    expect(stdoutStyle().bold('x')).toMatch(ANSI);
  });
});

describe('formatDoctorReport', () => {
  it('prints numbered fix steps, a summary, and no ANSI codes when color is off', () => {
    const out = formatDoctorReport(report, createStyle(false));
    expect(out).not.toMatch(ANSI);
    expect(out).toContain(' FAIL  Broken item');
    expect(out).toContain('1. Step one.');
    expect(out).toContain('2. Step two.');
    expect(out).not.toContain('hidden on pass');
    expect(out).toContain('1 passed · 1 failed · 1 not enforceable · 0 info');
    expect(out).toContain('✖ 1 item needs fixing.');
  });

  it('adds ANSI codes when color is on', () => {
    expect(formatDoctorReport(report, createStyle(true))).toMatch(ANSI);
  });
});

describe('formatCheckReport', () => {
  it('lists each finding and the count', () => {
    const result = {
      ok: false,
      isBuilderPr: true,
      findings: [{ message: 'Out of zone: a.py' }, { message: 'Trap: .github edit' }],
    } as CheckResult;
    const out = formatCheckReport(result, createStyle(false));
    expect(out).toContain('✖ slop-stop check failed (2 problems)');
    expect(out).toContain('• Out of zone: a.py');
  });
});
