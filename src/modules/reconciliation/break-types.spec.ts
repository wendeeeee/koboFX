import { BREAK_TYPES as PHASE9_BREAK_TYPES } from '../../database/migrations/1791158400004-CreateReconciliationBreaks';
import { WITHDRAWAL_BREAK_TYPES } from '../../database/migrations/1791676800000-AddWithdrawalReconciliationEnumValues';
import { BREAK_POLICIES, BREAK_TYPES, BreakType, subjectKeys } from './break-types';
import { BREAK_STATUSES, BREAK_TRANSITIONS, BreakStatus, assertBreakTransition, canTransitionBreak } from './break-transitions';

describe('break taxonomy', () => {
  it('the code and the database enum list the same types (each migration\'s list is frozen; the enum is their union)', () => {
    expect([...BREAK_TYPES].sort()).toEqual([...PHASE9_BREAK_TYPES, ...WITHDRAWAL_BREAK_TYPES].sort());
    expect(new Set([...PHASE9_BREAK_TYPES, ...WITHDRAWAL_BREAK_TYPES]).size).toBe(PHASE9_BREAK_TYPES.length + WITHDRAWAL_BREAK_TYPES.length);
  });

  it('withdrawal break policies are the W4 table (§I.2)', () => {
    const policy = (type: BreakType) => [BREAK_POLICIES[type].severity, BREAK_POLICIES[type].rederivedBy];
    for (const type of [BreakType.TRANSFER_WITHOUT_INTENT, BreakType.WITHDRAWAL_RETURN_NOT_POSTED, BreakType.WITHDRAWAL_RESERVATION_INCONSISTENT,
      BreakType.STASH_RECEIPT_INCONSISTENT, BreakType.PAYOUT_BALANCE_PROOF_FAILED]) {
      expect(policy(type)).toEqual(['MONEY', 'EXTERNAL_DAILY']);
    }
    expect(policy(BreakType.TRANSFER_IDENTITY_MISMATCH)).toEqual(['SECURITY', 'EXTERNAL_DAILY']);
    expect(policy(BreakType.PAYOUT_FEE_EVIDENCE_MISSING)).toEqual(['INVESTIGATE', 'EXTERNAL_DAILY']);
    expect(policy(BreakType.PAYOUT_TREASURY_EVIDENCE_MISSING)).toEqual(['INVESTIGATE', 'EXTERNAL_DAILY']);
    expect(policy(BreakType.WITHDRAWAL_NOT_POSTED)).toEqual(['INVESTIGATE', null]);
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
    expect(subjectKeys.transfer('paystack', '9007199254741994')).toBe('transfer:paystack:9007199254741994');
    expect(subjectKeys.withdrawal('f')).toBe('withdrawal:f');
    expect(subjectKeys.payoutBalance('paystack', 'NGN')).toBe('payout-balance:paystack:NGN');
    expect(subjectKeys.stashReceipt('s')).toBe('stash-receipt:s');
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
