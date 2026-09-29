import { Dec, MoneyDecimal } from '../../common/money';
import { ParsedRates } from './providers/exchange-rate-api.responses';

/**
 * Sanity checks on a fetched snapshot (design §7.4, Phase 6 decision §5.5). With one
 * provider there is no cross-check, so plausibility and history are the only defences
 * (accepted risk, recorded: §16's "providers disagree" row no longer applies).
 *
 * The whole fetch is rejected if any rule fails — a response with one broken rate is
 * evidence that the response is broken. A rejected fetch is stored as a REJECTED snapshot
 * and alerted, never served; the last accepted snapshot keeps ageing honestly.
 *
 * - base must be USD and USD must be exactly 1;
 * - every ACTIVE currency present, a number, > 0 and inside its configured bounds (loose,
 *   order-of-magnitude; required for every active currency);
 * - the provider's publication time is not in the future (60s skew) and not older than
 *   the last accepted one (time never runs backwards); its announced next publication is
 *   after it and within two cadences (a garbage "next" would keep a rate current forever);
 * - no active currency moved more than the jump threshold (global, or a per-currency
 *   override) from the last ACCEPTED snapshot. The first fetch has no history: bounds only.
 *   A genuine move beyond the threshold is NEVER auto-accepted (not even when repeated —
 *   a persistently broken provider would pass that test): the currency halts until a
 *   four-eyes RATE_OVERRIDE (Phase 10).
 * Inactive currencies are not judged ("a rate for a currency we don't use is ignored").
 */
export interface SanityContext {
  readonly now: Date;
  readonly activeCurrencies: readonly string[];
  readonly bounds: ReadonlyMap<string, { readonly minimum: Dec; readonly maximum: Dec }>;
  readonly maximumJumpRatio: Dec;
  readonly jumpRatioOverrides: ReadonlyMap<string, Dec>;
  readonly cadenceSeconds: number;
  /** The last ACCEPTED snapshot, if any. */
  readonly previous?: { readonly providerUpdatedAt: Date; readonly rates: ReadonlyMap<string, Dec> };
}

export interface SanityVerdict {
  readonly accepted: boolean;
  /** Stable reason codes, `CODE` or `CODE:CURRENCY`, stored on a REJECTED snapshot. */
  readonly reasons: readonly string[];
  /** `|new / previous − 1|` per active currency with history (`fx_provider_deviation_ratio`). */
  readonly deviations: ReadonlyMap<string, Dec>;
}

export const FUTURE_SKEW_TOLERANCE_SECONDS = 60;
const BASE_CURRENCY = 'USD';
const ONE = new MoneyDecimal(1);

export function checkSanity(snapshot: ParsedRates, context: SanityContext): SanityVerdict {
  const reasons: string[] = [];
  const deviations = new Map<string, Dec>();

  if (snapshot.baseCurrency !== BASE_CURRENCY) reasons.push('BASE_CURRENCY_NOT_USD');
  const usd = snapshot.rates.get(BASE_CURRENCY);
  if (usd === undefined || !usd.eq(ONE)) reasons.push('USD_RATE_NOT_ONE');

  const updated = snapshot.providerUpdatedAt.getTime();
  const next = snapshot.providerNextUpdateAt.getTime();
  if (updated > context.now.getTime() + FUTURE_SKEW_TOLERANCE_SECONDS * 1000) reasons.push('PROVIDER_TIME_IN_FUTURE');
  if (context.previous && updated < context.previous.providerUpdatedAt.getTime()) reasons.push('PROVIDER_TIME_REGRESSED');
  if (next <= updated || next > updated + 2 * context.cadenceSeconds * 1000) reasons.push('NEXT_UPDATE_IMPLAUSIBLE');

  const malformed = new Set(snapshot.malformedRates);
  for (const currency of context.activeCurrencies) {
    if (malformed.has(currency)) {
      reasons.push(`RATE_MALFORMED:${currency}`);
      continue;
    }
    const rate = snapshot.rates.get(currency);
    if (rate === undefined) {
      reasons.push(`RATE_MISSING:${currency}`);
      continue;
    }
    if (!rate.isFinite() || rate.lte(0)) {
      reasons.push(`RATE_NOT_POSITIVE:${currency}`);
      continue;
    }
    const bounds = context.bounds.get(currency);
    if (!bounds) reasons.push(`BOUNDS_NOT_CONFIGURED:${currency}`);
    else if (rate.lt(bounds.minimum) || rate.gt(bounds.maximum)) reasons.push(`RATE_OUT_OF_BOUNDS:${currency}`);

    const previousRate = context.previous?.rates.get(currency);
    if (previousRate !== undefined && previousRate.gt(0)) {
      const deviation = rate.div(previousRate).minus(ONE).abs();
      deviations.set(currency, deviation);
      const threshold = context.jumpRatioOverrides.get(currency) ?? context.maximumJumpRatio;
      if (deviation.gt(threshold)) reasons.push(`RATE_JUMP:${currency}`);
    }
  }
  return { accepted: reasons.length === 0, reasons, deviations };
}
