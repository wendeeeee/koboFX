import { LosslessNumber, isLosslessNumber, parse } from 'lossless-json';
import { z } from 'zod';
import { Dec, MoneyDecimal } from '../../../common/money';


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
  readonly rates: ReadonlyMap<string, Dec>;
  readonly malformedRates: readonly string[];
}

export interface ParsedError {
  readonly kind: 'ERROR';
  readonly errorType: string;
}

export type ParsedResponse = ParsedRates | ParsedError | { readonly kind: 'INVALID'; readonly reason: string };

const losslessNumber = z.custom<LosslessNumber>((value) => isLosslessNumber(value), 'must be a JSON number');
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

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const MAXIMUM_RATE_TEXT_LENGTH = 40;
const MAXIMUM_EXPONENT = 30;

export function rateFromText(text: string): Dec | undefined {
  if (text.length > MAXIMUM_RATE_TEXT_LENGTH || !JSON_NUMBER.test(text)) return undefined;
  const exponent = /[eE]([+-]?\d+)$/.exec(text);
  if (exponent && Math.abs(Number.parseInt(exponent[1], 10)) > MAXIMUM_EXPONENT) return undefined;
  return new MoneyDecimal(text);
}

function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

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
