/** What the gate needs to know about one locked, balance-authorizing account. */
export interface AccountFunds {
  readonly balanceMinor: bigint;
  readonly reservedMinor: bigint;
  readonly overdraftLimitMinor: bigint;
}

export enum AuthorizationOutcome {
  AUTHORIZED = 'AUTHORIZED',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  FUNDS_RESERVED = 'FUNDS_RESERVED',
}

/**
 * The runtime `balance >= 0` invariant (design §6.2), for a user-initiated
 * reduction of `reductionMinor` (> 0) on one account:
 *
 *   available = balance − reserved
 *   authorized ⇔ available − reduction ≥ −overdraft_limit
 *
 * When that fails but the TOTAL balance would have covered it, the funds exist but
 * are held by a reservation: `FUNDS_RESERVED`. Otherwise `INSUFFICIENT_FUNDS`.
 */
export function authorizeReduction(funds: AccountFunds, reductionMinor: bigint): AuthorizationOutcome {
  const floor = -funds.overdraftLimitMinor;
  const available = funds.balanceMinor - funds.reservedMinor;
  if (available - reductionMinor >= floor) return AuthorizationOutcome.AUTHORIZED;
  if (funds.balanceMinor - reductionMinor >= floor) return AuthorizationOutcome.FUNDS_RESERVED;
  return AuthorizationOutcome.INSUFFICIENT_FUNDS;
}
