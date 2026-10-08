import { randomUUID } from 'node:crypto';
import { ValidationError } from '../../../common/errors';
import { ApprovalActionType } from '../approvals/approval.types';
import { breakIdOf, parseActionPayload, payloadHash } from './action-payloads';
import { ACTION_POLICIES } from './action-registry';

const now = '2026-09-30T10:00:00Z';

describe('action payloads (strict, canonical, re-parsed at execution)', () => {
  const valid: Record<ApprovalActionType, unknown> = {
    [ApprovalActionType.CORRECTION]: { mode: 'CLEARING_TO_USER', breakId: randomUUID(), userId: randomUUID(), valueTime: now },
    [ApprovalActionType.WRITE_OFF]: { userId: randomUUID(), currency: 'NGN', amount: '1000', valueTime: now },
    [ApprovalActionType.RATE_OVERRIDE]: { mode: 'MANUAL_RATE', rates: { USD: '1', NGN: '1500.25' }, validForSeconds: 600 },
    [ApprovalActionType.SPREAD_CHANGE]: { sourceCurrency: 'NGN', targetCurrency: 'USD', spreadBasisPoints: 75 },
    [ApprovalActionType.SUSPEND_USER]: { userId: randomUUID() },
    [ApprovalActionType.REINSTATE_USER]: { userId: randomUUID() },
    [ApprovalActionType.CLOSE_PERIOD]: { month: '2026-08' },
    [ApprovalActionType.ROLE_CHANGE]: { userId: randomUUID(), role: 'ADMIN', operation: 'GRANT' },
    [ApprovalActionType.RESOLVE_BREAK]: { breakId: randomUUID() },
    [ApprovalActionType.PAYSTACK_WITHDRAWAL_RECOVERY]: { mode: 'LATE_FACT_POST', withdrawalId: randomUUID(), breakId: randomUUID(), observationId: randomUUID(), valueTime: now },
  };

  it.each(Object.values(ApprovalActionType))('%s: a valid payload parses, and its canonical form parses to itself', (type) => {
    const parsed = parseActionPayload(type, valid[type]);
    expect(parseActionPayload(type, parsed)).toEqual(parsed);
  });

  it.each(Object.values(ApprovalActionType))('%s: an unknown field is refused', (type) => {
    expect(() => parseActionPayload(type, { ...(valid[type] as object), sneaky: true })).toThrow(ValidationError);
  });

  it('amounts are digit strings of minor units — a JSON number, a decimal, zero or a sign is refused', () => {
    for (const amount of [1000, '10.5', '0', '-5', '1e3', '']) {
      expect(() => parseActionPayload(ApprovalActionType.WRITE_OFF, { ...(valid.WRITE_OFF as object), amount })).toThrow(ValidationError);
    }
  });

  it('times need an offset; ids must be UUIDs; a correction mode names only its own fields', () => {
    expect(() => parseActionPayload(ApprovalActionType.WRITE_OFF, { ...(valid.WRITE_OFF as object), valueTime: '2026-09-30 10:00' })).toThrow(ValidationError);
    expect(() => parseActionPayload(ApprovalActionType.SUSPEND_USER, { userId: 'nobody' })).toThrow(ValidationError);
    expect(() =>
      parseActionPayload(ApprovalActionType.CORRECTION, { mode: 'CLEARING_TO_PSP_PAYABLE', breakId: randomUUID(), userId: randomUUID(), valueTime: now }),
    ).toThrow(ValidationError);
    expect(() => parseActionPayload(ApprovalActionType.CORRECTION, { mode: 'EDIT_THE_BALANCE', breakId: randomUUID(), valueTime: now })).toThrow(ValidationError);
  });

  it('a spread change changes something, on a real pair; the spread stays below 100%', () => {
    expect(() => parseActionPayload(ApprovalActionType.SPREAD_CHANGE, { sourceCurrency: 'NGN', targetCurrency: 'USD' })).toThrow(ValidationError);
    expect(() => parseActionPayload(ApprovalActionType.SPREAD_CHANGE, { sourceCurrency: 'NGN', targetCurrency: 'NGN', spreadBasisPoints: 1 })).toThrow(ValidationError);
    expect(() => parseActionPayload(ApprovalActionType.SPREAD_CHANGE, { sourceCurrency: 'NGN', targetCurrency: 'USD', spreadBasisPoints: 10_000 })).toThrow(ValidationError);
  });

  it('a manual rate: plain positive decimals (no exponent, no float), bounded validity', () => {
    for (const rate of ['1e3', '-1', '1,500', ' 1']) {
      expect(() => parseActionPayload(ApprovalActionType.RATE_OVERRIDE, { mode: 'MANUAL_RATE', rates: { NGN: rate }, validForSeconds: 600 })).toThrow(ValidationError);
    }
    expect(() => parseActionPayload(ApprovalActionType.RATE_OVERRIDE, { mode: 'MANUAL_RATE', rates: { NGN: 1500 }, validForSeconds: 600 })).toThrow(ValidationError);
    expect(() => parseActionPayload(ApprovalActionType.RATE_OVERRIDE, { mode: 'MANUAL_RATE', rates: {}, validForSeconds: 600 })).toThrow(ValidationError);
    expect(() => parseActionPayload(ApprovalActionType.RATE_OVERRIDE, { mode: 'MANUAL_RATE', rates: { NGN: '1' }, validForSeconds: 30 })).toThrow(ValidationError);
  });

  it('CLOSE_PERIOD is a whole UTC month, stored with its half-open bounds (the SQL function reads them)', () => {
    expect(parseActionPayload(ApprovalActionType.CLOSE_PERIOD, { month: '2026-12' })).toEqual({
      month: '2026-12',
      periodStart: '2026-12-01T00:00:00.000Z',
      periodEnd: '2027-01-01T00:00:00.000Z',
    });
    for (const month of ['2026-13', '2026-1', '26-01']) {
      expect(() => parseActionPayload(ApprovalActionType.CLOSE_PERIOD, { month })).toThrow(ValidationError);
    }
  });

  it('a role change grants ADMIN or SECURITY only — USER is not a privilege', () => {
    expect(() => parseActionPayload(ApprovalActionType.ROLE_CHANGE, { userId: randomUUID(), role: 'USER', operation: 'GRANT' })).toThrow(ValidationError);
    expect(() => parseActionPayload(ApprovalActionType.ROLE_CHANGE, { userId: randomUUID(), role: 'ROOT', operation: 'GRANT' })).toThrow(ValidationError);
  });

  it('the payload hash is canonical (key order does not matter) and names the break it concerns', () => {
    const id = randomUUID();
    expect(payloadHash({ a: 1, b: { c: 2, d: 3 } })).toBe(payloadHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(payloadHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(breakIdOf({ breakId: id })).toBe(id);
    expect(breakIdOf({ userId: id })).toBeNull();
  });

  it('break-glass exists for a suspension and a manual rate only', () => {
    const allowed = Object.values(ApprovalActionType).filter((type) => ACTION_POLICIES[type].breakGlassAllowed(valid[type]));
    expect(allowed).toEqual([ApprovalActionType.RATE_OVERRIDE, ApprovalActionType.SUSPEND_USER]);
    expect(ACTION_POLICIES.RATE_OVERRIDE.breakGlassAllowed({ mode: 'ACCEPT_REJECTED_SNAPSHOT', snapshotId: randomUUID() })).toBe(false);
  });
});
