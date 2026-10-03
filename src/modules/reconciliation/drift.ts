export interface DriftContribution {
  readonly currency: string;
  readonly differenceMinor: bigint;
}

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);

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

export function currencyOfAccountCode(code: string): string {
  const currency = code.slice(code.lastIndexOf(':') + 1);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Account code ${code} does not end in a currency.`);
  return currency;
}
