import { LosslessNumber, isLosslessNumber, parse } from 'lossless-json';
import { z } from 'zod';
import { Dec, MoneyDecimal } from '../../../common/money';

/**
 * Reading ExchangeRate-API v6 responses (design §7.2 points 1–2; handbook: "don't trust
 * the schema", "expect imperfect engineering").
 *
 * - **No float, ever.** `lossless-json` hands every JSON number over as its source text;
 *   a rate goes text → `Decimal` without touching an IEEE-754 double (Node 20's
 *   `JSON.parse` has no access to the source text of a number).
 * - **Only the fields we use** are validated: `result`, `base_code`, the two publication
 *   times, and the rates of the currencies we know. Anything else — `provider`,
 *   `documentation`, `terms_of_use` vs `terms-of-use`, `time_eol_unix`, 160 currencies we
 *   don't trade — is ignored, so a provider change there can't become our outage.
 * - Both endpoints are read: the keyed v6 endpoint calls the rates `conversion_rates`, the
 *   open-access endpoint calls them `rates`. Exactly one must be present.
 * - Structural problems make the response INVALID (nothing is stored but the
 *   `provider_calls` evidence). A known currency's rate that is absent or not a number is
 *   reported per currency and judged by the sanity checks, so a broken rate becomes a
 *   REJECTED snapshot — evidence — rather than disappearing.
 */

/** Documented `error-type` values (checked 2026-09-29). Anything else is kept verbatim. */
export enum ExchangeRateApiErrorType {
  UNSUPPORTED_CODE = 'unsupported-code',
  MALFORMED_REQUEST = 'malformed-request',
  INVALID_KEY = 'invalid-key',
  INACTIVE_ACCOUNT = 'inactive-account',
  QUOTA_REACHED = 'quota-reached',
}

export interface ParsedRates {
  readonly kind: 'SUCCESS';
  readonly baseCurrency: string;
  readonly providerUpdatedAt: Date;
  readonly providerNextUpdateAt: Date;
  /** Known currencies whose rate is a JSON number, exactly as sent (may be ≤ 0: sanity decides). */
  readonly rates: ReadonlyMap<string, Dec>;
  /** Known currencies whose rate is present but not a usable number (a string, null, absurdly long…). */
  readonly malformedRates: readonly string[];
}

export interface ParsedError {
  readonly kind: 'ERROR';
  readonly errorType: string;
}

export type ParsedResponse = ParsedRates | ParsedError | { readonly kind: 'INVALID'; readonly reason: string };

const losslessNumber = z.custom<LosslessNumber>((value) => isLosslessNumber(value), 'must be a JSON number');
/** Unix seconds, as an integer JSON number of plausible size. */
const unixSeconds = losslessNumber.refine((value) => /^\d{1,11}$/.test(value.value), 'must be integer unix seconds');
const rateTable = z.record(z.string(), z.unknown());

const successSchema = z.object({
  result: z.literal('success'),
  base_code: z.string().regex(/^[A-Z]{3}$/),
  time_last_update_unix: unixSeconds,
  time_next_update_unix: unixSeconds,
  conversion_rates: rateTable.optional(),
  rates: rateTable.optional(),
});

const errorSchema = z.object({
  result: z.literal('error'),
  'error-type': z.string().min(1).max(64),
});

/** JSON number grammar; exponent notation is exact in decimal (`1.2e-5` = 0.000012). */
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
/** A rate longer than this is not a rate. It also bounds the exponent Decimal must expand. */
const MAXIMUM_RATE_TEXT_LENGTH = 40;
const MAXIMUM_EXPONENT = 30;

/** Exact decimal from a JSON number's source text, or undefined if it is not a plausible number. */
export function rateFromText(text: string): Dec | undefined {
  if (text.length > MAXIMUM_RATE_TEXT_LENGTH || !JSON_NUMBER.test(text)) return undefined;
  const exponent = /[eE]([+-]?\d+)$/.exec(text);
  if (exponent && Math.abs(Number.parseInt(exponent[1], 10)) > MAXIMUM_EXPONENT) return undefined;
  return new MoneyDecimal(text);
}

function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Parse a response body (raw text) for the currencies we know (`knownCurrencies`).
 * Never throws: every outcome is a value.
 */
export function parseLatestResponse(text: string, knownCurrencies: readonly string[]): ParsedResponse {
  let tree: unknown;
  try {
    tree = parse(text);
  } catch {
    return { kind: 'INVALID', reason: 'body is not JSON' };
  }
  if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) return { kind: 'INVALID', reason: 'body is not a JSON object' };

  const error = errorSchema.safeParse(tree);
  if (error.success) return { kind: 'ERROR', errorType: error.data['error-type'] };

  const success = successSchema.safeParse(tree);
  if (!success.success) return { kind: 'INVALID', reason: `unexpected response: ${describe(success.error)}` };
  const body = success.data;
  if ((body.conversion_rates === undefined) === (body.rates === undefined)) {
    return { kind: 'INVALID', reason: 'expected exactly one of conversion_rates or rates' };
  }
  const table = (body.conversion_rates ?? body.rates) as Record<string, unknown>;

  const rates = new Map<string, Dec>();
  const malformedRates: string[] = [];
  for (const currency of knownCurrencies) {
    if (!Object.prototype.hasOwnProperty.call(table, currency)) continue;
    const value = table[currency];
    const rate = isLosslessNumber(value) ? rateFromText(value.value) : undefined;
    if (rate === undefined) malformedRates.push(currency);
    else rates.set(currency, rate);
  }
  return {
    kind: 'SUCCESS',
    baseCurrency: body.base_code,
    providerUpdatedAt: new Date(Number(body.time_last_update_unix.value) * 1000),
    providerNextUpdateAt: new Date(Number(body.time_next_update_unix.value) * 1000),
    rates,
    malformedRates,
  };
}
