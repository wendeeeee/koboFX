import fc from 'fast-check';
import { ErrorCode, InvalidAmountError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { InvalidPostingError, LedgerUnbalancedError } from '../ledger.errors';
import {
  EntryDirection,
  LedgerEntryDraft,
  PostingAuthorization,
  PostingRequest,
  TransactionDraft,
  TransactionType,
} from '../ledger.types';
import { validatePostingRequest } from './posting-validation';

const USER_ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const ORIGINAL_TRANSACTION = '33333333-3333-4333-8333-333333333333';

const draft = (overrides: Partial<TransactionDraft> = {}): TransactionDraft => ({
  type: TransactionType.FUNDING,
  authorization: PostingAuthorization.SYSTEM_DRIVEN,
  valueTime: new Date('2026-09-28T10:00:00Z'),
  initiatedBy: 'job:test',
  ...overrides,
});

const debit = (amountMinor: bigint, currency = 'NGN', accountId = USER_ACCOUNT): LedgerEntryDraft => ({
  account: { accountId },
  direction: EntryDirection.DEBIT,
  amount: Money.of(amountMinor, currency),
});

const credit = (amountMinor: bigint, currency = 'NGN', systemAccount = 'BANK'): LedgerEntryDraft => ({
  account: { systemAccount },
  direction: EntryDirection.CREDIT,
  amount: Money.of(amountMinor, currency),
});

const request = (entries: LedgerEntryDraft[], transaction = draft()): PostingRequest => ({ transaction, entries });

function rejectionOf(candidate: PostingRequest): { code: ErrorCode; details?: unknown } {
  try {
    validatePostingRequest(candidate);
  } catch (error) {
    if (error instanceof InvalidPostingError || error instanceof LedgerUnbalancedError || error instanceof InvalidAmountError) {
      return { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error('expected the request to be rejected');
}

describe('validatePostingRequest', () => {
  it('accepts a balanced two-leg posting', () => {
    expect(() => validatePostingRequest(request([debit(100n), credit(100n)]))).not.toThrow();
  });

  it('accepts the design §5.6 conversion: five legs, balanced per currency but not globally', () => {
    const conversion = request(
      [
        debit(100_000_000n, 'NGN'),
        credit(100_000_000n, 'NGN', 'FX_POSITION'),
        { account: { systemAccount: 'FX_POSITION' }, direction: EntryDirection.DEBIT, amount: Money.of(65_338n, 'USD') },
        { account: { accountId: OTHER_ACCOUNT }, direction: EntryDirection.CREDIT, amount: Money.of(65_011n, 'USD') },
        credit(327n, 'USD', 'REVENUE:FX_SPREAD'),
      ],
      draft({ type: TransactionType.CONVERSION, authorization: PostingAuthorization.USER_INITIATED, initiatedBy: 'user:abc' }),
    );
    expect(() => validatePostingRequest(conversion)).not.toThrow();
  });

  it('for any split of a total into debits and credits, a balanced posting is accepted', () => {
    const parts = fc.array(fc.bigInt({ min: 1n, max: 10n ** 12n }), { minLength: 1, maxLength: 5 });
    fc.assert(
      fc.property(parts, parts, (debits, creditsShape) => {
        const total = debits.reduce((sum, value) => sum + value, 0n);
        // Re-split the same total into credits, following the generated shape.
        const credits: bigint[] = [];
        let remaining = total;
        for (const part of creditsShape.slice(0, -1)) {
          const take = part < remaining ? part : remaining - 0n;
          if (take <= 0n || take >= remaining) break;
          credits.push(take);
          remaining -= take;
        }
        credits.push(remaining);
        expect(() =>
          validatePostingRequest(request([...debits.map((a) => debit(a)), ...credits.map((a) => credit(a))])),
        ).not.toThrow();
      }),
    );
  });

  describe('rejects', () => {
    it('fewer than two entries', () => {
      expect(rejectionOf(request([debit(100n)])).code).toBe(ErrorCode.INVALID_POSTING);
      expect(rejectionOf(request([])).code).toBe(ErrorCode.INVALID_POSTING);
    });

    it('a posting unbalanced in one currency, naming the currency', () => {
      const rejection = rejectionOf(request([debit(100n), credit(99n)]));
      expect(rejection.code).toBe(ErrorCode.LEDGER_UNBALANCED);
      expect(rejection.details).toEqual({ unbalanced: [{ currency: 'NGN', debitMinor: '100', creditMinor: '99' }] });
    });

    it('a posting balanced globally but not per currency (NGN debit 100 vs USD credit 100)', () => {
      const rejection = rejectionOf(request([debit(100n, 'NGN'), credit(100n, 'USD')]));
      expect(rejection.code).toBe(ErrorCode.LEDGER_UNBALANCED);
      expect(rejection.details).toEqual({
        unbalanced: [
          { currency: 'NGN', debitMinor: '100', creditMinor: '0' },
          { currency: 'USD', debitMinor: '0', creditMinor: '100' },
        ],
      });
    });

    it('for any imbalance, however small, the posting is rejected', () => {
      fc.assert(
        fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 10n ** 12n }), (amount, other) => {
          fc.pre(amount !== other);
          expect(rejectionOf(request([debit(amount), credit(other)])).code).toBe(ErrorCode.LEDGER_UNBALANCED);
        }),
      );
    });

    it.each([0n, -1n, -100n])('an amount of %s', (amountMinor) => {
      expect(rejectionOf(request([debit(amountMinor), credit(amountMinor)])).code).toBe(ErrorCode.INVALID_AMOUNT);
    });

    it('an amount that is not Money', () => {
      const bad = { ...debit(1n), amount: 100n as unknown as Money };
      expect(rejectionOf(request([bad, credit(100n)])).code).toBe(ErrorCode.INVALID_POSTING);
    });

    it('an unknown direction', () => {
      const bad = { ...debit(100n), direction: 'SIDEWAYS' as EntryDirection };
      expect(rejectionOf(request([bad, credit(100n)])).code).toBe(ErrorCode.INVALID_POSTING);
    });

    it.each([
      ['no account', undefined],
      ['both accountId and systemAccount', { accountId: USER_ACCOUNT, systemAccount: 'BANK' }],
      ['neither', {}],
      ['a malformed accountId', { accountId: 'not-a-uuid' }],
      ['a lowercase systemAccount', { systemAccount: 'bank' }],
      ['a user account addressed as a systemAccount', { systemAccount: 'USER' }],
    ])('an account reference with %s', (_label, account) => {
      const bad = { ...debit(100n), account } as unknown as LedgerEntryDraft;
      expect(rejectionOf(request([bad, credit(100n)])).code).toBe(ErrorCode.INVALID_POSTING);
    });

    it.each([
      ['an unknown type', { type: 'GIFT' as TransactionType }],
      ['an unknown authorization', { authorization: 'MAYBE' as PostingAuthorization }],
      ['an invalid valueTime', { valueTime: new Date('nonsense') }],
      ['an invalid settlementTime', { settlementTime: new Date('nonsense') }],
      ['an initiatedBy without a kind', { initiatedBy: 'someone' }],
      ['a malformed userId', { userId: 'abc' }],
      ['an empty reference', { reference: '  ' }],
      ['a REVERSAL that links nothing', { type: TransactionType.REVERSAL }],
      ['a CORRECTION that links nothing', { type: TransactionType.CORRECTION }],
      ['a FUNDING that claims to correct something', { correctsTransactionId: ORIGINAL_TRANSACTION }],
      ['a malformed correctsTransactionId', { type: TransactionType.REVERSAL, correctsTransactionId: 'x' }],
    ])('a transaction with %s', (_label, overrides) => {
      expect(rejectionOf(request([debit(100n), credit(100n)], draft(overrides))).code).toBe(ErrorCode.INVALID_POSTING);
    });
  });

  it('accepts a REVERSAL or CORRECTION that links its original', () => {
    for (const type of [TransactionType.REVERSAL, TransactionType.CORRECTION]) {
      expect(() =>
        validatePostingRequest(request([debit(1n), credit(1n)], draft({ type, correctsTransactionId: ORIGINAL_TRANSACTION }))),
      ).not.toThrow();
    }
  });
});
