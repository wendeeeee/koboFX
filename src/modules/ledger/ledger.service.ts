import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { InvariantViolationError, NotFoundError } from '../../common/errors';
import { Money } from '../../common/money';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { sqlState } from '../../database/database-errors';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import {
  AccountCurrencyMismatchError,
  AccountNotFoundError,
  AlreadyCorrectedError,
  FundsReservedError,
  InsufficientFundsError,
  InvalidPostingError,
  PeriodLockedError,
  ReversalMismatchError,
} from './ledger.errors';
import {
  EntryDirection,
  LedgerEntryDraft,
  NormalSide,
  PostedEntry,
  PostedTransaction,
  PostingAuthorization,
  PostingRequest,
  TransactionDraft,
  TransactionStatus,
  TransactionType,
} from './ledger.types';
import { AccountFunds, AuthorizationOutcome, authorizeReduction } from './posting/authorization';
import { bucketForTransaction, systemAccountCode } from './posting/bucket';
import { validatePostingRequest } from './posting/posting-validation';
import { oppositeDirection, signedBalanceChange } from './posting/sign';

interface ResolvedAccount {
  readonly id: string;
  readonly code: string;
  readonly currencyCode: string;
  readonly normalSide: NormalSide;
  readonly authorizesBalance: boolean;
}

interface ResolvedEntry {
  readonly index: number;
  readonly draft: LedgerEntryDraft;
  readonly account: ResolvedAccount;
}

interface AccountRow {
  id: string;
  code: string;
  currency_code: string;
  normal_side: NormalSide;
  authorizes_balance: boolean;
}

export interface ReversalOptions {
  /** When the reversal takes economic effect. The caller decides whether to backdate. */
  readonly valueTime: Date;
  readonly initiatedBy: string;
  readonly reasonCode: string;
}

/**
 * The posting engine: the ONLY write path to balances (design §14).
 *
 * `post()` runs in one database transaction (the ambient UnitOfWork, or its own):
 *
 *  1. Validate the request without touching the database (≥ 2 entries, positive
 *     amounts, debits = credits per currency, well-formed links).
 *  2. Reject a `valueTime` inside a locked period.
 *  3. Resolve every account (system accounts → the bucket chosen by the transaction
 *     id); each must exist and share its entry's currency.
 *  4. Lock, in this global order — so no two postings can wait on each other in a
 *     cycle:
 *       a. the original transaction, for a correction or reversal;
 *       b. balance-authorizing (user) accounts: `SELECT … ORDER BY id FOR UPDATE`;
 *       c. internal accounts, by blind `UPDATE … RETURNING`, also in id order.
 *  5. For a user-initiated posting, authorize every net reduction of a user account
 *     against `available = balance − reserved` plus the overdraft limit.
 *     System-driven postings skip the gate: they may drive an account negative, and
 *     the ledger records that faithfully.
 *  6. Insert the transaction (POSTED), then each entry with its `balance_after_minor`;
 *     the database hash-chains the entry. Advance `balance_entry_id` and `version`.
 *  7. For a correction, link the original to it; a reversal also marks it REVERSED.
 *
 * Every check that can fail runs before the first write. Any failure rolls the whole
 * unit back and surfaces with a stable error code.
 */
@Injectable()
export class LedgerService {
  private readonly bucketCount: number;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.bucketCount = config.ledger.internalAccountBuckets;
  }

  async post(request: PostingRequest): Promise<PostedTransaction> {
    validatePostingRequest(request);
    const draft = request.transaction;

    return this.unitOfWork.run(async (manager) => {
      const transactionId = randomUUID();
      await this.assertPeriodOpen(manager, draft.valueTime);
      const entries = await this.resolveEntries(manager, request.entries, transactionId);

      if (draft.correctsTransactionId !== undefined) {
        await this.lockCorrectableOriginal(manager, draft, entries);
      }

      const lockedFunds = await this.lockBalanceAuthorizingAccounts(manager, entries);
      if (draft.authorization === PostingAuthorization.USER_INITIATED) {
        this.authorize(entries, lockedFunds);
      }

      const { reference, bookingTime } = await this.insertTransaction(manager, transactionId, draft);
      const postedEntries = await this.applyEntries(manager, transactionId, draft.valueTime, entries);

      if (draft.correctsTransactionId !== undefined) {
        await this.linkOriginal(manager, draft.correctsTransactionId, transactionId, draft.type);
      }

      return {
        transactionId,
        reference,
        type: draft.type,
        status: TransactionStatus.POSTED,
        valueTime: draft.valueTime,
        bookingTime,
        entries: postedEntries,
      };
    });
  }

  /**
   * The exact mirror of a posted transaction, ready for `post()`: same accounts
   * (same buckets), same amounts, opposite directions. Read-only — the write still
   * goes through the one write path.
   */
  async buildReversalRequest(originalTransactionId: string, options: ReversalOptions): Promise<PostingRequest> {
    const manager = this.unitOfWork.manager;
    const [original] = (await manager.query(
      `SELECT id, user_id FROM transactions WHERE id = $1`,
      [originalTransactionId],
    )) as { id: string; user_id: string | null }[];
    if (!original) {
      throw new NotFoundError('Transaction to reverse not found.', { transactionId: originalTransactionId });
    }
    const entries = (await manager.query(
      `SELECT account_id, currency_code, direction, amount_minor::text AS amount_minor
         FROM ledger_entries WHERE transaction_id = $1 ORDER BY id`,
      [originalTransactionId],
    )) as { account_id: string; currency_code: string; direction: EntryDirection; amount_minor: string }[];

    return {
      transaction: {
        type: TransactionType.REVERSAL,
        authorization: PostingAuthorization.SYSTEM_DRIVEN,
        valueTime: options.valueTime,
        initiatedBy: options.initiatedBy,
        reasonCode: options.reasonCode,
        correctsTransactionId: original.id,
        ...(original.user_id ? { userId: original.user_id } : {}),
      },
      entries: entries.map((entry) => ({
        account: { accountId: entry.account_id },
        direction: oppositeDirection(entry.direction),
        amount: Money.fromMinorString(entry.amount_minor, entry.currency_code),
      })),
    };
  }

  private async assertPeriodOpen(manager: EntityManager, valueTime: Date): Promise<void> {
    const [lock] = (await manager.query(
      `SELECT id::text AS id, period_start, period_end
         FROM period_locks
        WHERE period_start <= $1 AND $1 < period_end
        ORDER BY period_start
        LIMIT 1`,
      [valueTime],
    )) as { id: string; period_start: Date; period_end: Date }[];
    if (lock) {
      throw new PeriodLockedError('valueTime falls inside a locked reporting period.', {
        valueTime: valueTime.toISOString(),
        periodLockId: lock.id,
        periodStart: lock.period_start.toISOString(),
        periodEnd: lock.period_end.toISOString(),
      });
    }
  }

  private async resolveEntries(
    manager: EntityManager,
    drafts: readonly LedgerEntryDraft[],
    transactionId: string,
  ): Promise<ResolvedEntry[]> {
    const accountIds = new Set<string>();
    const systemCodes = new Set<string>();
    for (const draft of drafts) {
      if ('accountId' in draft.account) accountIds.add(draft.account.accountId.toLowerCase());
      else systemCodes.add(systemAccountCode(draft.account.systemAccount, draft.amount.currency));
    }

    const columns = `id, code, currency_code, normal_side, authorizes_balance`;
    const byId = new Map<string, ResolvedAccount>();
    const byCode = new Map<string, ResolvedAccount>();
    if (accountIds.size > 0) {
      const rows = (await manager.query(`SELECT ${columns} FROM accounts WHERE id = ANY($1::uuid[])`, [
        [...accountIds],
      ])) as AccountRow[];
      for (const row of rows) byId.set(row.id, toResolvedAccount(row));
    }
    if (systemCodes.size > 0) {
      const bucket = bucketForTransaction(transactionId, this.bucketCount);
      const rows = (await manager.query(
        `SELECT ${columns} FROM accounts
          WHERE code = ANY($1::text[]) AND bucket = $2 AND wallet_id IS NULL AND NOT authorizes_balance`,
        [[...systemCodes], bucket],
      )) as AccountRow[];
      for (const row of rows) byCode.set(row.code, toResolvedAccount(row));
    }

    return drafts.map((draft, index) => {
      const account =
        'accountId' in draft.account
          ? byId.get(draft.account.accountId.toLowerCase())
          : byCode.get(systemAccountCode(draft.account.systemAccount, draft.amount.currency));
      if (!account) {
        throw new AccountNotFoundError(`Entry ${index} references an account that does not exist.`, {
          entryIndex: index,
          account: 'accountId' in draft.account ? draft.account.accountId : draft.account.systemAccount,
          currency: draft.amount.currency,
        });
      }
      if (account.currencyCode !== draft.amount.currency) {
        throw new AccountCurrencyMismatchError(
          `Entry ${index} is in ${draft.amount.currency} but account ${account.code} holds ${account.currencyCode}.`,
          { entryIndex: index, accountId: account.id, entryCurrency: draft.amount.currency, accountCurrency: account.currencyCode },
        );
      }
      return { index, draft, account };
    });
  }

  private async lockCorrectableOriginal(
    manager: EntityManager,
    draft: TransactionDraft,
    entries: readonly ResolvedEntry[],
  ): Promise<void> {
    const originalId = draft.correctsTransactionId as string;
    const [original] = (await manager.query(
      `SELECT id, status, corrected_by_transaction_id FROM transactions WHERE id = $1 FOR UPDATE`,
      [originalId],
    )) as { id: string; status: TransactionStatus; corrected_by_transaction_id: string | null }[];
    if (!original) {
      throw new NotFoundError('The transaction being corrected does not exist.', { transactionId: originalId });
    }
    if (original.corrected_by_transaction_id !== null) {
      throw new AlreadyCorrectedError('This transaction is already corrected; correct the correction instead.', {
        transactionId: originalId,
        correctedByTransactionId: original.corrected_by_transaction_id,
      });
    }
    if (original.status !== TransactionStatus.POSTED) {
      throw new InvalidPostingError('Only a POSTED transaction can be corrected.', {
        transactionId: originalId,
        status: original.status,
      });
    }
    if (draft.type === TransactionType.REVERSAL) {
      await this.assertMirrorsOriginal(manager, originalId, entries);
    }
  }

  /** A full reversal negates the original exactly: same accounts, same amounts, opposite directions. */
  private async assertMirrorsOriginal(
    manager: EntityManager,
    originalId: string,
    entries: readonly ResolvedEntry[],
  ): Promise<void> {
    const originalEntries = (await manager.query(
      `SELECT account_id, direction, amount_minor::text AS amount_minor FROM ledger_entries WHERE transaction_id = $1`,
      [originalId],
    )) as { account_id: string; direction: EntryDirection; amount_minor: string }[];
    const expected = originalEntries.map((e) => `${e.account_id}|${e.direction}|${e.amount_minor}`).sort();
    const actual = entries
      .map((e) => `${e.account.id}|${oppositeDirection(e.draft.direction)}|${e.draft.amount.toMinorString()}`)
      .sort();
    if (expected.length !== actual.length || expected.some((key, i) => key !== actual[i])) {
      throw new ReversalMismatchError(
        'A reversal must mirror every entry of the original: same accounts and amounts, opposite directions.',
        { transactionId: originalId },
      );
    }
  }

  private async lockBalanceAuthorizingAccounts(
    manager: EntityManager,
    entries: readonly ResolvedEntry[],
  ): Promise<Map<string, AccountFunds>> {
    const ids = [...new Set(entries.filter((e) => e.account.authorizesBalance).map((e) => e.account.id))];
    const funds = new Map<string, AccountFunds>();
    if (ids.length === 0) return funds;
    const rows = (await manager.query(
      `SELECT id,
              balance_minor::text         AS balance_minor,
              reserved_minor::text        AS reserved_minor,
              overdraft_limit_minor::text AS overdraft_limit_minor
         FROM accounts
        WHERE id = ANY($1::uuid[])
        ORDER BY id
          FOR UPDATE`,
      [ids],
    )) as { id: string; balance_minor: string; reserved_minor: string; overdraft_limit_minor: string }[];
    for (const row of rows) {
      funds.set(row.id, {
        balanceMinor: BigInt(row.balance_minor),
        reservedMinor: BigInt(row.reserved_minor),
        overdraftLimitMinor: BigInt(row.overdraft_limit_minor),
      });
    }
    return funds;
  }

  /**
   * The runtime `balance >= 0` invariant (design §6.2). Applied to each user
   * account's NET change in this posting, so a posting that debits and credits the
   * same account is judged on what it actually does to the balance.
   */
  private authorize(entries: readonly ResolvedEntry[], lockedFunds: Map<string, AccountFunds>): void {
    const netChange = new Map<string, bigint>();
    for (const { account, draft } of entries) {
      if (!account.authorizesBalance) continue;
      const change = signedBalanceChange(account.normalSide, draft.direction, draft.amount.amountMinor);
      netChange.set(account.id, (netChange.get(account.id) ?? 0n) + change);
    }
    for (const [accountId, change] of netChange) {
      if (change >= 0n) continue;
      const funds = lockedFunds.get(accountId);
      if (!funds) {
        throw new InvariantViolationError('A balance-authorizing account was not locked before authorization.', {
          accountId,
        });
      }
      const outcome = authorizeReduction(funds, -change);
      if (outcome === AuthorizationOutcome.AUTHORIZED) continue;
      const details = {
        accountId,
        requestedMinor: (-change).toString(),
        balanceMinor: funds.balanceMinor.toString(),
        reservedMinor: funds.reservedMinor.toString(),
        availableMinor: (funds.balanceMinor - funds.reservedMinor).toString(),
        overdraftLimitMinor: funds.overdraftLimitMinor.toString(),
      };
      if (outcome === AuthorizationOutcome.FUNDS_RESERVED) {
        throw new FundsReservedError('Part of the balance is reserved by another operation.', details);
      }
      throw new InsufficientFundsError('The balance cannot cover this debit.', details);
    }
  }

  private async insertTransaction(
    manager: EntityManager,
    transactionId: string,
    draft: TransactionDraft,
  ): Promise<{ reference: string; bookingTime: Date }> {
    const reference = draft.reference ?? transactionId;
    try {
      const [row] = (await manager.query(
        `INSERT INTO transactions
           (id, reference, user_id, type, status, value_time, settlement_time, initiated_by,
            reason_code, corrects_transaction_id, idempotency_key, external_reference, metadata)
         VALUES ($1, $2, $3, $4, 'POSTED', $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING booking_time`,
        [
          transactionId,
          reference,
          draft.userId ?? null,
          draft.type,
          draft.valueTime,
          draft.settlementTime ?? null,
          draft.initiatedBy,
          draft.reasonCode ?? null,
          draft.correctsTransactionId ?? null,
          draft.idempotencyKey ?? null,
          draft.externalReference ?? null,
          JSON.stringify(draft.metadata ?? {}),
        ],
      )) as { booking_time: Date }[];
      return { reference, bookingTime: row.booking_time };
    } catch (error) {
      if (sqlState(error) === '23505') {
        throw new InvalidPostingError('Transaction reference is already in use.', { reference }, { cause: error });
      }
      if (sqlState(error) === '23503') {
        throw new InvalidPostingError('Transaction references a user that does not exist.', {
          userId: draft.userId ?? null,
        }, { cause: error });
      }
      throw error;
    }
  }

  /**
   * Apply entries account by account: user accounts (already locked) first, then
   * internal accounts — each group in id order, so internal-row locks are always
   * taken in the same global order.
   */
  private async applyEntries(
    manager: EntityManager,
    transactionId: string,
    valueTime: Date,
    entries: readonly ResolvedEntry[],
  ): Promise<PostedEntry[]> {
    const byAccount = new Map<string, ResolvedEntry[]>();
    for (const entry of entries) {
      const group = byAccount.get(entry.account.id) ?? [];
      group.push(entry);
      byAccount.set(entry.account.id, group);
    }
    const accountOrder = [...byAccount.keys()].sort((left, right) => {
      const leftAccount = (byAccount.get(left) as ResolvedEntry[])[0].account;
      const rightAccount = (byAccount.get(right) as ResolvedEntry[])[0].account;
      if (leftAccount.authorizesBalance !== rightAccount.authorizesBalance) {
        return leftAccount.authorizesBalance ? -1 : 1;
      }
      return left < right ? -1 : left > right ? 1 : 0;
    });

    const posted: PostedEntry[] = new Array<PostedEntry>(entries.length);
    for (const accountId of accountOrder) {
      let lastEntryId: bigint | undefined;
      for (const entry of byAccount.get(accountId) as ResolvedEntry[]) {
        const change = signedBalanceChange(
          entry.account.normalSide,
          entry.draft.direction,
          entry.draft.amount.amountMinor,
        );
        const [balance] = (await manager.query(
          `WITH updated AS (
             UPDATE accounts SET balance_minor = balance_minor + $2 WHERE id = $1 RETURNING balance_minor
           )
           SELECT balance_minor::text AS balance_minor FROM updated`,
          [accountId, change.toString()],
        )) as { balance_minor: string }[];
        const balanceAfterMinor = BigInt(balance.balance_minor);

        const [inserted] = (await manager.query(
          `INSERT INTO ledger_entries
             (transaction_id, account_id, currency_code, direction, amount_minor, balance_after_minor, value_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id::text AS id`,
          [
            transactionId,
            accountId,
            entry.draft.amount.currency,
            entry.draft.direction,
            entry.draft.amount.toMinorString(),
            balanceAfterMinor.toString(),
            valueTime,
          ],
        )) as { id: string }[];
        lastEntryId = BigInt(inserted.id);

        posted[entry.index] = {
          entryId: lastEntryId,
          accountId,
          direction: entry.draft.direction,
          amount: entry.draft.amount,
          balanceAfterMinor,
        };
      }
      await manager.query(
        `UPDATE accounts SET balance_entry_id = $2, version = version + 1 WHERE id = $1`,
        [accountId, (lastEntryId as bigint).toString()],
      );
    }
    return posted;
  }

  private async linkOriginal(
    manager: EntityManager,
    originalId: string,
    correctionId: string,
    type: TransactionType,
  ): Promise<void> {
    const rows = (await manager.query(
      `WITH updated AS (
         UPDATE transactions
            SET corrected_by_transaction_id = $2,
                status = CASE WHEN $3 THEN 'REVERSED'::transaction_status ELSE status END
          WHERE id = $1
         RETURNING id
       )
       SELECT id FROM updated`,
      [originalId, correctionId, type === TransactionType.REVERSAL],
    )) as { id: string }[];
    if (rows.length !== 1) {
      throw new InvariantViolationError('The corrected transaction vanished while locked.', { transactionId: originalId });
    }
  }
}

function toResolvedAccount(row: AccountRow): ResolvedAccount {
  return {
    id: row.id,
    code: row.code,
    currencyCode: row.currency_code,
    normalSide: row.normal_side,
    authorizesBalance: row.authorizes_balance,
  };
}
