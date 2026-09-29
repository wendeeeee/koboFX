import { Injectable } from '@nestjs/common';
import { Dec, dec } from '../../common/money';
import { UnitOfWork } from '../../database/transaction/unit-of-work';

export enum SnapshotStatus {
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
}

/** An accepted snapshot: what the serving path, the cache and every quote read. */
export interface RateSnapshot {
  readonly id: string;
  readonly provider: string;
  readonly providerUpdatedAt: Date;
  readonly providerNextUpdateAt: Date;
  readonly fetchedAt: Date;
  /** USD-based mids: 1 USD = rate × currency. */
  readonly rates: ReadonlyMap<string, Dec>;
}

export interface NewSnapshot {
  readonly provider: string;
  readonly baseCurrency: string;
  readonly providerUpdatedAt: Date | null;
  readonly providerNextUpdateAt: Date | null;
  readonly fetchedAt: Date;
  readonly status: SnapshotStatus;
  readonly rejectionReasons: readonly string[];
  readonly providerCallId: string | undefined;
  readonly rates: ReadonlyMap<string, Dec>;
}

/** The latest fetch of any status: what the poll schedule is computed from. */
export interface LatestFetchRow {
  readonly id: string;
  readonly fetchedAt: Date;
  readonly providerUpdatedAt: Date | null;
  readonly providerNextUpdateAt: Date | null;
  readonly status: SnapshotStatus;
}

interface SnapshotRow {
  id: string;
  provider: string;
  provider_updated_at: Date;
  provider_next_update_at: Date;
  fetched_at: Date;
  rates: { currency_code: string; rate: string }[] | null;
}

/**
 * `exchange_rate_snapshots` (Phase 6 §B): the durable record of every fetch — the
 * evidence, and the fallback whenever Redis is empty, flushed or down (design §16).
 * Append-only; the insert is one short transaction of its own, never held across the
 * provider call.
 */
@Injectable()
export class ExchangeRateSnapshotRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async insert(snapshot: NewSnapshot): Promise<string> {
    return this.unitOfWork.run(async (manager) => {
      const [row] = (await manager.query(
        `INSERT INTO exchange_rate_snapshots
           (provider, base_currency_code, provider_updated_at, provider_next_update_at, fetched_at, status,
            rejection_reasons, provider_call_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          snapshot.provider,
          snapshot.baseCurrency,
          snapshot.providerUpdatedAt,
          snapshot.providerNextUpdateAt,
          snapshot.fetchedAt,
          snapshot.status,
          snapshot.rejectionReasons,
          snapshot.providerCallId ?? null,
        ],
      )) as { id: string }[];
      const entries = [...snapshot.rates];
      if (entries.length > 0) {
        await manager.query(
          `INSERT INTO exchange_rate_snapshot_rates (snapshot_id, currency_code, rate)
           SELECT $1, currency_code, rate::numeric FROM unnest($2::text[], $3::text[]) AS input (currency_code, rate)`,
          [row.id, entries.map(([currency]) => currency), entries.map(([, rate]) => rate.toFixed())],
        );
      }
      return row.id;
    });
  }

  async latestAccepted(provider: string): Promise<RateSnapshot | undefined> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT snapshot.id, snapshot.provider, snapshot.provider_updated_at, snapshot.provider_next_update_at,
              snapshot.fetched_at,
              (SELECT json_agg(json_build_object('currency_code', rate.currency_code, 'rate', rate.rate::text))
                 FROM exchange_rate_snapshot_rates rate WHERE rate.snapshot_id = snapshot.id) AS rates
         FROM exchange_rate_snapshots snapshot
        WHERE snapshot.provider = $1 AND snapshot.status = 'ACCEPTED'
        ORDER BY snapshot.fetched_at DESC, snapshot.provider_updated_at DESC, snapshot.id DESC
        LIMIT 1`,
      [provider],
    )) as SnapshotRow[];
    return row ? toSnapshot(row) : undefined;
  }

  async findAccepted(snapshotId: string): Promise<RateSnapshot | undefined> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT snapshot.id, snapshot.provider, snapshot.provider_updated_at, snapshot.provider_next_update_at,
              snapshot.fetched_at,
              (SELECT json_agg(json_build_object('currency_code', rate.currency_code, 'rate', rate.rate::text))
                 FROM exchange_rate_snapshot_rates rate WHERE rate.snapshot_id = snapshot.id) AS rates
         FROM exchange_rate_snapshots snapshot
        WHERE snapshot.id = $1 AND snapshot.status = 'ACCEPTED'`,
      [snapshotId],
    )) as SnapshotRow[];
    return row ? toSnapshot(row) : undefined;
  }

  async latestFetch(provider: string): Promise<LatestFetchRow | undefined> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT id, fetched_at, provider_updated_at, provider_next_update_at, status
         FROM exchange_rate_snapshots
        WHERE provider = $1
        ORDER BY fetched_at DESC, provider_updated_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [provider],
    )) as { id: string; fetched_at: Date; provider_updated_at: Date | null; provider_next_update_at: Date | null; status: SnapshotStatus }[];
    return row
      ? { id: row.id, fetchedAt: row.fetched_at, providerUpdatedAt: row.provider_updated_at, providerNextUpdateAt: row.provider_next_update_at, status: row.status }
      : undefined;
  }
}

function toSnapshot(row: SnapshotRow): RateSnapshot {
  return {
    id: row.id,
    provider: row.provider,
    providerUpdatedAt: row.provider_updated_at,
    providerNextUpdateAt: row.provider_next_update_at,
    fetchedAt: row.fetched_at,
    // NUMERIC → text → Decimal: never through a JavaScript number.
    rates: new Map((row.rates ?? []).map((entry) => [entry.currency_code.trim(), dec(entry.rate)])),
  };
}
