import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors';
import { canonicalJson } from '../../../common/interceptors/idempotency/request-hash';
import { ApprovalActionType } from '../approvals/approval.types';

/**
 * The payload of each action (Phase 10 plan §E.2): `payload JSONB` as the design says, but typed at the
 * boundary — strict (an unknown field is refused), amounts as digit strings of minor units (a JSON number has
 * passed through a float), ids as UUIDs, times ISO-8601 with an offset. What is stored is the CANONICAL form
 * this returns (and its hash): the executor re-parses it at execution with the same schema.
 */
const uuid = z.string().uuid();
const minorUnits = z.string().regex(/^[1-9]\d{0,17}$/, 'must be a positive whole number of minor units, as a string');
const currency = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code');
const instant = z.string().datetime({ offset: true });
/** A USD-based mid: a positive plain decimal, at most 40 characters (Phase 6's rule for provider rates). */
const rate = z.string().max(40).regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'must be a plain positive decimal, as a string');

export enum CorrectionMode {
  /** A settlement line in CLEARING whose payer an operator identified: credit that user. */
  CLEARING_TO_USER = 'CLEARING_TO_USER',
  /** A line in CLEARING that is really one of our deposits (amount mismatch, or settled before it posted). */
  SETTLE_DEPOSIT_FROM_CLEARING = 'SETTLE_DEPOSIT_FROM_CLEARING',
  /** A line in CLEARING the PSP paid us but we owe back (a duplicate, an unknown or foreign-currency line). */
  CLEARING_TO_PSP_PAYABLE = 'CLEARING_TO_PSP_PAYABLE',
  /** A partial chargeback parked since Phase 5: debit the user for the disputed amount. */
  PARTIAL_CHARGEBACK = 'PARTIAL_CHARGEBACK',
}

export enum RateOverrideMode {
  ACCEPT_REJECTED_SNAPSHOT = 'ACCEPT_REJECTED_SNAPSHOT',
  MANUAL_RATE = 'MANUAL_RATE',
}

export enum RoleChangeOperation {
  GRANT = 'GRANT',
  REVOKE = 'REVOKE',
}

const correction = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal(CorrectionMode.CLEARING_TO_USER), breakId: uuid, userId: uuid, valueTime: instant }).strict(),
  z.object({ mode: z.literal(CorrectionMode.SETTLE_DEPOSIT_FROM_CLEARING), breakId: uuid, valueTime: instant }).strict(),
  z.object({ mode: z.literal(CorrectionMode.CLEARING_TO_PSP_PAYABLE), breakId: uuid, valueTime: instant }).strict(),
  z.object({ mode: z.literal(CorrectionMode.PARTIAL_CHARGEBACK), breakId: uuid, valueTime: instant }).strict(),
]);

const writeOff = z.object({ userId: uuid, currency, amount: minorUnits, valueTime: instant }).strict();

const rateOverride = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal(RateOverrideMode.ACCEPT_REJECTED_SNAPSHOT), snapshotId: uuid }).strict(),
  z
    .object({
      mode: z.literal(RateOverrideMode.MANUAL_RATE),
      rates: z.record(currency, rate).refine((rates) => Object.keys(rates).length > 0, 'needs at least one rate'),
      validForSeconds: z.number().int().min(60).max(86_400),
    })
    .strict(),
]);

const spreadChange = z
  .object({
    sourceCurrency: currency,
    targetCurrency: currency,
    spreadBasisPoints: z.number().int().min(0).max(9_999).optional(),
    minimumSourceAmount: minorUnits.optional(),
  })
  .strict()
  .refine((change) => change.spreadBasisPoints !== undefined || change.minimumSourceAmount !== undefined, {
    message: 'change the spread, the minimum, or both',
  })
  .refine((change) => change.sourceCurrency !== change.targetCurrency, { message: 'a pair has two different currencies' });

const userTarget = z.object({ userId: uuid }).strict();

/** A calendar month, UTC. Stored with its half-open bounds, which the SQL function reads. */
const closePeriod = z
  .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM') })
  .strict()
  .transform(({ month }) => {
    const [year, monthNumber] = month.split('-').map((part) => Number.parseInt(part, 10)) as [number, number];
    return {
      month,
      periodStart: new Date(Date.UTC(year, monthNumber - 1, 1)).toISOString(),
      periodEnd: new Date(Date.UTC(year, monthNumber, 1)).toISOString(),
    };
  });

const roleChange = z
  .object({
    userId: uuid,
    role: z.enum(['ADMIN', 'SECURITY']),
    operation: z.nativeEnum(RoleChangeOperation),
  })
  .strict();

const resolveBreak = z.object({ breakId: uuid }).strict();

export const ACTION_PAYLOAD_SCHEMAS = {
  [ApprovalActionType.CORRECTION]: correction,
  [ApprovalActionType.WRITE_OFF]: writeOff,
  [ApprovalActionType.RATE_OVERRIDE]: rateOverride,
  [ApprovalActionType.SPREAD_CHANGE]: spreadChange,
  [ApprovalActionType.SUSPEND_USER]: userTarget,
  [ApprovalActionType.REINSTATE_USER]: userTarget,
  [ApprovalActionType.CLOSE_PERIOD]: closePeriod,
  [ApprovalActionType.ROLE_CHANGE]: roleChange,
  [ApprovalActionType.RESOLVE_BREAK]: resolveBreak,
} as const;

export type CorrectionPayload = z.infer<typeof correction>;
export type WriteOffPayload = z.infer<typeof writeOff>;
export type RateOverridePayload = z.infer<typeof rateOverride>;
export type SpreadChangePayload = z.infer<typeof spreadChange>;
export type UserTargetPayload = z.infer<typeof userTarget>;
export type ClosePeriodPayload = z.infer<typeof closePeriod>;
export type RoleChangePayload = z.infer<typeof roleChange>;
export type ResolveBreakPayload = z.infer<typeof resolveBreak>;

export interface ActionPayloads {
  [ApprovalActionType.CORRECTION]: CorrectionPayload;
  [ApprovalActionType.WRITE_OFF]: WriteOffPayload;
  [ApprovalActionType.RATE_OVERRIDE]: RateOverridePayload;
  [ApprovalActionType.SPREAD_CHANGE]: SpreadChangePayload;
  [ApprovalActionType.SUSPEND_USER]: UserTargetPayload;
  [ApprovalActionType.REINSTATE_USER]: UserTargetPayload;
  [ApprovalActionType.CLOSE_PERIOD]: ClosePeriodPayload;
  [ApprovalActionType.ROLE_CHANGE]: RoleChangePayload;
  [ApprovalActionType.RESOLVE_BREAK]: ResolveBreakPayload;
}

/**
 * Validate and canonicalise an action's payload. For CLOSE_PERIOD the stored form is `{month, periodStart,
 * periodEnd}` — parsing that again yields the same thing (the schema accepts the canonical form back).
 */
export function parseActionPayload<T extends ApprovalActionType>(actionType: T, raw: unknown): ActionPayloads[T] {
  const schema = ACTION_PAYLOAD_SCHEMAS[actionType] as unknown as z.ZodType<ActionPayloads[T], z.ZodTypeDef, unknown>;
  const result = schema.safeParse(actionType === ApprovalActionType.CLOSE_PERIOD ? requestedMonth(raw) : raw);
  if (!result.success) {
    throw new ValidationError('The action payload is not valid.', {
      actionType,
      problems: result.error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`),
    });
  }
  return result.data;
}

/**
 * CLOSE_PERIOD accepts `{month}` — or its own canonical form back (`{month, periodStart, periodEnd}` with exactly the
 * bounds `month` derives), so the stored payload re-parses at execution. Anything else goes to the strict schema as-is
 * (and an unknown field is refused there).
 */
function requestedMonth(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('periodStart' in raw || 'periodEnd' in raw)) return raw;
  const { month, periodStart, periodEnd, ...rest } = raw as Record<string, unknown>;
  const derived = closePeriod.safeParse({ month });
  if (Object.keys(rest).length > 0 || !derived.success || derived.data.periodStart !== periodStart || derived.data.periodEnd !== periodEnd) return raw;
  return { month };
}

/** The value of `approvals.payload_hash`: sha256 over the canonical JSON (keys sorted). */
export function payloadHash(payload: object): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/** The break a payload names, if any (`approvals.break_id`). */
export function breakIdOf(payload: object): string | null {
  const candidate = (payload as { breakId?: unknown }).breakId;
  return typeof candidate === 'string' ? candidate : null;
}
