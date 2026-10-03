import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { TransactionType } from '../ledger/ledger.types';
import { HistoryPosition, HistoryQuery, HistorySort } from './history-cursor';
import { microsecondsToTimestamp, timestampToMicroseconds } from './history-time';
import { TransactionLookup } from './reference';
import { HistoryRow } from './transaction.view';


export type HistoryView = 'USER' | 'ADMIN';

export interface HistoryScope {
  readonly userId: string;
  readonly view?: HistoryView;
}

export interface HistoryStatement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

class Parameters {
  readonly values: unknown[] = [];

  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

const TIME_COLUMN: Readonly<Record<HistorySort, 'value_time' | 'booking_time'>> = {
  [HistorySort.VALUE_TIME]: 'value_time',
  [HistorySort.BOOKING_TIME]: 'booking_time',
};


@Injectable()
export class TransactionHistoryRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async page(scope: HistoryScope, query: HistoryQuery, position: HistoryPosition | null, limit: number): Promise<HistoryRow[]> {
    return this.run(this.buildPage(scope, query, position, limit));
  }


  async find(scope: HistoryScope, lookup: TransactionLookup): Promise<HistoryRow | null> {
    const [row] = await this.run(this.buildFind(scope, lookup));
    return row ?? null;
  }


  buildPage(scope: HistoryScope, query: HistoryQuery, position: HistoryPosition | null, limit: number): HistoryStatement {
    const parameters = new Parameters();
    const user = parameters.bind(scope.userId);
    const size = parameters.bind(limit);
    const branches = [this.transactionBranch(parameters, user, size, query, position)];
    if (query.type === null || query.type === TransactionType.FUNDING) {
      branches.push(this.unpostedFundingBranch(parameters, user, size, query, position));
    }
    const page = `SELECT * FROM (${branches.map((branch) => `(${branch})`).join('\nUNION ALL\n')}) AS candidates
      ORDER BY sort_time DESC, id DESC LIMIT ${size}`;
    return this.select(parameters, user, page, scope.view ?? 'USER');
  }

  buildFind(scope: HistoryScope, lookup: TransactionLookup): HistoryStatement {
    const parameters = new Parameters();
    const user = parameters.bind(scope.userId);
    const branches: string[] = [];
    if (lookup.kind === 'reference') {
      branches.push(`SELECT 'TRANSACTION'::text AS source, transactions.id, transactions.value_time AS sort_time
                       FROM transactions WHERE transactions.reference = ${parameters.bind(lookup.reference)} AND transactions.user_id = ${user}`);
      if (lookup.prefix === 'funding') {
        branches.push(`SELECT 'FUNDING'::text, funding_payments.flow_id, funding_payments.created_at
                         FROM funding_payments
                        WHERE funding_payments.flow_id = ${parameters.bind(lookup.id)}::uuid AND funding_payments.user_id = ${user}
                          AND funding_payments.funding_transaction_id IS NULL`);
      }
    } else {
      const id = parameters.bind(lookup.id);
      branches.push(`SELECT 'TRANSACTION'::text AS source, transactions.id, transactions.value_time AS sort_time
                       FROM transactions WHERE transactions.id = ${id}::uuid AND transactions.user_id = ${user}`);
    }
    return this.select(parameters, user, branches.join('\nUNION ALL\n'), scope.view ?? 'USER');
  }

  private async run(statement: HistoryStatement): Promise<HistoryRow[]> {
    return (await this.unitOfWork.manager.query(statement.sql, [...statement.parameters])) as HistoryRow[];
  }

  private transactionBranch(parameters: Parameters, user: string, size: string, query: HistoryQuery, position: HistoryPosition | null): string {
    const time = TIME_COLUMN[query.sort];
    const typeFilter = query.type === null ? '' : `AND transactions.type = ${parameters.bind(query.type)}::transaction_type`;
    if (query.currency === null) {
      const column = `transactions.${time}`;
      return `SELECT 'TRANSACTION'::text AS source, transactions.id, ${column} AS sort_time
                FROM transactions
               WHERE transactions.user_id = ${user} ${typeFilter}
                 ${rangeFilter(parameters, column, query)}
                 ${keysetFilter(parameters, column, 'transactions.id', position)}
               ORDER BY ${column} DESC, transactions.id DESC
               LIMIT ${size}`;
    }
    const column = `ledger_entries.${time}`;
    return `SELECT DISTINCT 'TRANSACTION'::text AS source, ledger_entries.transaction_id AS id, ${column} AS sort_time
              FROM ledger_entries
              JOIN transactions ON transactions.id = ledger_entries.transaction_id
             WHERE ledger_entries.account_id = (
                     SELECT accounts.id FROM accounts JOIN wallets ON wallets.id = accounts.wallet_id
                      WHERE wallets.user_id = ${user} AND accounts.currency_code = ${parameters.bind(query.currency)})
               AND transactions.user_id = ${user} ${typeFilter}
               ${rangeFilter(parameters, column, query)}
               ${keysetFilter(parameters, column, 'ledger_entries.transaction_id', position)}
             ORDER BY ${column} DESC, ledger_entries.transaction_id DESC
             LIMIT ${size}`;
  }

  
  private unpostedFundingBranch(parameters: Parameters, user: string, size: string, query: HistoryQuery, position: HistoryPosition | null): string {
    const column = 'funding_payments.created_at';
    const currencyFilter = query.currency === null ? '' : `AND funding_payments.currency_code = ${parameters.bind(query.currency)}`;
    return `SELECT 'FUNDING'::text AS source, funding_payments.flow_id AS id, ${column} AS sort_time
              FROM funding_payments
             WHERE funding_payments.user_id = ${user} AND funding_payments.funding_transaction_id IS NULL ${currencyFilter}
               ${rangeFilter(parameters, column, query)}
               ${keysetFilter(parameters, column, 'funding_payments.flow_id', position)}
             ORDER BY ${column} DESC, funding_payments.flow_id DESC
             LIMIT ${size}`;
  }


  private select(parameters: Parameters, user: string, page: string, view: HistoryView): HistoryStatement {

    const linkScope = (alias: string) => (view === 'ADMIN' || alias === 'corrects' ? `(${alias}.user_id = ${user} OR ${alias}.user_id IS NULL)` : `${alias}.user_id = ${user}`);
    const adminColumns =
      view === 'ADMIN'
        ? `,
             transactions.metadata,
             transactions.external_reference,
             transactions.correction_subject,
             all_legs.legs AS all_legs`
        : '';
    const adminJoins =
      view === 'ADMIN'
        ? `
        LEFT JOIN LATERAL (
          -- Every leg (admin only): internal accounts by code and bucket; a user leg says whose it is.
          SELECT json_agg(json_build_object(
                   'accountCode', accounts.code,
                   'bucket', accounts.bucket,
                   'owner', CASE WHEN accounts.wallet_id IS NULL THEN 'INTERNAL'
                                 WHEN wallets.user_id = ${user} THEN 'USER' ELSE 'OTHER_USER' END,
                   'currency', ledger_entries.currency_code,
                   'minorUnit', currencies.minor_unit,
                   'direction', ledger_entries.direction,
                   'amount', ledger_entries.amount_minor::text,
                   'balanceAfter', ledger_entries.balance_after_minor::text
                 ) ORDER BY ledger_entries.id) AS legs
            FROM ledger_entries
            JOIN accounts ON accounts.id = ledger_entries.account_id
            LEFT JOIN wallets ON wallets.id = accounts.wallet_id
            JOIN currencies ON currencies.code = ledger_entries.currency_code
           WHERE ledger_entries.transaction_id = transactions.id
        ) AS all_legs ON TRUE`
        : '';
    const sql = `
      WITH page AS (${page})
      SELECT page.source,
             page.id::text AS id,
             ${timestampToMicroseconds('page.sort_time')} AS position_microseconds,
             COALESCE(transactions.reference, 'funding:' || funding_payments.flow_id::text) AS reference,
             COALESCE(transactions.type::text, 'FUNDING') AS type,
             COALESCE(transactions.status::text, flow_instances.state) AS status,
             transactions.reason_code,
             COALESCE(transactions.initiated_by, 'user:' || funding_payments.user_id::text) AS initiated_by,
             COALESCE(transactions.failure_code, funding_payments.failure_code) AS failure_code,
             COALESCE(transactions.value_time, funding_payments.created_at) AS value_time,
             COALESCE(transactions.booking_time, funding_payments.created_at) AS booking_time,
             -- A funding's transaction row is append-only (Phase 2 decision 3); when the PSP settles
             -- it (Phase 9), the settlement time is recorded on its funding payment instead.
             COALESCE(transactions.settlement_time, settled_funding.settled_at) AS settlement_time,
             transactions.rate_display::text AS rate_display,
             transactions.reference_rate::text AS reference_rate,
             transactions.rate_provider,
             transactions.rate_fetched_at,
             transactions.rate_provider_updated_at,
             transactions.rate_snapshot_id::text AS rate_snapshot_id,
             transactions.spread_basis_points,
             transactions.quote_id::text AS quote_id,
             transactions.corrects_transaction_id::text AS corrects_transaction_id,
             transactions.corrected_by_transaction_id::text AS corrected_by_transaction_id,
             ${view === 'ADMIN' ? 'corrects.reference' : `CASE WHEN corrects.user_id = ${user} THEN corrects.reference END`} AS corrects_reference,
             ${view === 'ADMIN' ? 'corrects.type::text' : `CASE WHEN corrects.user_id = ${user} THEN corrects.type::text END`} AS corrects_type,
             corrected_by.reference AS corrected_by_reference,
             corrected_by.type::text AS corrected_by_type,
             (corrects.id IS NOT NULL AND corrects.user_id IS NULL) AS corrects_internal,
             legs.legs,
             funding_payments.currency_code AS requested_currency,
             requested_currency.minor_unit AS requested_minor_unit,
             funding_payments.amount_minor::text AS requested_amount${adminColumns}
        FROM page
        LEFT JOIN transactions
          ON page.source = 'TRANSACTION' AND transactions.id = page.id AND transactions.user_id = ${user}
        LEFT JOIN transactions AS corrects
          ON corrects.id = transactions.corrects_transaction_id AND ${linkScope('corrects')}
        LEFT JOIN transactions AS corrected_by
          ON corrected_by.id = transactions.corrected_by_transaction_id AND ${linkScope('corrected_by')}
        LEFT JOIN funding_payments AS settled_funding
          ON transactions.type = 'FUNDING' AND settled_funding.funding_transaction_id = transactions.id
         AND settled_funding.user_id = ${user}
        LEFT JOIN funding_payments
          ON page.source = 'FUNDING' AND funding_payments.flow_id = page.id AND funding_payments.user_id = ${user}
        LEFT JOIN flow_instances ON flow_instances.id = funding_payments.flow_id
        LEFT JOIN currencies AS requested_currency ON requested_currency.code = funding_payments.currency_code
        LEFT JOIN LATERAL (
          -- The USER's own legs only (Phase 8 decision 5): internal accounts have no wallet.
          -- Debits (money out) before credits; entry ids follow the ledger's lock order, not the draft's.
          SELECT json_agg(json_build_object(
                   'currency', ledger_entries.currency_code,
                   'minorUnit', currencies.minor_unit,
                   'direction', ledger_entries.direction,
                   'amount', ledger_entries.amount_minor::text,
                   'balanceAfter', ledger_entries.balance_after_minor::text
                 ) ORDER BY ledger_entries.direction, ledger_entries.id) AS legs
            FROM ledger_entries
            JOIN accounts ON accounts.id = ledger_entries.account_id
            JOIN wallets ON wallets.id = accounts.wallet_id AND wallets.user_id = ${user}
            JOIN currencies ON currencies.code = ledger_entries.currency_code
           WHERE ledger_entries.transaction_id = transactions.id
        ) AS legs ON TRUE${adminJoins}
       ORDER BY page.sort_time DESC, page.id DESC`;
    return { sql, parameters: parameters.values };
  }
}

/** `[from, to)` on the sort's time — half-open, like `period_locks`. */
function rangeFilter(parameters: Parameters, column: string, query: HistoryQuery): string {
  const conditions: string[] = [];
  if (query.fromMicroseconds !== null) {
    conditions.push(`AND ${column} >= ${microsecondsToTimestamp(parameters.bind(query.fromMicroseconds.toString()))}`);
  }
  if (query.toMicroseconds !== null) {
    conditions.push(`AND ${column} < ${microsecondsToTimestamp(parameters.bind(query.toMicroseconds.toString()))}`);
  }
  return conditions.join(' ');
}


function keysetFilter(parameters: Parameters, timeColumn: string, idColumn: string, position: HistoryPosition | null): string {
  if (position === null) return '';
  const time = microsecondsToTimestamp(parameters.bind(position.timeMicroseconds.toString()));
  return `AND (${timeColumn}, ${idColumn}) < (${time}, ${parameters.bind(position.id)}::uuid)`;
}
