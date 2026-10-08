import { createHash } from 'node:crypto';
import { ProviderPlanProfile } from './provider-plan';

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

export enum FetchFailureKind {
  TRANSIENT = 'TRANSIENT',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  QUOTA_REACHED = 'QUOTA_REACHED',
  RATE_LIMITED = 'RATE_LIMITED',
  CREDENTIALS_REJECTED = 'CREDENTIALS_REJECTED',
  REQUEST_REJECTED = 'REQUEST_REJECTED',
  BUDGET_SPENT = 'BUDGET_SPENT',
}

const TRANSIENT_BASE_SECONDS = 60;
const TRANSIENT_CAP_SECONDS = 900;
const RATE_LIMITED_SECONDS = 21 * 60;
const REJECTED_SECONDS = 3_600;

function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(MINIMUM_POLL_GAP_SECONDS, Math.ceil((next - now.getTime()) / 1000));
}

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

export function pages(kind: FetchFailureKind): boolean {
  return kind !== FetchFailureKind.TRANSIENT && kind !== FetchFailureKind.INVALID_RESPONSE && kind !== FetchFailureKind.RATE_LIMITED;
}

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
