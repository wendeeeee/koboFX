import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { Client } from 'pg';
import { DomainError, ErrorCode } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import {
  AccountReference,
  EntryDirection,
  LedgerEntryDraft,
  NormalSide,
  PostedTransaction,
  PostingAuthorization,
  PostingRequest,
  TransactionType,
} from '../../src/modules/ledger/ledger.types';
import { signedBalanceChange } from '../../src/modules/ledger/posting/sign';
import { LedgerHarness, UserAccount, startLedgerHarness } from '../support/ledger-harness';

/**
 * "For any sequence of postings, the books balance" (design §11) — with the
 * invariants asserted after EVERY step, not only at the end, so a failure points at
 * the posting that broke them. The invariant is the oracle; alongside it, an
 * independent in-memory model of every balance.
 */

const CURRENCIES = ['NGN', 'USD', 'EUR'] as const;
type Currency = (typeof CURRENCIES)[number];
const SYSTEM_ACCOUNTS = [
  'BANK',
  'PSP_RECEIVABLE',
  'CLEARING',
  'FX_POSITION',
  'REVENUE:FX_SPREAD',
  'EXPENSE:PSP_FEES',
  'EXPENSE:PROMOTIONAL',
  'EQUITY:ROUNDING',
  'EXPENSE:WRITE_OFF',
] as const;
const USERS_PER_CURRENCY = 3;
const LOCKED_PERIOD_VALUE_TIME = new Date('2001-06-15T12:00:00Z');

type Target = { readonly user: number } | { readonly system: string };
interface CurrencyGroup {
  readonly currency: Currency;
  readonly debits: readonly { target: Target; amountMinor: bigint }[];
  readonly creditTargets: readonly Target[];
}
interface PostingShape {
  readonly authorization: PostingAuthorization;
  readonly groups: readonly CurrencyGroup[];
}
type Operation =
  | { readonly kind: 'post'; readonly shape: PostingShape }
  | { readonly kind: 'reverse'; readonly pick: number }
  | { readonly kind: 'correct'; readonly pick: number; readonly shape: PostingShape };

const targetArbitrary: fc.Arbitrary<Target> = fc.oneof(
  fc.integer({ min: 0, max: USERS_PER_CURRENCY - 1 }).map((user) => ({ user })),
  fc.constantFrom(...SYSTEM_ACCOUNTS).map((system) => ({ system })),
);
const groupArbitrary: fc.Arbitrary<CurrencyGroup> = fc.record({
  currency: fc.constantFrom(...CURRENCIES),
  debits: fc.array(fc.record({ target: targetArbitrary, amountMinor: fc.bigInt({ min: 1n, max: 5_000_000n }) }), {
    minLength: 1,
    maxLength: 3,
  }),
  creditTargets: fc.array(targetArbitrary, { minLength: 1, maxLength: 3 }),
});
const shapeArbitrary: fc.Arbitrary<PostingShape> = fc.record({
  authorization: fc.constantFrom(PostingAuthorization.USER_INITIATED, PostingAuthorization.SYSTEM_DRIVEN),
  groups: fc.array(groupArbitrary, { minLength: 1, maxLength: 2 }),
});
const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  { weight: 6, arbitrary: shapeArbitrary.map((shape) => ({ kind: 'post' as const, shape })) },
  { weight: 2, arbitrary: fc.nat().map((pick) => ({ kind: 'reverse' as const, pick })) },
  { weight: 1, arbitrary: fc.record({ pick: fc.nat(), shape: shapeArbitrary }).map((op) => ({ kind: 'correct' as const, ...op })) },
);

describe('Ledger properties (fast-check against real Postgres 16)', () => {
  let harness: LedgerHarness;
  let owner: Client;
  const users = new Map<Currency, UserAccount[]>();
  const normalSideOf = new Map<string, NormalSide>();

  beforeAll(async () => {
    harness = await startLedgerHarness({ LEDGER_INTERNAL_BUCKETS: '4' });
    owner = await harness.db.ownerClient();
    for (let i = 0; i < USERS_PER_CURRENCY; i += 1) {
      const wallet = await harness.createWallet();
      for (const currency of CURRENCIES) {
        const account = await harness.openUserAccount(currency, wallet);
        users.set(currency, [...(users.get(currency) ?? []), account]);
      }
    }
    const { rows } = await owner.query(`SELECT id, normal_side FROM accounts`);
    for (const row of rows as { id: string; normal_side: NormalSide }[]) normalSideOf.set(row.id, row.normal_side);
    await owner.query(
      `INSERT INTO period_locks (period_start, period_end, locked_by, reason)
       VALUES ('2001-01-01', '2002-01-01', 'operator:auditor', 'FY2001 reported')`,
    );
  });

  afterAll(async () => {
    await owner?.end();
    await harness?.close();
  });

  const referenceFor = (currency: Currency, target: Target): AccountReference =>
    'user' in target ? { accountId: (users.get(currency) as UserAccount[])[target.user].accountId } : { systemAccount: target.system };

  /** Balanced by construction: debit i's amount goes to credit target (i mod k). */
  function entriesFor(shape: PostingShape): LedgerEntryDraft[] {
    const entries: LedgerEntryDraft[] = [];
    for (const group of shape.groups) {
      const creditTotals = new Array<bigint>(group.creditTargets.length).fill(0n);
      group.debits.forEach((leg, index) => {
        entries.push({
          account: referenceFor(group.currency, leg.target),
          direction: EntryDirection.DEBIT,
          amount: Money.of(leg.amountMinor, group.currency),
        });
        creditTotals[index % group.creditTargets.length] += leg.amountMinor;
      });
      group.creditTargets.forEach((target, index) => {
        if (creditTotals[index] === 0n) return;
        entries.push({
          account: referenceFor(group.currency, target),
          direction: EntryDirection.CREDIT,
          amount: Money.of(creditTotals[index], group.currency),
        });
      });
    }
    return entries;
  }

  const requestFor = (shape: PostingShape, overrides: Partial<PostingRequest['transaction']> = {}): PostingRequest => ({
    transaction: {
      type: TransactionType.WITHDRAWAL,
      authorization: shape.authorization,
      valueTime: new Date(),
      initiatedBy: shape.authorization === PostingAuthorization.USER_INITIATED ? 'user:property' : 'job:property',
      ...overrides,
    },
    entries: entriesFor(shape),
  });

  async function loadBalances(): Promise<Map<string, bigint>> {
    const { rows } = await owner.query(`SELECT id, balance_minor::text AS balance FROM accounts`);
    return new Map((rows as { id: string; balance: string }[]).map((row) => [row.id, BigInt(row.balance)]));
  }

  async function correctableTransactions(): Promise<string[]> {
    const { rows } = await owner.query(
      `SELECT id FROM transactions WHERE status = 'POSTED' AND corrected_by_transaction_id IS NULL ORDER BY booking_time, id`,
    );
    return rows.map((row: { id: string }) => row.id);
  }

  /** What the gate should say, computed independently from the model's pre-state. */
  function expectedGateOutcome(request: PostingRequest, model: Map<string, bigint>): ErrorCode | undefined {
    if (request.transaction.authorization !== PostingAuthorization.USER_INITIATED) return undefined;
    const netChange = new Map<string, bigint>();
    for (const entry of request.entries) {
      if (!('accountId' in entry.account)) continue; // system references are never user accounts
      const change = signedBalanceChange(NormalSide.CREDIT, entry.direction, entry.amount.amountMinor);
      netChange.set(entry.account.accountId, (netChange.get(entry.account.accountId) ?? 0n) + change);
    }
    for (const [accountId, change] of netChange) {
      if (change < 0n && (model.get(accountId) as bigint) + change < 0n) return ErrorCode.INSUFFICIENT_FUNDS;
    }
    return undefined;
  }

  function applyToModel(model: Map<string, bigint>, posted: PostedTransaction): void {
    for (const entry of posted.entries) {
      const side = normalSideOf.get(entry.accountId) as NormalSide;
      model.set(entry.accountId, (model.get(entry.accountId) as bigint) + signedBalanceChange(side, entry.direction, entry.amount.amountMinor));
    }
  }

  async function expectModelMatchesDatabase(model: Map<string, bigint>): Promise<void> {
    const actual = await loadBalances();
    const differences = [...model].filter(([id, balance]) => actual.get(id) !== balance);
    expect(differences).toEqual([]);
  }

  it('for any sequence of valid postings, every invariant holds after every single step', async () => {
    const stepCounts = { posted: 0, refusedByGate: 0, reversed: 0, corrected: 0, wentNegative: 0 };

    await fc.assert(
      fc.asyncProperty(fc.array(operationArbitrary, { minLength: 1, maxLength: 12 }), async (operations) => {
        const model = await loadBalances();
        for (const operation of operations) {
          const correctable = await correctableTransactions();

          if (operation.kind === 'reverse') {
            if (correctable.length === 0) continue;
            const originalId = correctable[operation.pick % correctable.length];
            const request = await harness.ledger.buildReversalRequest(originalId, {
              valueTime: new Date(),
              initiatedBy: 'operator:property',
              reasonCode: 'PROPERTY_REVERSAL',
            });
            const posted = await harness.ledger.post(request);
            applyToModel(model, posted);
            const [original] = (await owner.query(`SELECT status, corrected_by_transaction_id FROM transactions WHERE id = $1`, [originalId])).rows;
            expect(original).toEqual({ status: 'REVERSED', corrected_by_transaction_id: posted.transactionId });
            stepCounts.reversed += 1;
          } else {
            const correcting = operation.kind === 'correct' && correctable.length > 0;
            const request = correcting
              ? requestFor(
                  { ...operation.shape, authorization: PostingAuthorization.SYSTEM_DRIVEN },
                  {
                    type: TransactionType.CORRECTION,
                    correctsTransactionId: correctable[operation.pick % correctable.length],
                  },
                )
              : requestFor(operation.shape);
            const expectedRefusal = expectedGateOutcome(request, model);

            if (expectedRefusal) {
              const before = await harness.snapshot();
              await expect(harness.ledger.post(request)).rejects.toMatchObject({ code: expectedRefusal });
              expect(await harness.snapshot()).toEqual(before);
              stepCounts.refusedByGate += 1;
            } else {
              const posted = await harness.ledger.post(request);
              applyToModel(model, posted);
              if (correcting) {
                const [original] = (await owner.query(`SELECT status, corrected_by_transaction_id FROM transactions WHERE id = $1`, [
                  request.transaction.correctsTransactionId,
                ])).rows;
                expect(original).toEqual({ status: 'POSTED', corrected_by_transaction_id: posted.transactionId });
                stepCounts.corrected += 1;
              } else {
                stepCounts.posted += 1;
              }
            }
          }

          // After EVERY step: all §8.1 invariants, and the independent model.
          const report = await harness.expectCleanBooks();
          await expectModelMatchesDatabase(model);
          stepCounts.wentNegative = Math.max(stepCounts.wentNegative, report.overdrawnAccounts.length);
        }
      }),
      { numRuns: 30 },
    );

    // The generator must actually have exercised the interesting paths.
    expect(stepCounts.posted).toBeGreaterThan(20);
    expect(stepCounts.refusedByGate).toBeGreaterThan(0);
    expect(stepCounts.reversed).toBeGreaterThan(0);
    expect(stepCounts.corrected).toBeGreaterThan(0);
    expect(stepCounts.wentNegative).toBeGreaterThan(0);
  });

  type Corruption =
    | 'unbalanced-in-one-currency'
    | 'balanced-globally-not-per-currency'
    | 'entry-currency-differs-from-account'
    | 'zero-or-negative-amount'
    | 'fewer-than-two-entries'
    | 'unknown-account'
    | 'locked-period';

  const EXPECTED_CODE: Record<Corruption, ErrorCode> = {
    'unbalanced-in-one-currency': ErrorCode.LEDGER_UNBALANCED,
    'balanced-globally-not-per-currency': ErrorCode.LEDGER_UNBALANCED,
    'entry-currency-differs-from-account': ErrorCode.ACCOUNT_CURRENCY_MISMATCH,
    'zero-or-negative-amount': ErrorCode.INVALID_AMOUNT,
    'fewer-than-two-entries': ErrorCode.INVALID_POSTING,
    'unknown-account': ErrorCode.ACCOUNT_NOT_FOUND,
    'locked-period': ErrorCode.PERIOD_LOCKED,
  };

  function corrupt(request: PostingRequest, corruption: Corruption, delta: bigint, badAmount: bigint): PostingRequest {
    const [first, ...rest] = request.entries;
    const currency = first.amount.currency as Currency;
    switch (corruption) {
      case 'unbalanced-in-one-currency':
        return { ...request, entries: [{ ...first, amount: Money.of(first.amount.amountMinor + delta, currency) }, ...rest] };
      case 'balanced-globally-not-per-currency': {
        const other = CURRENCIES.find((code) => code !== currency) as Currency;
        return {
          ...request,
          entries: [
            { account: referenceFor(currency, { user: 0 }), direction: EntryDirection.DEBIT, amount: Money.of(delta, currency) },
            { account: { systemAccount: 'BANK' }, direction: EntryDirection.CREDIT, amount: Money.of(delta, other) },
          ],
        };
      }
      case 'entry-currency-differs-from-account': {
        const other = CURRENCIES.find((code) => code !== currency) as Currency;
        // Still balanced per currency, so only the account lookup can catch it.
        return {
          ...request,
          entries: [
            { account: referenceFor(currency, { user: 0 }), direction: EntryDirection.CREDIT, amount: Money.of(delta, other) },
            { account: { systemAccount: 'BANK' }, direction: EntryDirection.DEBIT, amount: Money.of(delta, other) },
          ],
        };
      }
      case 'zero-or-negative-amount':
        return { ...request, entries: [{ ...first, amount: Money.of(badAmount, currency) }, ...rest] };
      case 'fewer-than-two-entries':
        return { ...request, entries: [first] };
      case 'unknown-account':
        return { ...request, entries: [{ ...first, account: { accountId: randomUUID() } }, ...rest] };
      case 'locked-period':
        return { ...request, transaction: { ...request.transaction, valueTime: LOCKED_PERIOD_VALUE_TIME } };
    }
  }

  it('for any invalid draft, the posting is rejected with its stable code and NOTHING is written', async () => {
    const seen = new Set<Corruption>();
    await fc.assert(
      fc.asyncProperty(
        shapeArbitrary.map((shape) => ({ ...shape, authorization: PostingAuthorization.SYSTEM_DRIVEN })),
        fc.constantFrom(...(Object.keys(EXPECTED_CODE) as Corruption[])),
        fc.bigInt({ min: 1n, max: 1_000n }),
        fc.bigInt({ min: -1_000n, max: 0n }),
        async (shape, corruption, delta, badAmount) => {
          const request = corrupt(requestFor(shape), corruption, delta, badAmount);
          const before = await harness.snapshot();
          const error = await harness.ledger.post(request).then(
            () => undefined,
            (rejection: unknown) => rejection,
          );
          expect(error).toBeInstanceOf(DomainError);
          expect((error as DomainError).code).toBe(EXPECTED_CODE[corruption]);
          expect(await harness.snapshot()).toEqual(before);
          seen.add(corruption);
        },
      ),
      { numRuns: 120 },
    );
    expect([...seen].sort()).toEqual(Object.keys(EXPECTED_CODE).sort());
    await harness.expectCleanBooks();
  });
});
