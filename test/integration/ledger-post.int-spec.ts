import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { ErrorCode } from '../../src/common/errors';
import { Money } from '../../src/common/money';
import {
  EntryDirection,
  LedgerEntryDraft,
  PostingAuthorization,
  PostingRequest,
  TransactionDraft,
  TransactionStatus,
  TransactionType,
} from '../../src/modules/ledger/ledger.types';
import { LedgerHarness, UserAccount, startLedgerHarness } from '../support/ledger-harness';

const debit = (account: LedgerEntryDraft['account'], amountMinor: bigint, currency: string): LedgerEntryDraft => ({
  account,
  direction: EntryDirection.DEBIT,
  amount: Money.of(amountMinor, currency),
});
const credit = (account: LedgerEntryDraft['account'], amountMinor: bigint, currency: string): LedgerEntryDraft => ({
  account,
  direction: EntryDirection.CREDIT,
  amount: Money.of(amountMinor, currency),
});

const userDraft = (account: UserAccount, overrides: Partial<TransactionDraft> = {}): TransactionDraft => ({
  type: TransactionType.WITHDRAWAL,
  authorization: PostingAuthorization.USER_INITIATED,
  valueTime: new Date(),
  initiatedBy: `user:${account.userId}`,
  userId: account.userId,
  ...overrides,
});

/** A user-initiated withdrawal: DEBIT the user (we owe less), CREDIT BANK (asset down). */
const withdrawal = (account: UserAccount, amountMinor: bigint, overrides: Partial<TransactionDraft> = {}): PostingRequest => ({
  transaction: userDraft(account, overrides),
  entries: [
    debit({ accountId: account.accountId }, amountMinor, account.currency),
    credit({ systemAccount: 'BANK' }, amountMinor, account.currency),
  ],
});

describe('LedgerService.post() (real Postgres 16)', () => {
  let harness: LedgerHarness;
  let owner: Client;

  beforeAll(async () => {
    harness = await startLedgerHarness({ LEDGER_INTERNAL_BUCKETS: '4' });
    owner = await harness.db.ownerClient();
  });

  afterAll(async () => {
    await owner?.end();
    await harness?.close();
  });

  /** Assert the posting is rejected with `code` and that NOTHING was written. */
  async function expectRejectedWithoutTrace(request: PostingRequest, code: ErrorCode): Promise<void> {
    const before = await harness.snapshot();
    await expect(harness.ledger.post(request)).rejects.toMatchObject({ code });
    expect(await harness.snapshot()).toEqual(before);
  }

  it('funding: debits BANK, credits the user, and records the full audit trail', async () => {
    const account = await harness.openUserAccount('NGN');
    const valueTime = new Date('2026-09-25T09:30:00.123Z');
    const posted = await harness.ledger.post({
      transaction: {
        type: TransactionType.FUNDING,
        authorization: PostingAuthorization.SYSTEM_DRIVEN,
        valueTime,
        settlementTime: new Date('2026-09-27T00:00:00Z'),
        initiatedBy: 'job:funding-flow',
        userId: account.userId,
        reference: 'FUND-0001',
        reasonCode: 'CARD_TOP_UP',
        externalReference: 'psp_ch_123',
        idempotencyKey: 'key-1',
        metadata: { channel: 'card' },
      },
      entries: [debit({ systemAccount: 'BANK' }, 250_000n, 'NGN'), credit({ accountId: account.accountId }, 250_000n, 'NGN')],
    });

    expect(posted).toMatchObject({ reference: 'FUND-0001', type: TransactionType.FUNDING, status: TransactionStatus.POSTED, valueTime });
    expect(posted.entries.map((entry) => entry.balanceAfterMinor)).toEqual([250_000n, 250_000n]);
    expect(await harness.balanceOf(account.accountId)).toBe(250_000n);

    const { rows } = await owner.query(`SELECT * FROM transactions WHERE id = $1`, [posted.transactionId]);
    expect(rows[0]).toMatchObject({
      reference: 'FUND-0001',
      status: 'POSTED',
      user_id: account.userId,
      initiated_by: 'job:funding-flow',
      reason_code: 'CARD_TOP_UP',
      external_reference: 'psp_ch_123',
      idempotency_key: 'key-1',
      metadata: { channel: 'card' },
      corrects_transaction_id: null,
      corrected_by_transaction_id: null,
      quote_id: null,
    });
    expect(rows[0].value_time.toISOString()).toBe(valueTime.toISOString());
    // Booking time is the database's now(), never the caller's; the entries share it.
    expect(Math.abs(rows[0].booking_time.getTime() - Date.now())).toBeLessThan(60_000);
    const entries = (await owner.query(`SELECT booking_time, value_time FROM ledger_entries WHERE transaction_id = $1`, [posted.transactionId])).rows;
    for (const entry of entries) {
      expect(entry.booking_time).toEqual(rows[0].booking_time);
      expect(entry.value_time.toISOString()).toBe(valueTime.toISOString());
    }

    const [accountRow] = (await owner.query(`SELECT version, balance_entry_id::text FROM accounts WHERE id = $1`, [account.accountId])).rows;
    expect(accountRow).toEqual({ version: 1, balance_entry_id: posted.entries[1].entryId.toString() });
    await harness.expectCleanBooks();
  });

  it('the design §5.6 conversion: five legs, balanced per currency, spread booked as revenue', async () => {
    const wallet = await harness.createWallet();
    const naira = await harness.openUserAccount('NGN', wallet);
    const dollars = await harness.openUserAccount('USD', wallet);
    await harness.fund(naira, 100_000_000n);

    const posted = await harness.ledger.post({
      transaction: userDraft(naira, {
        type: TransactionType.CONVERSION,
        conversion: await harness.conversionProvenance({
          sourceCurrency: 'NGN',
          sourceAmountMinor: 100_000_000n,
          targetCurrency: 'USD',
          targetAmountMinor: 65_011n,
        }),
      }),
      entries: [
        debit({ accountId: naira.accountId }, 100_000_000n, 'NGN'),
        credit({ systemAccount: 'FX_POSITION' }, 100_000_000n, 'NGN'),
        debit({ systemAccount: 'FX_POSITION' }, 65_338n, 'USD'),
        credit({ accountId: dollars.accountId }, 65_011n, 'USD'),
        credit({ systemAccount: 'REVENUE:FX_SPREAD' }, 327n, 'USD'),
      ],
    });

    expect(await harness.balanceOf(naira.accountId)).toBe(0n);
    expect(await harness.balanceOf(dollars.accountId)).toBe(65_011n);
    // FX_POSITION is CREDIT-normal: it holds +NGN and −USD — our open position.
    expect(posted.entries[1].balanceAfterMinor).toBeGreaterThanOrEqual(100_000_000n);
    const revenue = await harness.chartOfAccounts.findSystemAccountBuckets('REVENUE:FX_SPREAD', 'USD');
    expect(revenue.reduce((sum, bucket) => sum + bucket.balanceMinor, 0n)).toBe(327n);

    const report = await harness.expectCleanBooks();
    expect(report.overdrawnAccounts).toEqual([]);
  });

  describe('the authorization gate (design §6.2)', () => {
    it('refuses a user-initiated debit beyond the balance with INSUFFICIENT_FUNDS, writing nothing', async () => {
      const account = await harness.openUserAccount('NGN');
      await harness.fund(account, 100_000n);
      await expectRejectedWithoutTrace(withdrawal(account, 100_001n), ErrorCode.INSUFFICIENT_FUNDS);
      await harness.ledger.post(withdrawal(account, 100_000n));
      expect(await harness.balanceOf(account.accountId)).toBe(0n);
    });

    it('checks against available = balance − reserved, raising FUNDS_RESERVED when only the reservation is in the way', async () => {
      const account = await harness.openUserAccount('NGN');
      await harness.fund(account, 100_000n);
      await owner.query(`UPDATE accounts SET reserved_minor = 30000 WHERE id = $1`, [account.accountId]);
      try {
        await expectRejectedWithoutTrace(withdrawal(account, 70_001n), ErrorCode.FUNDS_RESERVED);
        await expectRejectedWithoutTrace(withdrawal(account, 100_001n), ErrorCode.INSUFFICIENT_FUNDS);
        await harness.ledger.post(withdrawal(account, 70_000n));
        expect(await harness.balanceOf(account.accountId)).toBe(30_000n);
      } finally {
        await owner.query(`UPDATE accounts SET reserved_minor = 0 WHERE id = $1`, [account.accountId]);
      }
    });

    it('honours overdraft_limit_minor: may go negative down to −limit, not one unit further', async () => {
      const account = await harness.openUserAccount('USD');
      await harness.fund(account, 1_000n);
      await owner.query(`UPDATE accounts SET overdraft_limit_minor = 500 WHERE id = $1`, [account.accountId]);
      await expectRejectedWithoutTrace(withdrawal(account, 1_501n), ErrorCode.INSUFFICIENT_FUNDS);
      await harness.ledger.post(withdrawal(account, 1_500n));
      expect(await harness.balanceOf(account.accountId)).toBe(-500n);
      // Within policy: not reported as overdrawn.
      expect((await harness.checks.findOverdrawnAccounts()).map((a) => a.accountId)).not.toContain(account.accountId);
    });

    it('judges the NET effect when one posting both debits and credits the same user account', async () => {
      const account = await harness.openUserAccount('NGN');
      await harness.fund(account, 100n);
      await harness.ledger.post({
        transaction: userDraft(account),
        entries: [
          debit({ accountId: account.accountId }, 150n, 'NGN'),
          credit({ accountId: account.accountId }, 100n, 'NGN'),
          credit({ systemAccount: 'BANK' }, 50n, 'NGN'),
        ],
      });
      expect(await harness.balanceOf(account.accountId)).toBe(50n);
      await harness.expectCleanBooks();
    });

    it('a SYSTEM_DRIVEN posting may drive a user negative; it is recorded faithfully and reported', async () => {
      const account = await harness.openUserAccount('NGN');
      await harness.fund(account, 10_000n);
      await harness.ledger.post({
        transaction: {
          type: TransactionType.WITHDRAWAL,
          authorization: PostingAuthorization.SYSTEM_DRIVEN,
          valueTime: new Date(),
          initiatedBy: 'job:settlement',
          reasonCode: 'SETTLEMENT_EXCEEDED_RESERVATION',
        },
        entries: [debit({ accountId: account.accountId }, 12_500n, 'NGN'), credit({ systemAccount: 'BANK' }, 12_500n, 'NGN')],
      });
      expect(await harness.balanceOf(account.accountId)).toBe(-2_500n);
      const overdrawn = await harness.checks.findOverdrawnAccounts();
      expect(overdrawn).toContainEqual(
        expect.objectContaining({ accountId: account.accountId, balanceMinor: -2_500n, overdraftLimitMinor: 0n }),
      );
      const report = await harness.expectCleanBooks();
      expect(report.isClean).toBe(true);
    });
  });

  describe('corrections and reversals (linked both ways; the original is never touched)', () => {
    it('a full reversal mirrors the original, links both directions and marks the original REVERSED', async () => {
      const account = await harness.openUserAccount('NGN');
      const original = await harness.fund(account, 40_000n);
      const originalEntries = (await owner.query(`SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY id`, [original.transactionId])).rows;

      const reversalRequest = await harness.ledger.buildReversalRequest(original.transactionId, {
        valueTime: new Date(),
        initiatedBy: 'operator:ops-1',
        reasonCode: 'CHARGEBACK',
      });
      const reversal = await harness.ledger.post(reversalRequest);

      expect(await harness.balanceOf(account.accountId)).toBe(0n);
      const { rows } = await owner.query(
        `SELECT id, status, corrects_transaction_id, corrected_by_transaction_id, type FROM transactions WHERE id = ANY($1::uuid[])`,
        [[original.transactionId, reversal.transactionId]],
      );
      const byId = new Map(rows.map((row: { id: string }) => [row.id, row]));
      expect(byId.get(original.transactionId)).toMatchObject({ status: 'REVERSED', corrected_by_transaction_id: reversal.transactionId });
      expect(byId.get(reversal.transactionId)).toMatchObject({
        status: 'POSTED',
        type: 'REVERSAL',
        corrects_transaction_id: original.transactionId,
      });
      // The original's entries are byte-for-byte unchanged.
      expect((await owner.query(`SELECT * FROM ledger_entries WHERE transaction_id = $1 ORDER BY id`, [original.transactionId])).rows).toEqual(
        originalEntries,
      );
      await harness.expectCleanBooks();

      // Once corrected, never again: correct the correction instead.
      await expectRejectedWithoutTrace(
        { ...reversalRequest, transaction: { ...reversalRequest.transaction } },
        ErrorCode.ALREADY_CORRECTED,
      );
    });

    it('a reversal whose entries do not mirror the original is REVERSAL_MISMATCH', async () => {
      const account = await harness.openUserAccount('NGN');
      const original = await harness.fund(account, 40_000n);
      const request = await harness.ledger.buildReversalRequest(original.transactionId, {
        valueTime: new Date(),
        initiatedBy: 'operator:ops-1',
        reasonCode: 'CHARGEBACK',
      });
      const partial: PostingRequest = {
        transaction: request.transaction,
        entries: request.entries.map((entry) => ({ ...entry, amount: Money.of(10_000n, 'NGN') })),
      };
      await expectRejectedWithoutTrace(partial, ErrorCode.REVERSAL_MISMATCH);
    });

    it('a CORRECTION books the difference, links both ways and leaves the original POSTED', async () => {
      const account = await harness.openUserAccount('USD');
      const original = await harness.fund(account, 10_000n); // should have been 9,000
      const correction = await harness.ledger.post({
        transaction: {
          type: TransactionType.CORRECTION,
          authorization: PostingAuthorization.SYSTEM_DRIVEN,
          valueTime: original.valueTime,
          initiatedBy: 'operator:ops-2',
          reasonCode: 'WRONG_AMOUNT',
          correctsTransactionId: original.transactionId,
        },
        entries: [debit({ accountId: account.accountId }, 1_000n, 'USD'), credit({ systemAccount: 'BANK' }, 1_000n, 'USD')],
      });
      expect(await harness.balanceOf(account.accountId)).toBe(9_000n);
      const [row] = (await owner.query(`SELECT status, corrected_by_transaction_id FROM transactions WHERE id = $1`, [original.transactionId])).rows;
      expect(row).toEqual({ status: 'POSTED', corrected_by_transaction_id: correction.transactionId });
      await harness.expectCleanBooks();
    });

    it('correcting a transaction that does not exist is NOT_FOUND', async () => {
      const account = await harness.openUserAccount('NGN');
      await expectRejectedWithoutTrace(
        {
          transaction: {
            type: TransactionType.CORRECTION,
            authorization: PostingAuthorization.SYSTEM_DRIVEN,
            valueTime: new Date(),
            initiatedBy: 'operator:ops-2',
            correctsTransactionId: randomUUID(),
          },
          entries: [debit({ systemAccount: 'BANK' }, 1n, 'NGN'), credit({ accountId: account.accountId }, 1n, 'NGN')],
        },
        ErrorCode.NOT_FOUND,
      );
      await expect(
        harness.ledger.buildReversalRequest(randomUUID(), { valueTime: new Date(), initiatedBy: 'operator:x', reasonCode: 'x' }),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('a reversal of a reversal is allowed: it corrects the correction', async () => {
      const account = await harness.openUserAccount('GBP');
      const original = await harness.fund(account, 700n);
      const options = { valueTime: new Date(), initiatedBy: 'operator:ops-3', reasonCode: 'MISTAKEN_REVERSAL' };
      const reversal = await harness.ledger.post(await harness.ledger.buildReversalRequest(original.transactionId, options));
      await harness.ledger.post(await harness.ledger.buildReversalRequest(reversal.transactionId, options));
      expect(await harness.balanceOf(account.accountId)).toBe(700n);
      await harness.expectCleanBooks();
    });
  });

  describe('rejections write nothing', () => {
    let account: UserAccount;

    beforeAll(async () => {
      account = await harness.openUserAccount('NGN');
      await harness.fund(account, 1_000_000n);
    });

    it('an unknown account id is ACCOUNT_NOT_FOUND', async () => {
      await expectRejectedWithoutTrace(
        {
          transaction: userDraft(account),
          entries: [debit({ accountId: account.accountId }, 100n, 'NGN'), credit({ accountId: randomUUID() }, 100n, 'NGN')],
        },
        ErrorCode.ACCOUNT_NOT_FOUND,
      );
    });

    it('an unknown system account is ACCOUNT_NOT_FOUND', async () => {
      await expectRejectedWithoutTrace(
        {
          transaction: userDraft(account),
          entries: [debit({ accountId: account.accountId }, 100n, 'NGN'), credit({ systemAccount: 'NO_SUCH_ACCOUNT' }, 100n, 'NGN')],
        },
        ErrorCode.ACCOUNT_NOT_FOUND,
      );
    });

    it('an entry currency that differs from its account’s is ACCOUNT_CURRENCY_MISMATCH', async () => {
      await expectRejectedWithoutTrace(
        {
          transaction: userDraft(account),
          entries: [debit({ accountId: account.accountId }, 100n, 'USD'), credit({ systemAccount: 'BANK' }, 100n, 'USD')],
        },
        ErrorCode.ACCOUNT_CURRENCY_MISMATCH,
      );
    });

    it('an unbalanced posting is LEDGER_UNBALANCED', async () => {
      await expectRejectedWithoutTrace(
        {
          transaction: userDraft(account),
          entries: [debit({ accountId: account.accountId }, 100n, 'NGN'), credit({ systemAccount: 'BANK' }, 99n, 'NGN')],
        },
        ErrorCode.LEDGER_UNBALANCED,
      );
    });

    it('a reused reference or an unknown user is INVALID_POSTING', async () => {
      await harness.ledger.post(withdrawal(account, 1n, { reference: 'UNIQUE-REF' }));
      await expectRejectedWithoutTrace(withdrawal(account, 1n, { reference: 'UNIQUE-REF' }), ErrorCode.INVALID_POSTING);
      await expectRejectedWithoutTrace(withdrawal(account, 1n, { userId: randomUUID() }), ErrorCode.INVALID_POSTING);
    });

    it('a value_time inside a locked period is PERIOD_LOCKED; the period end is exclusive', async () => {
      await owner.query(
        `INSERT INTO period_locks (period_start, period_end, locked_by, reason)
         VALUES ('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 'operator:finance', 'August 2026 reported')`,
      );
      for (const inside of ['2026-08-01T00:00:00Z', '2026-08-15T12:00:00Z', '2026-08-31T23:59:59.999Z']) {
        await expectRejectedWithoutTrace(withdrawal(account, 100n, { valueTime: new Date(inside) }), ErrorCode.PERIOD_LOCKED);
      }
      await harness.ledger.post(withdrawal(account, 100n, { valueTime: new Date('2026-09-01T00:00:00Z') }));
      await harness.ledger.post(withdrawal(account, 100n, { valueTime: new Date('2026-07-31T23:59:59.999Z') }));
      await harness.expectCleanBooks();
    });
  });

  describe('the transaction boundary', () => {
    it('joins an ambient UnitOfWork: a failure later in the unit rolls the posting back', async () => {
      const account = await harness.openUserAccount('EUR');
      const before = await harness.snapshot();
      await expect(
        harness.unitOfWork.run(async () => {
          await harness.fund(account, 5_000n);
          throw new Error('the surrounding command failed');
        }),
      ).rejects.toThrow('the surrounding command failed');
      expect(await harness.snapshot()).toEqual(before);
    });

    it('two postings in one unit commit together', async () => {
      const account = await harness.openUserAccount('EUR');
      await harness.unitOfWork.run(async () => {
        await harness.fund(account, 5_000n);
        await harness.ledger.post(withdrawal(account, 2_000n));
      });
      expect(await harness.balanceOf(account.accountId)).toBe(3_000n);
      await harness.expectCleanBooks();
    });
  });
});
