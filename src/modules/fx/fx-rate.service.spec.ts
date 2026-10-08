import { Clock } from '../../common/clock';
import { DependencyUnavailableError, ErrorCode } from '../../common/errors';
import { dec } from '../../common/money';
import { AppConfig } from '../../config/configuration';
import { ExchangeRateSnapshotRepository, RateSnapshot } from './exchange-rate-snapshot.repository';
import { CatchUpStart, FetchCoordination } from './fetch-coordination';
import { RateTier } from './freshness';
import { FetchOutcome, FxRateFetcher } from './fx-rate-fetcher';
import { FxRateService } from './fx-rate.service';
import { RateCache } from './rate-cache';

class ManualClock extends Clock {
  constructor(public current: Date) {
    super();
  }
  now(): Date {
    return this.current;
  }
}

const T0 = new Date('2026-09-29T12:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function snapshot(id: string, publishedSecondsAgo = 60, nextInSeconds = 300): RateSnapshot {
  return {
    id,
    provider: 'exchange-rate-api',
    providerUpdatedAt: at(-publishedSecondsAgo),
    providerNextUpdateAt: at(nextInSeconds),
    fetchedAt: T0,
    rates: new Map([
      ['USD', dec('1')],
      ['NGN', dec('1329.375909')],
    ]),
  };
}

function setup(options: { localCacheMilliseconds?: number } = {}) {
  const clock = new ManualClock(T0);
  const state: {
    redis: RateSnapshot | undefined | Error;
    database: RateSnapshot | undefined;
    catchUp: CatchUpStart;
    fetchOutcome: FetchOutcome;
    inProgress: boolean[];
  } = {
    redis: undefined,
    database: undefined,
    catchUp: { kind: 'GATED' },
    fetchOutcome: { kind: 'FAILED', failure: 'TRANSIENT' as never, detail: '' },
    inProgress: [],
  };
  const calls = { redisReads: 0, databaseReads: 0, fetches: 0 };
  const cache = {
    read: async () => {
      calls.redisReads += 1;
      if (state.redis instanceof Error) throw state.redis;
      return state.redis;
    },
  } as unknown as RateCache;
  const snapshots = {
    latestServable: async () => {
      calls.databaseReads += 1;
      return state.database;
    },
  } as unknown as ExchangeRateSnapshotRepository;
  const fetcher = {
    fetch: async () => {
      calls.fetches += 1;
      if (state.fetchOutcome.kind === 'ACCEPTED') state.redis = state.fetchOutcome.snapshot;
      return state.fetchOutcome;
    },
  } as unknown as FxRateFetcher;
  const coordination = {
    beginCatchUp: async () => state.catchUp,
    isFetchInProgress: async () => state.inProgress.shift() ?? false,
  } as unknown as FetchCoordination;
  const config = {
    fx: {
      providerName: 'exchange-rate-api',
      executableMaximumAgeSeconds: 420,
      displayMaximumAgeSeconds: 900,
      publicationGraceSeconds: 120,
      localCacheMilliseconds: options.localCacheMilliseconds ?? 0,
    },
  } as unknown as AppConfig;
  const service = new FxRateService(cache, snapshots, fetcher, coordination, clock, config);
  return { service, state, calls, clock };
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe('FxRateService: the read path', () => {
  it('Redis first; when Redis is empty or down, the latest database snapshot', async () => {
    const { service, state } = setup();
    state.redis = snapshot('in-redis');
    state.database = snapshot('in-database');
    expect(await service.current()).toMatchObject({ source: 'REDIS', snapshot: { id: 'in-redis' } });
    state.redis = undefined;
    expect(await service.current()).toMatchObject({ source: 'DATABASE', snapshot: { id: 'in-database' } });
    state.redis = new DependencyUnavailableError('redis down');
    expect(await service.current()).toMatchObject({ source: 'DATABASE', snapshot: { id: 'in-database' } });
    state.database = undefined;
    expect(await service.current()).toBeUndefined();
  });

  it('a non-Redis failure of the cache is not swallowed', async () => {
    const { service, state } = setup();
    state.redis = new Error('a bug');
    await expect(service.current()).rejects.toThrow('a bug');
  });

  it('the per-process copy is never older than Redis beyond its stated bound', async () => {
    const { service, state, calls } = setup({ localCacheMilliseconds: 80 });
    state.redis = snapshot('first');
    expect((await service.current())!.source).toBe('REDIS');
    state.redis = snapshot('second');
    const served = await service.current();
    expect(served).toMatchObject({ source: 'MEMORY', snapshot: { id: 'first' } });
    await sleep(90);
    expect(await service.current()).toMatchObject({ source: 'REDIS', snapshot: { id: 'second' } });
    expect(calls.redisReads).toBe(2);
    state.redis = new DependencyUnavailableError('down');
    state.database = snapshot('db');
    await sleep(90);
    await Promise.all(Array.from({ length: 20 }, () => service.current()));
    expect(calls.databaseReads).toBe(1);
  });

  it('tiers are computed on the clock at read time', async () => {
    const { service, state, clock } = setup();
    state.redis = snapshot('s');
    expect((await service.current())!.freshness.tier).toBe(RateTier.EXECUTABLE);
    clock.current = at(361);
    expect((await service.current())!.freshness.tier).toBe(RateTier.DISPLAY_ONLY);
    clock.current = at(841);
    expect((await service.current())!.freshness.tier).toBe(RateTier.UNSERVABLE);
  });
});

describe('FxRateService: display, execution and the catch-up', () => {
  it('displayable(): display-only is served as is, without any catch-up', async () => {
    const { service, state, clock, calls } = setup();
    state.redis = snapshot('s');
    clock.current = at(500);
    state.catchUp = { kind: 'STARTED', lockToken: 't' };
    expect((await service.displayable()).freshness.tier).toBe(RateTier.DISPLAY_ONLY);
    expect(calls.fetches).toBe(0);
  });

  it('displayable(): nothing displayable → the catch-up winner fetches once and serves the result', async () => {
    const { service, state, calls } = setup();
    state.catchUp = { kind: 'STARTED', lockToken: 't' };
    state.fetchOutcome = { kind: 'ACCEPTED', snapshot: snapshot('fresh') };
    expect(await service.displayable()).toMatchObject({ snapshot: { id: 'fresh' }, freshness: { tier: RateTier.EXECUTABLE } });
    expect(calls.fetches).toBe(1);
  });

  it('displayable(): a failed or gated catch-up → 503 FX_RATE_UNAVAILABLE', async () => {
    const failed = setup();
    failed.state.catchUp = { kind: 'STARTED', lockToken: 't' };
    await expect(failed.service.displayable()).rejects.toMatchObject({ code: ErrorCode.FX_RATE_UNAVAILABLE });
    const gated = setup();
    gated.state.database = snapshot('ancient', 10_000);
    await expect(gated.service.displayable()).rejects.toMatchObject({ code: ErrorCode.FX_RATE_UNAVAILABLE, details: { asOf: at(-10_000).toISOString() } });
    expect(gated.calls.fetches).toBe(0);
  });

  it('a loser waits for the winner\'s newer snapshot; stops waiting when no fetch is in progress', async () => {
    const waiting = setup();
    waiting.state.catchUp = { kind: 'LOCKED' };
    waiting.state.inProgress = [true, true, true];
    setTimeout(() => {
      waiting.state.redis = snapshot('winner');
    }, 150);
    expect(await waiting.service.displayable()).toMatchObject({ snapshot: { id: 'winner' } });

    const abandoned = setup();
    abandoned.state.catchUp = { kind: 'LOCKED' };
    abandoned.state.inProgress = [false];
    const started = Date.now();
    await expect(abandoned.service.displayable()).rejects.toMatchObject({ code: ErrorCode.FX_RATE_UNAVAILABLE });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('prepareExecutable() never throws; requireExecutable() re-judges on the clock at the moment of use', async () => {
    const { service, state, clock } = setup();
    state.redis = new Error('a bug');
    await expect(service.prepareExecutable()).resolves.toBeUndefined();
    expect(() => service.requireExecutable(undefined)).toThrow(expect.objectContaining({ code: ErrorCode.FX_RATE_UNAVAILABLE }));

    state.redis = snapshot('s');
    const prepared = await service.prepareExecutable();
    expect(prepared!.freshness.tier).toBe(RateTier.EXECUTABLE);
    expect(service.requireExecutable(prepared).freshness.tier).toBe(RateTier.EXECUTABLE);
    clock.current = at(361);
    expect(() => service.requireExecutable(prepared)).toThrow(
      expect.objectContaining({ code: ErrorCode.FX_RATE_STALE, retryAfterSeconds: 30, details: expect.objectContaining({ rateAgeSeconds: 421 }) }),
    );
  });

  it('prepareExecutable(): not executable → one catch-up; Redis down during it → what we had', async () => {
    const { service, state, clock } = setup();
    state.redis = snapshot('old');
    clock.current = at(361);
    state.catchUp = { kind: 'STARTED', lockToken: 't' };
    state.fetchOutcome = { kind: 'ACCEPTED', snapshot: { ...snapshot('new', 0, 600), providerUpdatedAt: at(360) } };
    expect((await service.prepareExecutable())!.snapshot.id).toBe('new');

    const down = setup();
    down.state.database = snapshot('db');
    down.clock.current = at(361);
    (down.service as unknown as { coordination: { beginCatchUp: () => Promise<never> } }).coordination.beginCatchUp = async () => {
      throw new DependencyUnavailableError('down');
    };
    expect((await down.service.prepareExecutable())!.snapshot.id).toBe('db');
  });
});
