import { createHash } from 'node:crypto';
import { ProviderPlanProfile } from './provider-plan';

/**
 * When to ask the provider again (Phase 6 §5.3) — pure, so a simulated month can prove it.
 *
 * Fetching more often than the provider publishes buys nothing, so the next poll is just
 * after the publication the last response announced (`time_next_update_unix`), plus a
 * deterministic jitter of 30–90s (derived from the snapshot id, so every worker agrees
 * and the decision does not flap between ticks). Guards:
 * - the provider is late (its announced time had already passed when we fetched) →
 *   retry after the plan's `latePublicationRetrySeconds`;
 * - never sooner than `MINIMUM_POLL_GAP_SECONDS` after a fetch;
 * - never later than one cadence + the publication grace after a fetch — a garbage
 *   far-future "next update" cannot silence us (real announcements run slightly over one
 *   cadence: the open endpoint announced 86,790s for a daily cadence). Because the
 *   jitter (≤ 90s) is shorter than every plan's grace, the poll always lands before the
 *   current snapshot stops being executable.
 * Failures are paced separately, by `backoffSeconds` (the negative cache).
 */
export interface LatestFetch {
  readonly snapshotId: string;
  readonly fetchedAt: Date;
  readonly providerUpdatedAt: Date | null;
  readonly providerNextUpdateAt: Date | null;
}

export const MINIMUM_POLL_GAP_SECONDS = 60;
const JITTER_MINIMUM_SECONDS = 30;
const JITTER_SPAN_SECONDS = 61;

export function jitterSeconds(snapshotId: string): number {
  const digest = createHash('sha256').update(snapshotId).digest();
  return JITTER_MINIMUM_SECONDS + (digest.readUInt32BE(0) % JITTER_SPAN_SECONDS);
}

export function nextPollAt(latest: LatestFetch | undefined, profile: ProviderPlanProfile): Date {
  if (!latest) return new Date(0);
  const fetched = latest.fetchedAt.getTime();
  const next = latest.providerNextUpdateAt?.getTime();
  let due: number;
  if (next === undefined || latest.providerUpdatedAt === null || next <= fetched) {
    due = fetched + profile.latePublicationRetrySeconds * 1000;
  } else {
    due = next + jitterSeconds(latest.snapshotId) * 1000;
  }
  due = Math.max(due, fetched + MINIMUM_POLL_GAP_SECONDS * 1000);
  due = Math.min(due, fetched + (profile.cadenceSeconds + profile.publicationGraceSeconds) * 1000);
  return new Date(due);
}

export function isPollDue(now: Date, latest: LatestFetch | undefined, profile: ProviderPlanProfile): boolean {
  return now.getTime() >= nextPollAt(latest, profile).getTime();
}

/** Why a fetch failed, as far as pacing the next attempt is concerned. */
export enum FetchFailureKind {
  /** Timeout, network error, 5xx: try again soon, backing off. */
  TRANSIENT = 'TRANSIENT',
  /** A response we could not read. */
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  /** `quota-reached`: the plan's monthly quota is spent. Page. */
  QUOTA_REACHED = 'QUOTA_REACHED',
  /** HTTP 429 from the open-access endpoint: the IP is locked out for 20 minutes. */
  RATE_LIMITED = 'RATE_LIMITED',
  /** `invalid-key`, `inactive-account`: nothing changes until the configuration does. Page. */
  CREDENTIALS_REJECTED = 'CREDENTIALS_REJECTED',
  /** `unsupported-code`, `malformed-request`, another refusal: our bug. Page. */
  REQUEST_REJECTED = 'REQUEST_REJECTED',
  /** Our own request budget for the day or month is spent. Page. */
  BUDGET_SPENT = 'BUDGET_SPENT',
}

const TRANSIENT_BASE_SECONDS = 60;
const TRANSIENT_CAP_SECONDS = 900;
/** The open endpoint's documented lockout is 20 minutes; wait one more. */
const RATE_LIMITED_SECONDS = 21 * 60;
const REJECTED_SECONDS = 3_600;

function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(MINIMUM_POLL_GAP_SECONDS, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * How long no instance may call the provider after a failure (the negative cache, which
 * doubles as the circuit breaker — Phase 6 §5.10). `consecutiveFailures` ≥ 1.
 */
export function backoffSeconds(kind: FetchFailureKind, consecutiveFailures: number, now: Date): number {
  switch (kind) {
    case FetchFailureKind.TRANSIENT:
    case FetchFailureKind.INVALID_RESPONSE:
      return Math.min(TRANSIENT_CAP_SECONDS, TRANSIENT_BASE_SECONDS * 2 ** Math.min(10, Math.max(0, consecutiveFailures - 1)));
    case FetchFailureKind.RATE_LIMITED:
      return RATE_LIMITED_SECONDS;
    case FetchFailureKind.QUOTA_REACHED:
    case FetchFailureKind.BUDGET_SPENT:
      return secondsUntilNextUtcDay(now);
    case FetchFailureKind.CREDENTIALS_REJECTED:
    case FetchFailureKind.REQUEST_REJECTED:
      return REJECTED_SECONDS;
  }
}

/** Failures that need a human (alerted at error level with `alert: true`). */
export function pages(kind: FetchFailureKind): boolean {
  return kind !== FetchFailureKind.TRANSIENT && kind !== FetchFailureKind.INVALID_RESPONSE && kind !== FetchFailureKind.RATE_LIMITED;
}

/** The request-budget periods a moment falls in (UTC). */
export function budgetPeriods(now: Date): { readonly month: string; readonly day: string; readonly secondsUntilMonthEnd: number; readonly secondsUntilDayEnd: number } {
  const iso = now.toISOString();
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const dayEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return {
    month: iso.slice(0, 7),
    day: iso.slice(0, 10),
    secondsUntilMonthEnd: Math.ceil((monthEnd - now.getTime()) / 1000),
    secondsUntilDayEnd: Math.ceil((dayEnd - now.getTime()) / 1000),
  };
}
