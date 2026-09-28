import { FundsReservedError, InsufficientFundsError } from '../ledger.errors';

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

/**
 * The gate as a guard: raise `FUNDS_RESERVED` or `INSUFFICIENT_FUNDS` for a refused
 * reduction, with the figures the client needs to act on (design §7.7). The ONE place
 * both the posting engine and reservations turn an outcome into an error.
 */
export function assertReductionAuthorized(accountId: string, funds: AccountFunds, reductionMinor: bigint): void {
  const outcome = authorizeReduction(funds, reductionMinor);
  if (outcome === AuthorizationOutcome.AUTHORIZED) return;
  const details = {
    accountId,
    requestedMinor: reductionMinor.toString(),
    balanceMinor: funds.balanceMinor.toString(),
    reservedMinor: funds.reservedMinor.toString(),
    availableMinor: (funds.balanceMinor - funds.reservedMinor).toString(),
    overdraftLimitMinor: funds.overdraftLimitMinor.toString(),
  };
  if (outcome === AuthorizationOutcome.FUNDS_RESERVED) {
    throw new FundsReservedError('Part of the balance is reserved by another operation.', details);
  }
  throw new InsufficientFundsError('The balance cannot cover this debit.', details);
}
