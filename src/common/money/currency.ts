/**
 * A currency from the controlled set (design §4.2). Only `minorUnit` and `isActive`
 * participate in business logic; `name` and `symbol` are display metadata.
 *
 * `minorUnit` always comes from the `currencies` table — it is not always 2
 * (JPY is 0, KWD is 3).
 */
export interface Currency {
  readonly code: string;
  readonly name: string;
  readonly symbol: string;
  readonly minorUnit: number;
  readonly isActive: boolean;
}

export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** ISO 4217 minor units range 0–4 (CLF and UYW use 4). */
export const MAX_MINOR_UNIT = 4;
