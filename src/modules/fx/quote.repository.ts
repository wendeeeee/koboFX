import { Injectable } from '@nestjs/common';
import { Dec, dec } from '../../common/money';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { QuoteAmountMode } from './pricing';

/** A quote as stored: everything Phase 7 posts, verbatim (design §7.7; Phase 6 §5.8). */
export interface Quote {
  readonly id: string;
  readonly userId: string;
  readonly sourceCurrency: string;
  readonly targetCurrency: string;
  readonly amountMode: QuoteAmountMode;
  readonly sourceAmountMinor: bigint;
  readonly targetAmountMinor: bigint;
  readonly targetMidValueMinor: bigint;
  readonly revenueMinor: bigint;
  readonly midRate: Dec;
  readonly clientRate: Dec;
  readonly spreadBasisPoints: number;
  readonly sourceReferenceRate: Dec;
  readonly targetReferenceRate: Dec;
  readonly rateSnapshotId: string;
  readonly rateProvider: string;
  readonly rateProviderUpdatedAt: Date;
  readonly rateFetchedAt: Date;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export type NewQuote = Omit<Quote, 'id' | 'consumedAt'>;

interface QuoteRow {
  id: string;
  user_id: string;
  source_currency_code: string;
  target_currency_code: string;
  amount_mode: QuoteAmountMode;
  source_amount_minor: string;
  target_amount_minor: string;
  target_mid_value_minor: string;
  revenue_minor: string;
  mid_rate: string;
  client_rate: string;
  spread_basis_points: number;
  source_reference_rate: string;
  target_reference_rate: string;
  rate_snapshot_id: string;
  rate_provider: string;
  rate_provider_updated_at: Date;
  rate_fetched_at: Date;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

// Amounts and rates come back as text and are parsed straight to bigint / Decimal.
const COLUMNS = `id, user_id, source_currency_code, target_currency_code, amount_mode,
  source_amount_minor::text AS source_amount_minor, target_amount_minor::text AS target_amount_minor,
  target_mid_value_minor::text AS target_mid_value_minor, revenue_minor::text AS revenue_minor,
  mid_rate::text AS mid_rate, client_rate::text AS client_rate, spread_basis_points,
  source_reference_rate::text AS source_reference_rate, target_reference_rate::text AS target_reference_rate,
  rate_snapshot_id, rate_provider, rate_provider_updated_at, rate_fetched_at, issued_at, expires_at, consumed_at`;

function toQuote(row: QuoteRow): Quote {
  return {
    id: row.id,
    userId: row.user_id,
    sourceCurrency: row.source_currency_code.trim(),
    targetCurrency: row.target_currency_code.trim(),
    amountMode: row.amount_mode,
    sourceAmountMinor: BigInt(row.source_amount_minor),
    targetAmountMinor: BigInt(row.target_amount_minor),
    targetMidValueMinor: BigInt(row.target_mid_value_minor),
    revenueMinor: BigInt(row.revenue_minor),
    midRate: dec(row.mid_rate),
    clientRate: dec(row.client_rate),
    spreadBasisPoints: row.spread_basis_points,
    sourceReferenceRate: dec(row.source_reference_rate),
    targetReferenceRate: dec(row.target_reference_rate),
    rateSnapshotId: row.rate_snapshot_id,
    rateProvider: row.rate_provider,
    rateProviderUpdatedAt: row.rate_provider_updated_at,
    rateFetchedAt: row.rate_fetched_at,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

/** `quotes`: insert, read scoped by user, and the single atomic consumption. */
@Injectable()
export class QuoteRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async insert(quote: NewQuote): Promise<Quote> {
    const [row] = (await this.unitOfWork.manager.query(
      `INSERT INTO quotes
         (user_id, source_currency_code, target_currency_code, amount_mode, source_amount_minor, target_amount_minor,
          target_mid_value_minor, revenue_minor, mid_rate, client_rate, spread_basis_points, source_reference_rate,
          target_reference_rate, rate_snapshot_id, rate_provider, rate_provider_updated_at, rate_fetched_at, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11, $12::numeric, $13::numeric, $14, $15, $16, $17, $18, $19)
       RETURNING ${COLUMNS}`,
      [
        quote.userId,
        quote.sourceCurrency,
        quote.targetCurrency,
        quote.amountMode,
        quote.sourceAmountMinor.toString(),
        quote.targetAmountMinor.toString(),
        quote.targetMidValueMinor.toString(),
        quote.revenueMinor.toString(),
        quote.midRate.toFixed(),
        quote.clientRate.toFixed(),
        quote.spreadBasisPoints,
        quote.sourceReferenceRate.toFixed(),
        quote.targetReferenceRate.toFixed(),
        quote.rateSnapshotId,
        quote.rateProvider,
        quote.rateProviderUpdatedAt,
        quote.rateFetchedAt,
        quote.issuedAt,
        quote.expiresAt,
      ],
    )) as QuoteRow[];
    return toQuote(row);
  }

  /** Scoped by the caller in the WHERE clause: another user's quote is simply not found. */
  async findForUser(quoteId: string, userId: string): Promise<Quote | undefined> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT ${COLUMNS} FROM quotes WHERE id = $1 AND user_id = $2`, [
      quoteId,
      userId,
    ])) as QuoteRow[];
    return row ? toQuote(row) : undefined;
  }

  /**
   * The single consumption: one statement, one `now`. Succeeds only for the owner, if
   * unconsumed, strictly before expiry. Returns undefined when it did not consume.
   */
  async consume(quoteId: string, userId: string, now: Date): Promise<Quote | undefined> {
    const [row] = (await this.unitOfWork.manager.query(
      `WITH consumed AS (
         UPDATE quotes SET consumed_at = $3
          WHERE id = $1 AND user_id = $2 AND consumed_at IS NULL AND expires_at > $3
          RETURNING *
       )
       SELECT ${COLUMNS} FROM consumed`,
      [quoteId, userId, now],
    )) as QuoteRow[];
    return row ? toQuote(row) : undefined;
  }
}
