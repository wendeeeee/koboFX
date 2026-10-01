import { isLosslessNumber, parse as parseLossless, stringify as stringifyLossless } from 'lossless-json';

/**
 * What never reaches `provider_calls` or a log (design §7.2: "secrets and card data are
 * redacted before insert"): any key naming a credential, a signature, card data or
 * contact details. Matched on the key name, at any depth; the whole value is replaced.
 */
const SENSITIVE_KEY = /token|secret|password|authorization|signature|card|pan$|^pan|cvv|cvc|expiry|exp_month|exp_year|email|phone/i;

export const REDACTED = '[REDACTED]';

/**
 * Redact a JSON text WITHOUT passing its numbers through a float (a provider that sends money as JSON numbers —
 * Paystack): parsed with `lossless-json`, every number kept as its source text, sensitive keys (the shared rule plus
 * `extraKeys`) replaced, then re-serialised. Returns undefined when the text is not JSON.
 */
export function redactJsonTextLosslessly(text: string, extraKeys: RegExp | undefined): string | undefined {
  let parsed: unknown;
  try {
    parsed = parseLossless(text);
  } catch {
    return undefined;
  }
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'object' || value === null || isLosslessNumber(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) || extraKeys?.test(key) ? REDACTED : walk(inner);
    }
    return result;
  };
  return stringifyLossless(walk(parsed)) ?? 'null';
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(inner);
  }
  return result;
}
