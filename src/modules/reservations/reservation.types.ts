import { Money } from '../../common/money';
import { LedgerEntryDraft, TransactionDraft } from '../ledger/ledger.types';

export enum ReservationStatus {
  ACTIVE = 'ACTIVE',
  SETTLED = 'SETTLED',
  RELEASED = 'RELEASED',
  EXPIRED = 'EXPIRED',
}

export interface ReserveRequest {
  readonly accountId: string;
  readonly flowId: string;
  readonly amount: Money;
  readonly expiresAt: Date;
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
