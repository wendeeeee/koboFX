import { Injectable } from '@nestjs/common';
import { dec } from '../../common/money';
import { RedisService } from '../../redis/redis.service';
import { RateSnapshot } from './exchange-rate-snapshot.repository';

export const SNAPSHOT_CACHE_KEY = 'fx:snapshot:USD';

interface CachedSnapshot {
  readonly version: 1;
  readonly order: string;
  readonly id: string;
  readonly provider: string;
  readonly fetchedAt: number;
  readonly providerUpdatedAt: number;
  readonly providerNextUpdateAt: number;
  readonly rates: Record<string, string>;
}

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

export function snapshotOrder(snapshot: Pick<RateSnapshot, 'fetchedAt' | 'providerUpdatedAt' | 'id'>): string {
  const pad = (date: Date) => String(date.getTime()).padStart(15, '0');
  return `${pad(snapshot.fetchedAt)}:${pad(snapshot.providerUpdatedAt)}:${snapshot.id}`;
}

@Injectable()
export class RateCache {
  constructor(private readonly redis: RedisService) {}

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
      return undefined;
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
