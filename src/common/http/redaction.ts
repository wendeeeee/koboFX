/**
 * What never reaches `provider_calls` or a log (design §7.2: "secrets and card data are
 * redacted before insert"): any key naming a credential, a signature, card data or
 * contact details. Matched on the key name, at any depth; the whole value is replaced.
 */
const SENSITIVE_KEY = /token|secret|password|authorization|signature|card|pan$|^pan|cvv|cvc|expiry|exp_month|exp_year|email|phone/i;

export const REDACTED = '[REDACTED]';

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(inner);
  }
  return result;
}
