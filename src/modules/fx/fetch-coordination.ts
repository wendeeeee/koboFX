import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { RedisService } from '../../redis/redis.service';
import { ProviderRequestBudgetSpentError } from './fx.errors';
import { FetchFailureKind, backoffSeconds, budgetPeriods } from './poll-schedule';

export const FETCH_LOCK_KEY = 'fx:fetch-lock';
export const FETCH_BACKOFF_KEY = 'fx:fetch-backoff';
export const FETCH_FAILURES_KEY = 'fx:fetch-failures';
export const CATCH_UP_GATE_KEY = 'fx:catch-up';
export const budgetMonthKey = (month: string) => `fx:budget:month:${month}`;
export const budgetDayKey = (day: string) => `fx:budget:day:${day}`;

/** Minimum real interval between two synchronous catch-up fetches, across every instance. */
export const CATCH_UP_MINIMUM_INTERVAL_SECONDS = 60;

const ACQUIRE = `return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) and 1 or 0`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const EXISTS = `return redis.call('EXISTS', KEYS[1])`;
const GET = `return redis.call('GET', KEYS[1])`;
const DELETE = `return redis.call('DEL', unpack(KEYS))`;
const INCREMENT = `local n = redis.call('INCR', KEYS[1]) redis.call('EXPIRE', KEYS[1], ARGV[1]) return n`;
const SET_WITH_EXPIRY = `redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1`;

/**
 * Reserve one provider request against BOTH budgets, or refuse. Returns {status, month, day}:
 * status 1 = reserved; 0 = month spent; -2 = day spent; -1 = counters missing (seed first).
 */
const RESERVE = `
local month = redis.call('GET', KEYS[1])
local day = redis.call('GET', KEYS[2])
if not month or not day then return {-1, 0, 0} end
month = tonumber(month)
day = tonumber(day)
if month >= tonumber(ARGV[1]) then return {0, month, day} end
if day >= tonumber(ARGV[2]) then return {-2, month, day} end
redis.call('INCR', KEYS[1])
redis.call('INCR', KEYS[2])
return {1, month + 1, day + 1}
`;
const SEED = `
redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'NX', 'EX', ARGV[4])
return 1
`;
/**
 * Start a catch-up atomically: if a fetch holds the lock → 'LOCKED' (wait for it); if a
 * catch-up passed within the interval (on the injectable clock) → 'GATED'; else record the
 * pass AND take the fetch lock in the same step → 'STARTED'. One step, so no caller can
 * observe "gate passed, lock not yet taken".
 */
const BEGIN_CATCH_UP = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 'LOCKED' end
local last = redis.call('GET', KEYS[1])
if last and tonumber(ARGV[1]) < tonumber(last) + tonumber(ARGV[2]) then return 'GATED' end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 86400)
redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[4])
return 'STARTED'
`;

export type CatchUpStart = { readonly kind: 'STARTED'; readonly lockToken: string } | { readonly kind: 'LOCKED' } | { readonly kind: 'GATED' };

export interface BackoffState {
  readonly kind: FetchFailureKind;
  readonly until: Date;
  readonly consecutiveFailures: number;
}

export interface BudgetUsage {
  readonly month: string;
  readonly day: string;
  readonly monthUsed: number;
  readonly dayUsed: number;
  readonly monthlyBudget: number;
  readonly dailyBudget: number;
}

/**
 * The shared state that keeps provider calls independent of user traffic (Phase 6 §5.3,
 * §5.10), all in Redis so every API and worker instance agrees:
 *
 * - **the fetch lock** (`SET NX PX`, token-owned): one fetch at a time, poller and
 *   catch-up alike — the single flight;
 * - **the request budget**: every attempt, retries included, reserves one request against
 *   a monthly and a daily cap. A missing month or day counter (first use, a Redis flush) is
 *   seeded from `provider_calls`, the durable truth, so a flush cannot reset the budget;
 * - **the negative cache** (`fx:fetch-backoff`): after a failure no instance calls the
 *   provider until it expires — this is also the circuit breaker (open = present, fail
 *   fast; half-open = the one attempt after it expires; closed = a success clears it);
 * - **the catch-up gate**: at most one synchronous catch-up per minute, globally.
 *
 * Deadlines are read from the injectable `Clock` (stored in the values), never from Redis
 * TTLs, which are housekeeping only. When Redis is down every method throws
 * `DependencyUnavailableError`, and the fetcher makes no provider call at all (fail closed
 * on the quota).
 */
@Injectable()
export class FetchCoordination {
  constructor(
    private readonly redis: RedisService,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** A worst-case fetch (every attempt timing out, plus backoff sleeps) with room to write. */
  get lockTimeToLiveMilliseconds(): number {
    const fx = this.config.fx;
    return (1 + fx.readRetries) * fx.requestTimeoutMilliseconds + 2000 * fx.readRetries + 10_000;
  }

  async acquireFetchLock(): Promise<string | undefined> {
    const token = randomUUID();
    const acquired = await this.redis.evaluate(ACQUIRE, [FETCH_LOCK_KEY], [token, this.lockTimeToLiveMilliseconds]);
    return acquired === 1 ? token : undefined;
  }

  async releaseFetchLock(token: string): Promise<void> {
    await this.redis.evaluate(RELEASE, [FETCH_LOCK_KEY], [token]);
  }

  async isFetchInProgress(): Promise<boolean> {
    return (await this.redis.evaluate(EXISTS, [FETCH_LOCK_KEY], [])) === 1;
  }

  async backoff(): Promise<BackoffState | undefined> {
    const raw = await this.redis.evaluate(GET, [FETCH_BACKOFF_KEY], []);
    if (typeof raw !== 'string') return undefined;
    const state = JSON.parse(raw) as { kind: FetchFailureKind; until: number; consecutiveFailures: number };
    if (state.until <= this.clock.now().getTime()) return undefined;
    return { kind: state.kind, until: new Date(state.until), consecutiveFailures: state.consecutiveFailures };
  }

  /** Record a failure and open the breaker for the kind's backoff. Returns the new state. */
  async recordFailure(kind: FetchFailureKind): Promise<BackoffState> {
    const now = this.clock.now();
    const consecutiveFailures = Number(await this.redis.evaluate(INCREMENT, [FETCH_FAILURES_KEY], [7 * 86_400]));
    const seconds = backoffSeconds(kind, consecutiveFailures, now);
    const until = new Date(now.getTime() + seconds * 1000);
    await this.redis.evaluate(
      SET_WITH_EXPIRY,
      [FETCH_BACKOFF_KEY],
      [JSON.stringify({ kind, until: until.getTime(), consecutiveFailures }), (seconds + 3600) * 1000],
    );
    return { kind, until, consecutiveFailures };
  }

  /** A readable answer arrived (accepted or rejected): the breaker closes. */
  async recordSuccess(): Promise<void> {
    await this.redis.evaluate(DELETE, [FETCH_BACKOFF_KEY, FETCH_FAILURES_KEY], []);
  }

  /** Reserve one provider request, or throw `ProviderRequestBudgetSpentError` (nothing is sent). */
  async reserveRequest(): Promise<void> {
    const fx = this.config.fx;
    const periods = budgetPeriods(this.clock.now());
    const keys = [budgetMonthKey(periods.month), budgetDayKey(periods.day)];
    const budgets = [fx.monthlyRequestBudget, fx.dailyRequestBudget];
    let [status, monthUsed, dayUsed] = (await this.redis.evaluate(RESERVE, keys, budgets)) as number[];
    if (status === -1) {
      const seeds = await this.countRecordedRequests(periods.month, periods.day);
      await this.redis.evaluate(SEED, keys, [seeds.month, seeds.day, periods.secondsUntilMonthEnd + 86_400, periods.secondsUntilDayEnd + 3_600]);
      [status, monthUsed, dayUsed] = (await this.redis.evaluate(RESERVE, keys, budgets)) as number[];
    }
    if (status === 0) throw new ProviderRequestBudgetSpentError('MONTH', monthUsed, fx.monthlyRequestBudget);
    if (status === -2) throw new ProviderRequestBudgetSpentError('DAY', dayUsed, fx.dailyRequestBudget);
  }

  /** The quota gauge: requests reserved this period vs the budget. */
  async usage(): Promise<BudgetUsage> {
    const fx = this.config.fx;
    const periods = budgetPeriods(this.clock.now());
    const month = await this.redis.evaluate(GET, [budgetMonthKey(periods.month)], []);
    const day = await this.redis.evaluate(GET, [budgetDayKey(periods.day)], []);
    return {
      month: periods.month,
      day: periods.day,
      monthUsed: Number(month ?? 0),
      dayUsed: Number(day ?? 0),
      monthlyBudget: fx.monthlyRequestBudget,
      dailyBudget: fx.dailyRequestBudget,
    };
  }

  /** At most one synchronous catch-up per interval, globally; the winner already holds the fetch lock. */
  async beginCatchUp(): Promise<CatchUpStart> {
    const token = randomUUID();
    const result = await this.redis.evaluate(
      BEGIN_CATCH_UP,
      [CATCH_UP_GATE_KEY, FETCH_LOCK_KEY],
      [this.clock.now().getTime(), CATCH_UP_MINIMUM_INTERVAL_SECONDS * 1000, token, this.lockTimeToLiveMilliseconds],
    );
    if (result === 'STARTED') return { kind: 'STARTED', lockToken: token };
    return result === 'LOCKED' ? { kind: 'LOCKED' } : { kind: 'GATED' };
  }

  private async countRecordedRequests(month: string, day: string): Promise<{ month: number; day: number }> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT count(*) FILTER (WHERE created_at >= $2::timestamptz)::int AS month,
              count(*) FILTER (WHERE created_at >= $3::timestamptz)::int AS day
         FROM provider_calls
        WHERE provider = $1 AND direction = 'OUTBOUND' AND created_at >= $2::timestamptz`,
      [this.config.fx.providerName, `${month}-01T00:00:00Z`, `${day}T00:00:00Z`],
    )) as { month: number; day: number }[];
    return row;
  }
}
