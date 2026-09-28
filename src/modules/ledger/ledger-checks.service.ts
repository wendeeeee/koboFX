import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { AccountType, NormalSide } from './ledger.types';
import { balanceTowardsTypeTotal } from './posting/sign';

export interface TrialBalanceLine {
  readonly currency: string;
  readonly debitTotalMinor: bigint;
  readonly creditTotalMinor: bigint;
  readonly balanced: boolean;
}

export interface AccountingEquationLine {
  readonly currency: string;
  readonly assetsMinor: bigint;
  readonly liabilitiesMinor: bigint;
  readonly equityMinor: bigint;
  readonly revenueMinor: bigint;
  readonly expensesMinor: bigint;
  /** assets = liabilities + equity + revenue − expenses */
  readonly holds: boolean;
}

export interface CachedBalanceMismatch {
  readonly accountId: string;
  readonly code: string;
  readonly cachedBalanceMinor: bigint;
  readonly entriesBalanceMinor: bigint;
  readonly cachedBalanceEntryId: bigint | null;
  readonly lastEntryId: bigint | null;
}

export interface BalanceContinuityBreak {
  readonly entryId: bigint;
  readonly accountId: string;
  readonly balanceAfterMinor: bigint;
  readonly expectedBalanceAfterMinor: bigint;
}

export enum HashChainFault {
  /** `previous_hash` does not equal the preceding entry's `entry_hash`: a row was removed, inserted or re-linked. */
  PREVIOUS_HASH_MISMATCH = 'PREVIOUS_HASH_MISMATCH',
  /** The stored hash does not match the row's own content: the row was edited. */
  ENTRY_HASH_MISMATCH = 'ENTRY_HASH_MISMATCH',
}

export interface HashChainBreak {
  readonly entryId: bigint;
  readonly accountId: string;
  readonly faults: readonly HashChainFault[];
}

export interface OverdrawnAccount {
  readonly accountId: string;
  readonly code: string;
  readonly currency: string;
  readonly balanceMinor: bigint;
  readonly overdraftLimitMinor: bigint;
}

export interface LedgerIntegrityReport {
  readonly unbalancedCurrencies: readonly TrialBalanceLine[];
  readonly accountingEquationFailures: readonly AccountingEquationLine[];
  readonly cachedBalanceMismatches: readonly CachedBalanceMismatch[];
  readonly balanceContinuityBreaks: readonly BalanceContinuityBreak[];
  readonly hashChainBreaks: readonly HashChainBreak[];
  /** A signal to investigate, not necessarily a bug (design §6.4); not part of `isClean`. */
  readonly overdrawnAccounts: readonly OverdrawnAccount[];
  /** True when the books are provably consistent with themselves. */
  readonly isClean: boolean;
}

/** An entry's amount, signed by its account's normal side (design §5.1). */
const SIGNED_AMOUNT = `CASE WHEN entry.direction::text = account.normal_side::text
                            THEN entry.amount_minor ELSE -entry.amount_minor END`;

/**
 * The books checked against themselves (design §8.1). Read-only. These are the
 * inputs to the Phase 9 nightly reconciliation, and the oracles of the ledger's
 * property and concurrency tests. Each check returns its violations; empty means
 * the invariant holds.
 */
@Injectable()
export class LedgerChecksService {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** Per currency: Σ debits = Σ credits across the whole ledger. */
  async trialBalance(): Promise<TrialBalanceLine[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT currency_code AS currency,
              COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0)::text  AS debit_total_minor,
              COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credit_total_minor
         FROM ledger_entries
        GROUP BY currency_code
        ORDER BY currency_code`,
    )) as { currency: string; debit_total_minor: string; credit_total_minor: string }[];
    return rows.map((row) => {
      const debitTotalMinor = BigInt(row.debit_total_minor);
      const creditTotalMinor = BigInt(row.credit_total_minor);
      return { currency: row.currency, debitTotalMinor, creditTotalMinor, balanced: debitTotalMinor === creditTotalMinor };
    });
  }

  /** Per currency: assets = liabilities + equity + revenue − expenses, from signed natural balances. */
  async accountingEquation(): Promise<AccountingEquationLine[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT currency_code AS currency, account_type, normal_side, SUM(balance_minor)::text AS balance_minor
         FROM accounts
        GROUP BY currency_code, account_type, normal_side
        ORDER BY currency_code`,
    )) as { currency: string; account_type: AccountType; normal_side: NormalSide; balance_minor: string }[];

    const totals = new Map<string, Record<AccountType, bigint>>();
    for (const row of rows) {
      const perType =
        totals.get(row.currency) ??
        { ASSET: 0n, LIABILITY: 0n, EQUITY: 0n, REVENUE: 0n, EXPENSE: 0n };
      perType[row.account_type] += balanceTowardsTypeTotal(row.account_type, row.normal_side, BigInt(row.balance_minor));
      totals.set(row.currency, perType);
    }
    return [...totals.entries()].map(([currency, perType]) => ({
      currency,
      assetsMinor: perType.ASSET,
      liabilitiesMinor: perType.LIABILITY,
      equityMinor: perType.EQUITY,
      revenueMinor: perType.REVENUE,
      expensesMinor: perType.EXPENSE,
      holds: perType.ASSET === perType.LIABILITY + perType.EQUITY + perType.REVENUE - perType.EXPENSE,
    }));
  }

  /** Accounts whose cached balance (or last folded entry) disagrees with their entries. */
  async findCachedBalanceMismatches(): Promise<CachedBalanceMismatch[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT account.id AS account_id,
              account.code,
              account.balance_minor::text                  AS cached_balance_minor,
              COALESCE(SUM(${SIGNED_AMOUNT}), 0)::text     AS entries_balance_minor,
              account.balance_entry_id::text               AS cached_balance_entry_id,
              MAX(entry.id)::text                          AS last_entry_id
         FROM accounts account
         LEFT JOIN ledger_entries entry ON entry.account_id = account.id
        GROUP BY account.id
       HAVING account.balance_minor <> COALESCE(SUM(${SIGNED_AMOUNT}), 0)
           OR account.balance_entry_id IS DISTINCT FROM MAX(entry.id)
        ORDER BY account.code, account.id`,
    )) as {
      account_id: string;
      code: string;
      cached_balance_minor: string;
      entries_balance_minor: string;
      cached_balance_entry_id: string | null;
      last_entry_id: string | null;
    }[];
    return rows.map((row) => ({
      accountId: row.account_id,
      code: row.code,
      cachedBalanceMinor: BigInt(row.cached_balance_minor),
      entriesBalanceMinor: BigInt(row.entries_balance_minor),
      cachedBalanceEntryId: row.cached_balance_entry_id === null ? null : BigInt(row.cached_balance_entry_id),
      lastEntryId: row.last_entry_id === null ? null : BigInt(row.last_entry_id),
    }));
  }

  /** Entries whose `balance_after_minor` ≠ the previous entry's + this entry's signed amount. */
  async findBalanceContinuityBreaks(): Promise<BalanceContinuityBreak[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT id::text AS entry_id, account_id, balance_after_minor::text, expected_balance_after_minor::text
         FROM (
           SELECT entry.id, entry.account_id, entry.balance_after_minor,
                  COALESCE(LAG(entry.balance_after_minor) OVER (PARTITION BY entry.account_id ORDER BY entry.id), 0)
                    + ${SIGNED_AMOUNT} AS expected_balance_after_minor
             FROM ledger_entries entry
             JOIN accounts account ON account.id = entry.account_id
         ) continuity
        WHERE balance_after_minor <> expected_balance_after_minor
        ORDER BY account_id, id`,
    )) as { entry_id: string; account_id: string; balance_after_minor: string; expected_balance_after_minor: string }[];
    return rows.map((row) => ({
      entryId: BigInt(row.entry_id),
      accountId: row.account_id,
      balanceAfterMinor: BigInt(row.balance_after_minor),
      expectedBalanceAfterMinor: BigInt(row.expected_balance_after_minor),
    }));
  }

  /**
   * Walk each account's hash chain (design §5.5). Recomputes every entry's hash from
   * the stored row through the same SQL functions the insert trigger used.
   */
  async verifyHashChains(accountId?: string): Promise<HashChainBreak[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT id::text AS entry_id, account_id,
              previous_hash IS DISTINCT FROM preceding_entry_hash AS previous_hash_mismatch,
              entry_hash IS DISTINCT FROM recomputed_hash         AS entry_hash_mismatch
         FROM (
           SELECT entry.id, entry.account_id, entry.previous_hash, entry.entry_hash,
                  LAG(entry.entry_hash) OVER (PARTITION BY entry.account_id ORDER BY entry.id) AS preceding_entry_hash,
                  ledger_entry_hash(
                    entry.previous_hash,
                    ledger_entry_canonical_text(
                      entry.id, entry.account_id, entry.transaction_id, entry.currency_code, entry.direction,
                      entry.amount_minor, entry.balance_after_minor, entry.value_time, entry.booking_time)
                  ) AS recomputed_hash
             FROM ledger_entries entry
            WHERE $1::uuid IS NULL OR entry.account_id = $1::uuid
         ) chain
        WHERE previous_hash IS DISTINCT FROM preceding_entry_hash
           OR entry_hash IS DISTINCT FROM recomputed_hash
        ORDER BY account_id, id`,
      [accountId ?? null],
    )) as { entry_id: string; account_id: string; previous_hash_mismatch: boolean; entry_hash_mismatch: boolean }[];
    return rows.map((row) => ({
      entryId: BigInt(row.entry_id),
      accountId: row.account_id,
      faults: [
        ...(row.previous_hash_mismatch ? [HashChainFault.PREVIOUS_HASH_MISMATCH] : []),
        ...(row.entry_hash_mismatch ? [HashChainFault.ENTRY_HASH_MISMATCH] : []),
      ],
    }));
  }

  /**
   * Balance-authorizing accounts below `−overdraft_limit` (design §6.4). Internal
   * accounts are excluded: a negative balance there is not a control (design §6.2) —
   * FX_POSITION, for one, is legitimately negative in the currency we are short.
   */
  async findOverdrawnAccounts(): Promise<OverdrawnAccount[]> {
    const rows = (await this.unitOfWork.manager.query(
      `SELECT id AS account_id, code, currency_code AS currency,
              balance_minor::text AS balance_minor, overdraft_limit_minor::text AS overdraft_limit_minor
         FROM accounts
        WHERE authorizes_balance AND balance_minor < -overdraft_limit_minor
        ORDER BY code`,
    )) as { account_id: string; code: string; currency: string; balance_minor: string; overdraft_limit_minor: string }[];
    return rows.map((row) => ({
      accountId: row.account_id,
      code: row.code,
      currency: row.currency,
      balanceMinor: BigInt(row.balance_minor),
      overdraftLimitMinor: BigInt(row.overdraft_limit_minor),
    }));
  }

  async runAllChecks(): Promise<LedgerIntegrityReport> {
    const unbalancedCurrencies = (await this.trialBalance()).filter((line) => !line.balanced);
    const accountingEquationFailures = (await this.accountingEquation()).filter((line) => !line.holds);
    const cachedBalanceMismatches = await this.findCachedBalanceMismatches();
    const balanceContinuityBreaks = await this.findBalanceContinuityBreaks();
    const hashChainBreaks = await this.verifyHashChains();
    const overdrawnAccounts = await this.findOverdrawnAccounts();
    return {
      unbalancedCurrencies,
      accountingEquationFailures,
      cachedBalanceMismatches,
      balanceContinuityBreaks,
      hashChainBreaks,
      overdrawnAccounts,
      isClean:
        unbalancedCurrencies.length === 0 &&
        accountingEquationFailures.length === 0 &&
        cachedBalanceMismatches.length === 0 &&
        balanceContinuityBreaks.length === 0 &&
        hashChainBreaks.length === 0,
    };
  }
}
