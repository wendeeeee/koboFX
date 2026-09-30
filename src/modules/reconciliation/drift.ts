/** One measured difference, in one currency's minor units. */
export interface DriftContribution {
  readonly currency: string;
  /** Signed as measured; the drift counts its absolute value. */
  readonly differenceMinor: bigint;
}

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);

/**
 * `reconciliation_drift_minor` (design §10: "the only alert that means money is wrong"), per
 * currency: the sum of the ABSOLUTE differences each check measured. Currencies are never summed
 * together (different units), and differences never cancel (+5 in one account and −5 in another
 * is 10 of drift, not 0). Every currency seen is present, with 0 when clean.
 */
export function driftByCurrency(
  contributions: readonly DriftContribution[],
  currencies: readonly string[] = [],
): Map<string, bigint> {
  const drift = new Map<string, bigint>(currencies.map((currency) => [currency, 0n]));
  for (const { currency, differenceMinor } of contributions) {
    drift.set(currency, (drift.get(currency) ?? 0n) + absolute(differenceMinor));
  }
  return drift;
}

/** The currency of an account from its code (`USER:{walletId}:{ccy}`, `PSP_RECEIVABLE:{ccy}`). */
export function currencyOfAccountCode(code: string): string {
  const currency = code.slice(code.lastIndexOf(':') + 1);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Account code ${code} does not end in a currency.`);
  return currency;
}
