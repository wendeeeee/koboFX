import { Money } from '../../common/money';
import { LedgerEntryDraft, TransactionDraft } from '../ledger/ledger.types';

export enum ReservationStatus {
  ACTIVE = 'ACTIVE',
  SETTLED = 'SETTLED',
  RELEASED = 'RELEASED',
  EXPIRED = 'EXPIRED',
}

/**
 * `FLOW_CONTROLLED` holds never expire: `expiresAt` is only a review deadline, and only the owning flow's outcome
 * releases or settles them (a withdrawal payout, WITHDRAWAL_PLAN.md §G.2). The database refuses the policy for any
 * other flow type and refuses `→ EXPIRED` for every role.
 */
export enum ReservationExpiryPolicy {
  AUTOMATIC = 'AUTOMATIC',
  FLOW_CONTROLLED = 'FLOW_CONTROLLED',
}

export interface ReserveRequest {
  readonly accountId: string;
  readonly flowId: string;
  readonly amount: Money;
  readonly expiresAt: Date;
  /** Defaults to `AUTOMATIC`. A retry with a different policy is a conflict, never a silently weaker hold. */
  readonly expiryPolicy?: ReservationExpiryPolicy;
}

export interface Reservation {
  readonly id: string;
  readonly accountId: string;
  readonly flowId: string;
  readonly amount: Money;
  readonly status: ReservationStatus;
  readonly settledAmount: Money | null;
  readonly settlementTransactionId: string | null;
  readonly expiresAt: Date;
  readonly expiryPolicy: ReservationExpiryPolicy;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}


export interface SettlementPosting {
  readonly transaction: Omit<TransactionDraft, 'authorization' | 'correctsTransactionId'>;
  readonly entries: readonly LedgerEntryDraft[];
}

export interface ExpiryResult {
  readonly expired: readonly Reservation[];
}
