import fc from 'fast-check';
import { ErrorCode } from '../../common/errors';
import { Money } from '../../common/money';
import { EntryDirection, LedgerEntryDraft, NormalSide } from '../ledger/ledger.types';
import { netUserAccountChanges, settledAmountMinor, settlementArithmetic } from './settlement';

const RESERVED = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_USER = 'aaaaaaaa-0000-4000-8000-000000000002';
const userAccounts = new Map([
  [RESERVED, { normalSide: NormalSide.CREDIT }],
  [OTHER_USER, { normalSide: NormalSide.CREDIT }],
]);
const entry = (account: LedgerEntryDraft['account'], direction: EntryDirection, amountMinor: bigint): LedgerEntryDraft => ({
  account,
  direction,
  amount: Money.of(amountMinor, 'NGN'),
});

describe('settlement arithmetic (design §6.3 property 2)', () => {
  it('less than the estimate: the remainder is released, nothing is excess', () => {
    expect(settlementArithmetic(80_000n, 75_000n)).toEqual({ releasedRemainderMinor: 5_000n, excessOverEstimateMinor: 0n });
  });

  it('equal to the estimate: nothing left over either way', () => {
    expect(settlementArithmetic(80_000n, 80_000n)).toEqual({ releasedRemainderMinor: 0n, excessOverEstimateMinor: 0n });
  });

  it('more than the estimate: the excess is reported, to be booked as an overdraft (§16)', () => {
    expect(settlementArithmetic(80_000n, 81_250n)).toEqual({ releasedRemainderMinor: 0n, excessOverEstimateMinor: 1_250n });
  });

  it('for any estimate and actual: actual = estimate − remainder + excess, and at most one is non-zero', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 15n }), fc.bigInt({ min: 1n, max: 10n ** 15n }), (estimate, actual) => {
        const { releasedRemainderMinor, excessOverEstimateMinor } = settlementArithmetic(estimate, actual);
        expect(estimate - releasedRemainderMinor + excessOverEstimateMinor).toBe(actual);
        expect(releasedRemainderMinor >= 0n && excessOverEstimateMinor >= 0n).toBe(true);
        expect(releasedRemainderMinor === 0n || excessOverEstimateMinor === 0n).toBe(true);
      }),
    );
  });
});

describe('the settled amount is the posting’s net reduction of the reserved account', () => {
  it('nets several legs on the reserved account and ignores internal accounts', () => {
    const changes = netUserAccountChanges(
      [
        entry({ accountId: RESERVED.toUpperCase() }, EntryDirection.DEBIT, 80_000n),
        entry({ accountId: RESERVED }, EntryDirection.CREDIT, 500n),
        entry({ systemAccount: 'BANK' }, EntryDirection.CREDIT, 79_500n),
        entry({ accountId: 'bbbbbbbb-0000-4000-8000-00000000000b' }, EntryDirection.DEBIT, 1n),
      ],
      userAccounts,
    );
    expect(changes).toEqual(new Map([[RESERVED, -79_500n]]));
    expect(settledAmountMinor(RESERVED, changes)).toBe(79_500n);
  });

  it('allows crediting another user account (a conversion credits the target wallet)', () => {
    const changes = new Map([
      [RESERVED, -80_000n],
      [OTHER_USER, 5_000n],
    ]);
    expect(settledAmountMinor(RESERVED, changes)).toBe(80_000n);
  });

  it.each([
    ['a zero actual (that is a release, not a settlement)', new Map([[RESERVED, 0n]])],
    ['a posting that does not touch the reserved account', new Map<string, bigint>()],
    ['a posting that credits the reserved account', new Map([[RESERVED, 10n]])],
    [
      'a posting that also reduces an unreserved user account',
      new Map([
        [RESERVED, -80_000n],
        [OTHER_USER, -1n],
      ]),
    ],
  ])('refuses %s with INVALID_RESERVATION', (_, changes) => {
    expect(() => settledAmountMinor(RESERVED, changes)).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_RESERVATION }));
  });
});
