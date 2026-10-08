import { Injectable } from '@nestjs/common';
import { InvariantViolationError, UnsupportedCurrencyError, ValidationError } from '../../common/errors';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { CurrencyRegistry } from '../currencies/currency-registry';
import { microsecondsToTimestamp, timestampToMicroseconds } from '../transactions/history-time';
import { principalReferenceOf } from '../withdrawals/withdrawal-references';
import { WITHDRAWAL_CURRENCY, maskedAccountNumber } from '../withdrawals/withdrawal-records';
import { StashPosition, decodeStashCursor, encodeStashCursor } from './stash-cursor';

export const DEFAULT_STASH_PAGE_LIMIT = 50;
export const MAXIMUM_STASH_PAGE_LIMIT = 100;

export const STASH_KIND = 'SIMULATED_BANK';

export interface StashStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export interface StashBalanceView {
  readonly currency: string;
  readonly minorUnit: number;
  /** Confirmations less reversals, in minor units. */
  readonly amount: string;
}

export interface StashView {
  readonly stashId: string | null;
  readonly kind: typeof STASH_KIND;
  readonly simulated: true;
  readonly balances: readonly StashBalanceView[];
}

export type StashReceiptKind = 'CONFIRMATION' | 'REVERSAL';

export interface StashReceiptView {
  readonly receiptId: string;
  readonly kind: StashReceiptKind;
  /** CONFIRMATION = money arrived in the stash; REVERSAL = the bank returned it (it went back to your wallet). */
  readonly direction: 'IN' | 'OUT';
  readonly currency: string;
  readonly minorUnit: number;
  /** Always positive: the direction says which way. */
  readonly amount: string;
  readonly withdrawalId: string;
  /** The withdrawal's history reference, `withdrawal:{withdrawalId}`. */
  readonly withdrawalReference: string;
  /** The reference we gave Paystack for the transfer. */
  readonly providerReference: string;
  /** The ledger transaction this receipt records (the withdrawal's posting, or its reversal). */
  readonly ledgerReference: string;
  readonly destination: { readonly bankCode: string; readonly bankName: string; readonly accountNumberMasked: string };
  /** On a REVERSAL: the confirmation it reverses. */
  readonly reversesReceiptId: string | null;
  /** On a CONFIRMATION: the reversal that later returned it, if any. */
  readonly reversedByReceiptId: string | null;
  readonly valueTime: string;
  readonly recordedAt: string;
}

export interface StashTransactionsPage {
  readonly stashId: string | null;
  readonly kind: typeof STASH_KIND;
  readonly simulated: true;
  readonly items: readonly StashReceiptView[];
  readonly nextCursor: string | null;
}

interface ReceiptRow {
  readonly id: string;
  readonly position_microseconds: string;
  readonly event_kind: string;
  readonly currency_code: string;
  readonly minor_unit: number;
  readonly amount_minor: string;
  readonly withdrawal_id: string;
  readonly provider_reference: string;
  readonly ledger_reference: string | null;
  readonly bank_code: string;
  readonly bank_name: string;
  readonly account_number_last_four: string;
  readonly reverses_receipt_id: string | null;
  readonly reversed_by_receipt_id: string | null;
  readonly value_time: Date;
  readonly recorded_at: Date;
}

/**
 * The customer's simulated-bank stash (WITHDRAWAL_PLAN.md §J): read-only projections of the append-only
 * `stash_receipts`. The balance is ONE statement summing receipts (confirmations less reversals) — no stored mutable
 * sum, and nothing here (or anywhere in wallet/trading/funding) treats it as spendable. An unopened stash reads as a null
 * id and NGN "0"; nothing is written. Every query is scoped to the caller in SQL.
 */
@Injectable()
export class StashService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly currencies: CurrencyRegistry,
  ) {}

  async view(userId: string): Promise<StashView> {
    const statement = this.buildBalances(userId);
    const rows = (await this.unitOfWork.manager.query(statement.sql, [...statement.parameters])) as {
      stash_id: string | null;
      currency_code: string;
      minor_unit: number;
      amount: string;
    }[];
    if (rows.some((row) => row.amount.startsWith('-'))) {
      // Every reversal reverses exactly one confirmation (UNIQUE + FK): a negative stash means the books are broken.
      throw new InvariantViolationError('A stash balance is negative.', { userId });
    }
    return {
      stashId: rows[0]?.stash_id ?? null,
      kind: STASH_KIND,
      simulated: true,
      balances: rows.map((row) => ({ currency: row.currency_code, minorUnit: row.minor_unit, amount: row.amount })),
    };
  }

  async transactions(userId: string, parameters: { currency?: string; cursor?: string; limit?: string }): Promise<StashTransactionsPage> {
    const currency = parameters.currency ?? null;
    if (currency !== null && !this.currencies.lookup(currency)) throw new UnsupportedCurrencyError(currency);
    const limit = parseLimit(parameters.limit);
    const position = parameters.cursor === undefined ? null : decodeStashCursor(parameters.cursor, currency);
    const statement = this.buildPage(userId, currency, position, limit + 1);
    const rows = (await this.unitOfWork.manager.query(statement.sql, [...statement.parameters])) as ReceiptRow[];
    const stashId = await this.stashIdOf(userId);
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      stashId,
      kind: STASH_KIND,
      simulated: true,
      items: pageRows.map(receiptView),
      nextCursor: rows.length > limit && last ? encodeStashCursor({ timeMicroseconds: BigInt(last.position_microseconds), id: last.id }, currency) : null,
    };
  }

  /** ONE statement summing the append-only receipts per currency (NGN always listed). Public so the plan suite EXPLAINs it. */
  buildBalances(userId: string): StashStatement {
    return {
      sql: `WITH sums AS (
         SELECT stash_receipts.currency_code,
                sum(CASE stash_receipts.event_kind WHEN 'CONFIRMATION' THEN stash_receipts.amount_minor ELSE -stash_receipts.amount_minor END) AS amount
           FROM stash_receipts
          WHERE stash_receipts.user_id = $1
          GROUP BY stash_receipts.currency_code
       )
       SELECT (SELECT customer_stashes.id::text FROM customer_stashes WHERE customer_stashes.user_id = $1) AS stash_id,
              currencies.code AS currency_code, currencies.minor_unit, coalesce(sums.amount, 0)::text AS amount
         FROM currencies
         LEFT JOIN sums ON sums.currency_code = currencies.code
        WHERE currencies.code = $2 OR sums.currency_code IS NOT NULL
        ORDER BY currencies.code`,
      parameters: [userId, WITHDRAWAL_CURRENCY],
    };
  }

  /**
   * One page of receipts, newest recorded first: `page` streams from `stash_receipts_user[_currency]_recorded_index`;
   * the projection joins only the page's rows, each join scoped by the owner again. Public so the plan suite EXPLAINs it.
   */
  buildPage(userId: string, currency: string | null, position: StashPosition | null, size: number): StashStatement {
    const values: unknown[] = [userId];
    const bind = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    const currencyFilter = currency === null ? '' : `AND stash_receipts.currency_code = ${bind(currency)}`;
    const keyset =
      position === null
        ? ''
        : `AND (stash_receipts.recorded_at, stash_receipts.id) < (${microsecondsToTimestamp(bind(position.timeMicroseconds.toString()))}, ${bind(position.id)}::uuid)`;
    const limit = bind(size);
    return {
      sql: `WITH page AS (
         SELECT stash_receipts.id, stash_receipts.recorded_at
           FROM stash_receipts
          WHERE stash_receipts.user_id = $1 ${currencyFilter} ${keyset}
          ORDER BY stash_receipts.recorded_at DESC, stash_receipts.id DESC
          LIMIT ${limit}
       )
       SELECT receipt.id::text AS id,
              ${timestampToMicroseconds('receipt.recorded_at')} AS position_microseconds,
              receipt.event_kind::text AS event_kind,
              receipt.currency_code, currencies.minor_unit, receipt.amount_minor::text AS amount_minor,
              receipt.withdrawal_id::text AS withdrawal_id,
              paystack_withdrawals.provider_reference,
              transactions.reference AS ledger_reference,
              withdrawal_destinations.bank_code, withdrawal_destinations.bank_name, withdrawal_destinations.account_number_last_four,
              receipt.reverses_receipt_id::text AS reverses_receipt_id,
              reversal.id::text AS reversed_by_receipt_id,
              receipt.value_time, receipt.recorded_at
         FROM page
         JOIN stash_receipts AS receipt ON receipt.id = page.id AND receipt.user_id = $1
         JOIN currencies ON currencies.code = receipt.currency_code
         JOIN paystack_withdrawals ON paystack_withdrawals.flow_id = receipt.withdrawal_id AND paystack_withdrawals.user_id = $1
         JOIN withdrawal_destinations ON withdrawal_destinations.withdrawal_id = receipt.withdrawal_id
         LEFT JOIN transactions ON transactions.id = receipt.ledger_transaction_id AND transactions.user_id = $1
         LEFT JOIN stash_receipts AS reversal ON reversal.reverses_receipt_id = receipt.id AND reversal.user_id = $1
        ORDER BY page.recorded_at DESC, page.id DESC`,
      parameters: values,
    };
  }

  private async stashIdOf(userId: string): Promise<string | null> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT id::text AS id FROM customer_stashes WHERE user_id = $1`, [userId])) as { id: string }[];
    return row?.id ?? null;
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_STASH_PAGE_LIMIT;
  const limit = /^[1-9]\d{0,2}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_STASH_PAGE_LIMIT) {
    throw new ValidationError(`limit must be a whole number from 1 to ${MAXIMUM_STASH_PAGE_LIMIT}.`, {
      violations: [`limit must be a whole number from 1 to ${MAXIMUM_STASH_PAGE_LIMIT}`],
    });
  }
  return limit;
}

export function receiptView(row: ReceiptRow): StashReceiptView {
  if (row.event_kind !== 'CONFIRMATION' && row.event_kind !== 'REVERSAL') {
    throw new InvariantViolationError(`Unknown stash receipt kind ${row.event_kind}.`, { receiptId: row.id });
  }
  if (row.event_kind === 'REVERSAL' && (row.reverses_receipt_id === null || row.reversed_by_receipt_id !== null)) {
    throw new InvariantViolationError('A stash reversal must reverse one confirmation and is never reversed itself.', { receiptId: row.id });
  }
  if (row.ledger_reference === null) {
    // The receipt's posting must be the caller's own: never drop the receipt, never show a foreign reference.
    throw new InvariantViolationError("A stash receipt's ledger transaction is not the owner's.", { receiptId: row.id });
  }
  return {
    receiptId: row.id,
    kind: row.event_kind,
    direction: row.event_kind === 'CONFIRMATION' ? 'IN' : 'OUT',
    currency: row.currency_code,
    minorUnit: row.minor_unit,
    amount: row.amount_minor,
    withdrawalId: row.withdrawal_id,
    withdrawalReference: principalReferenceOf(row.withdrawal_id),
    providerReference: row.provider_reference,
    ledgerReference: row.ledger_reference,
    destination: { bankCode: row.bank_code, bankName: row.bank_name, accountNumberMasked: maskedAccountNumber(row.account_number_last_four) },
    reversesReceiptId: row.reverses_receipt_id,
    reversedByReceiptId: row.reversed_by_receipt_id,
    valueTime: row.value_time.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
  };
}

export type { ReceiptRow };
