import { BREAK_TYPES as MIGRATION_BREAK_TYPES } from '../../database/migrations/1791158400004-CreateReconciliationBreaks';
import { BREAK_POLICIES, BREAK_TYPES, BreakType, subjectKeys } from './break-types';
import { BREAK_STATUSES, BREAK_TRANSITIONS, BreakStatus, assertBreakTransition, canTransitionBreak } from './break-transitions';

describe('break taxonomy', () => {
  it('the code and the database enum list the same types', () => {
    expect([...BREAK_TYPES].sort()).toEqual([...MIGRATION_BREAK_TYPES].sort());
  });

  it('every type has a policy; money and security breaks escalate at detection, investigate ones do not', () => {
    for (const type of BREAK_TYPES) {
      const policy = BREAK_POLICIES[type];
      expect(policy).toBeDefined();
      expect(policy.escalateOnDetection).toBe(policy.severity !== 'INVESTIGATE');
    }
    expect(BREAK_POLICIES[BreakType.HASH_CHAIN_BREAK].severity).toBe('SECURITY');
    expect(BREAK_POLICIES[BreakType.MISSING_IN_LEDGER].severity).toBe('INVESTIGATE');
    expect(BREAK_POLICIES[BreakType.UNSETTLED_PAST_WINDOW].severity).toBe('INVESTIGATE');
  });

  it('subject keys are stable and distinct per kind of subject', () => {
    expect(subjectKeys.payment('psp', 'pay_1')).toBe('payment:psp:pay_1');
    expect(subjectKeys.line('psp', 'stl_1', 'l1')).toBe('line:psp:stl_1:l1');
    expect(subjectKeys.batch('psp', 'stl_1')).toBe('batch:psp:stl_1');
    expect(subjectKeys.flow('f')).toBe('flow:f');
    expect(subjectKeys.webhook('w')).toBe('webhook:w');
    expect(subjectKeys.currency('NGN')).toBe('currency:NGN');
    expect(subjectKeys.account('a')).toBe('account:a');
    expect(subjectKeys.transaction('t')).toBe('transaction:t');
  });
});

describe('break transitions', () => {
  it('OPEN → ESCALATED | RESOLVED; ESCALATED → RESOLVED; nothing leaves RESOLVED', () => {
    const allowed = BREAK_STATUSES.flatMap((from) => BREAK_STATUSES.filter((to) => canTransitionBreak(from, to)).map((to) => `${from}→${to}`));
    expect(allowed).toEqual(['OPEN→ESCALATED', 'OPEN→RESOLVED', 'ESCALATED→RESOLVED']);
    expect(BREAK_TRANSITIONS[BreakStatus.RESOLVED]).toEqual([]);
  });

  it('assertBreakTransition fails loudly on anything else', () => {
    expect(() => assertBreakTransition(BreakStatus.OPEN, BreakStatus.RESOLVED)).not.toThrow();
    expect(() => assertBreakTransition(BreakStatus.RESOLVED, BreakStatus.OPEN)).toThrow(/cannot move from RESOLVED to OPEN/);
    expect(() => assertBreakTransition(BreakStatus.ESCALATED, BreakStatus.OPEN)).toThrow();
  });
});
