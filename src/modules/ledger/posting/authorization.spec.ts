import fc from 'fast-check';
import { ErrorCode } from '../../../common/errors';
import { AuthorizationOutcome, assertReductionAuthorized, authorizeReduction } from './authorization';

const funds = (balanceMinor: bigint, reservedMinor = 0n, overdraftLimitMinor = 0n) => ({
  balanceMinor,
  reservedMinor,
  overdraftLimitMinor,
});

describe('authorization gate (design §6.2)', () => {
  it('authorizes a debit exactly equal to the available balance', () => {
    expect(authorizeReduction(funds(100_000n), 100_000n)).toBe(AuthorizationOutcome.AUTHORIZED);
  });

  it('refuses one minor unit more than available as INSUFFICIENT_FUNDS', () => {
    expect(authorizeReduction(funds(100_000n), 100_001n)).toBe(AuthorizationOutcome.INSUFFICIENT_FUNDS);
  });

  it('₦800 against ₦1,000 is authorized once; against the ₦200 left it is refused', () => {
    expect(authorizeReduction(funds(100_000n), 80_000n)).toBe(AuthorizationOutcome.AUTHORIZED);
    expect(authorizeReduction(funds(20_000n), 80_000n)).toBe(AuthorizationOutcome.INSUFFICIENT_FUNDS);
  });

  it('checks against available = balance − reserved, reporting FUNDS_RESERVED when the total would suffice', () => {
    expect(authorizeReduction(funds(1_000n, 300n), 700n)).toBe(AuthorizationOutcome.AUTHORIZED);
    expect(authorizeReduction(funds(1_000n, 300n), 701n)).toBe(AuthorizationOutcome.FUNDS_RESERVED);
    expect(authorizeReduction(funds(1_000n, 300n), 1_000n)).toBe(AuthorizationOutcome.FUNDS_RESERVED);
    expect(authorizeReduction(funds(1_000n, 300n), 1_001n)).toBe(AuthorizationOutcome.INSUFFICIENT_FUNDS);
  });

  it('allows going below zero only down to −overdraft_limit', () => {
    expect(authorizeReduction(funds(100n, 0n, 50n), 150n)).toBe(AuthorizationOutcome.AUTHORIZED);
    expect(authorizeReduction(funds(100n, 0n, 50n), 151n)).toBe(AuthorizationOutcome.INSUFFICIENT_FUNDS);
  });

  it('an already-negative account cannot be debited further without an overdraft limit', () => {
    expect(authorizeReduction(funds(-10n), 1n)).toBe(AuthorizationOutcome.INSUFFICIENT_FUNDS);
  });

  it('for any state: authorized ⇔ the balance after, net of reservations, stays ≥ −limit', () => {
    const minor = fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n });
    const nonNegative = fc.bigInt({ min: 0n, max: 10n ** 12n });
    fc.assert(
      fc.property(minor, nonNegative, nonNegative, fc.bigInt({ min: 1n, max: 10n ** 12n }), (balance, reserved, limit, reduction) => {
        const outcome = authorizeReduction(funds(balance, reserved, limit), reduction);
        const availableAfter = balance - reserved - reduction;
        const totalAfter = balance - reduction;
        if (availableAfter >= -limit) expect(outcome).toBe(AuthorizationOutcome.AUTHORIZED);
        else if (totalAfter >= -limit) expect(outcome).toBe(AuthorizationOutcome.FUNDS_RESERVED);
        else expect(outcome).toBe(AuthorizationOutcome.INSUFFICIENT_FUNDS);
      }),
    );
  });
});

describe('assertReductionAuthorized — the gate as a guard', () => {
  it('passes an authorized reduction', () => {
    expect(() => assertReductionAuthorized('acct', funds(1_000n, 300n), 700n)).not.toThrow();
  });

  it('raises FUNDS_RESERVED with the figures the client needs', () => {
    expect(() => assertReductionAuthorized('acct', funds(1_000n, 300n), 800n)).toThrow(
      expect.objectContaining({
        code: ErrorCode.FUNDS_RESERVED,
        details: {
          accountId: 'acct',
          requestedMinor: '800',
          balanceMinor: '1000',
          reservedMinor: '300',
          availableMinor: '700',
          overdraftLimitMinor: '0',
        },
      }),
    );
  });

  it('raises INSUFFICIENT_FUNDS when even the total balance cannot cover it', () => {
    expect(() => assertReductionAuthorized('acct', funds(1_000n, 300n), 1_001n)).toThrow(
      expect.objectContaining({ code: ErrorCode.INSUFFICIENT_FUNDS }),
    );
  });
});
