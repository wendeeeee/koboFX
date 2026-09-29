import { Injectable } from '@nestjs/common';
import { dec } from '../../common/money';
import { RedisService } from '../../redis/redis.service';
import { RateSnapshot } from './exchange-rate-snapshot.repository';

export const SNAPSHOT_CACHE_KEY = 'fx:snapshot:USD';

/** The cached form: the WHOLE accepted snapshot in one value, rates as decimal strings. */
interface CachedSnapshot {
  readonly version: 1;
  /** Zero-padded `fetchedAt` + id: the compare-and-set order (newer fetch wins). */
  readonly order: string;
  readonly id: string;
  readonly provider: string;
  readonly fetchedAt: number;
  readonly providerUpdatedAt: number;
  readonly providerNextUpdateAt: number;
  readonly rates: Record<string, string>;
}

/**
 * Replace the cached snapshot only if the offered one is newer — a slow fetcher or a
 * re-seed from the database can never overwrite a newer snapshot with an older one. One
 * `SET` of one value: a reader sees one whole fetch or the other, never a mix.
 */
const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, decoded = pcall(cjson.decode, current)
  if ok and type(decoded) == 'table' and decoded.order and decoded.order >= ARGV[2] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
`;

const READ = `return redis.call('GET', KEYS[1])`;

export function snapshotOrder(snapshot: Pick<RateSnapshot, 'fetchedAt' | 'id'>): string {
  return `${String(snapshot.fetchedAt.getTime()).padStart(15, '0')}:${snapshot.id}`;
}

/**
 * Redis `fx:snapshot:USD` (design §7.4; Phase 6 §5.15): the shared cache every API and
 * worker instance reads, so serving rates and quotes costs no provider call. Written ONLY
 * by the fetcher (the poller, or the single-flighted catch-up) and the poller's re-seed
 * from the database — never by a request handler. Its TTL is housekeeping (display window
 * + 1h); freshness is always read from the snapshot's own fields.
 *
 * Every failure is `DependencyUnavailableError` (RedisService): callers fall back to the
 * database snapshot (§16).
 */
@Injectable()
export class RateCache {
  constructor(private readonly redis: RedisService) {}

  /** Returns true if the snapshot was written (it was newer than the cached one). */
  async offer(snapshot: RateSnapshot, timeToLiveSeconds: number): Promise<boolean> {
    const value: CachedSnapshot = {
      version: 1,
      order: snapshotOrder(snapshot),
      id: snapshot.id,
      provider: snapshot.provider,
      fetchedAt: snapshot.fetchedAt.getTime(),
      providerUpdatedAt: snapshot.providerUpdatedAt.getTime(),
      providerNextUpdateAt: snapshot.providerNextUpdateAt.getTime(),
      rates: Object.fromEntries([...snapshot.rates].map(([currency, rate]) => [currency, rate.toFixed()])),
    };
    const written = await this.redis.evaluate(COMPARE_AND_SET, [SNAPSHOT_CACHE_KEY], [JSON.stringify(value), value.order, Math.max(1, timeToLiveSeconds)]);
    return written === 1;
  }

  async read(): Promise<RateSnapshot | undefined> {
    const raw = await this.redis.evaluate(READ, [SNAPSHOT_CACHE_KEY], []);
    if (typeof raw !== 'string') return undefined;
    let cached: CachedSnapshot;
    try {
      cached = JSON.parse(raw) as CachedSnapshot;
    } catch {
      return undefined; // unreadable: treated as a miss, the database is the durable record
    }
    if (cached.version !== 1 || typeof cached.rates !== 'object' || cached.rates === null) return undefined;
    return {
      id: cached.id,
      provider: cached.provider,
      fetchedAt: new Date(cached.fetchedAt),
      providerUpdatedAt: new Date(cached.providerUpdatedAt),
      providerNextUpdateAt: new Date(cached.providerNextUpdateAt),
      rates: new Map(Object.entries(cached.rates).map(([currency, rate]) => [currency, dec(rate)])),
    };
  }
}
