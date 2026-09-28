import { Money } from '../../common/money';
import { LedgerEntryDraft, TransactionDraft } from '../ledger/ledger.types';

export enum ReservationStatus {
  ACTIVE = 'ACTIVE',
  SETTLED = 'SETTLED',
  RELEASED = 'RELEASED',
  EXPIRED = 'EXPIRED',
}

export interface ReserveRequest {
  /** A balance-authorizing (user) account. Internal accounts cannot be reserved against. */
  readonly accountId: string;
  /** The flow that owns resolving this hold (design §7.5). One reservation per (flow, account), ever. */
  readonly flowId: string;
  /** The estimate. Strictly positive, in the account's currency. */
  readonly amount: Money;
  /** The safety net (design §6.3 property 3). Chosen by the caller; must be in the future. */
  readonly expiresAt: Date;
}

export interface Reservation {
  readonly id: string;
  readonly accountId: string;
  readonly flowId: string;
  readonly amount: Money;
  readonly status: ReservationStatus;
  /** The actual amount posted. Set once, when SETTLED. */
  readonly settledAmount: Money | null;
  /** The posting that settled it. Set once, when SETTLED. */
  readonly settlementTransactionId: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  /** When the hold was first given back: settle, release or expiry. Set once. */
  readonly resolvedAt: Date | null;
}

/**
 * The posting that settles a reservation — what `LedgerService.post()` takes, minus
 * what settlement decides for itself:
 *
 * - `authorization`: always `SYSTEM_DRIVEN`. The spend was authorized when it was
 *   reserved; the actual is a fact, and an excess over the estimate is booked as an
 *   overdraft, never refused (design §16).
 * - `correctsTransactionId`: a settlement is never a correction.
 *
 * Its net reduction of the reservation's account IS the actual settled amount, so the
 * two can never disagree. It must not reduce any other user account.
 */
export interface SettlementPosting {
  readonly transaction: Omit<TransactionDraft, 'authorization' | 'correctsTransactionId'>;
  readonly entries: readonly LedgerEntryDraft[];
}

export interface ExpiryResult {
  /** Reservations this call moved ACTIVE → EXPIRED. */
  readonly expired: readonly Reservation[];
}
