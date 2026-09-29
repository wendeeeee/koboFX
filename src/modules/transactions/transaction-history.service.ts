import { Injectable } from '@nestjs/common';
import { UnsupportedCurrencyError, ValidationError } from '../../common/errors';
import { CurrencyRegistry } from '../currencies/currency-registry';
import { ListTransactionsQuery } from './dto/list-transactions.query';
import { HistoryQuery, HistorySort, decodeCursor, encodeCursor } from './history-cursor';
import { parseInstantMicroseconds } from './history-time';
import { parseTransactionLookup } from './reference';
import { HistoryScope, TransactionHistoryRepository } from './transaction-history.repository';
import { TransactionDetailView, TransactionListItemView, detailView, listItemView } from './transaction.view';
import { TransactionNotFoundError } from './transactions.errors';

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAXIMUM_HISTORY_LIMIT = 100;

export interface TransactionPage {
  readonly items: readonly TransactionListItemView[];
  /** Null on the last page. Valid only with the same sort and filters. */
  readonly nextCursor: string | null;
}

/**
 * History (design §7.8): the caller's transactions plus the fundings that never posted, newest
 * first, keyset-paginated. Database-only, no idempotency key (reads have no effect to repeat).
 */
@Injectable()
export class TransactionHistoryService {
  constructor(
    private readonly repository: TransactionHistoryRepository,
    private readonly currencies: CurrencyRegistry,
  ) {}

  async list(scope: HistoryScope, parameters: ListTransactionsQuery): Promise<TransactionPage> {
    const query = this.normalise(parameters);
    // Strict: digits only (parseInt would read "1e2" as 1). The DTO says the same at the edge.
    const limit = parameters.limit === undefined ? DEFAULT_HISTORY_LIMIT : /^[1-9]\d{0,2}$/.test(parameters.limit) ? Number(parameters.limit) : Number.NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_HISTORY_LIMIT) {
      throw new ValidationError(`limit must be a whole number from 1 to ${MAXIMUM_HISTORY_LIMIT}.`, {
        violations: [`limit must be a whole number from 1 to ${MAXIMUM_HISTORY_LIMIT}`],
      });
    }
    const position = parameters.cursor === undefined ? null : decodeCursor(parameters.cursor, query);
    // One row beyond the page says whether there is a next one; it is never returned.
    const rows = await this.repository.page(scope, query, position, limit + 1);
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      rows.length > limit && last ? encodeCursor({ timeMicroseconds: BigInt(last.position_microseconds), id: last.id }, query) : null;
    return { items: pageRows.map(listItemView), nextCursor };
  }

  async find(scope: HistoryScope, rawReference: string): Promise<TransactionDetailView> {
    const lookup = parseTransactionLookup(rawReference);
    const row = await this.repository.find(scope, lookup);
    if (!row) throw new TransactionNotFoundError(rawReference);
    return detailView(row);
  }

  /** Parameters → the canonical query a cursor is bound to. */
  private normalise(parameters: ListTransactionsQuery): HistoryQuery {
    const currency = parameters.currency ?? null;
    // Any KNOWN currency (active or not): a deactivated currency's history is still history.
    if (currency !== null && !this.currencies.lookup(currency)) throw new UnsupportedCurrencyError(currency);
    const fromMicroseconds = parameters.from === undefined ? null : parseInstantMicroseconds('from', parameters.from);
    const toMicroseconds = parameters.to === undefined ? null : parseInstantMicroseconds('to', parameters.to);
    if (fromMicroseconds !== null && toMicroseconds !== null && fromMicroseconds >= toMicroseconds) {
      throw new ValidationError('from must be before to.', { violations: ['from must be before to'] });
    }
    return {
      sort: (parameters.sort as HistorySort | undefined) ?? HistorySort.VALUE_TIME,
      type: parameters.type ?? null,
      currency,
      fromMicroseconds,
      toMicroseconds,
    };
  }
}
