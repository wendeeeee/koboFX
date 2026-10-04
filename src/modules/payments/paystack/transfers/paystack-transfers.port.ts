import { DependencyUnavailableError } from '../../../../common/errors';

/**
 * Paystack Transfers (WITHDRAWAL_PLAN.md §B, §E.3, §H): banks, account resolution, recipients, transfers, balance and
 * balance ledger. Separate from funding's `PaystackGateway` (no `/transaction/verify`, no funding status meanings);
 * shares the transport, the configured account and its test key.
 *
 * Every answer carries its `ProviderExchange`: the EXACT bytes received (for `protected_provider_evidence`), the
 * `provider_calls` row and a digest of what was sent. Callers persist evidence before acting on a value (§G.1 step 5).
 * Reads may be retried; writes (create recipient, initiate transfer) are sent once.
 */

/** The `transfer_status_classification` enum, value for value (tested against the database). */
export enum TransferStatusClassification {
  PENDING = 'PENDING',
  OTP = 'OTP',
  RECEIVED = 'RECEIVED',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  ABANDONED = 'ABANDONED',
  BLOCKED = 'BLOCKED',
  REJECTED = 'REJECTED',
  REVERSED = 'REVERSED',
  NOT_FOUND = 'NOT_FOUND',
  UNKNOWN = 'UNKNOWN',
  MALFORMED = 'MALFORMED',
}

/** Paystack's documented transfer statuses (§B, "How transfers work"), and what each means to us (§E.3). */
export const DOCUMENTED_TRANSFER_STATUSES: Readonly<Record<string, TransferStatusClassification>> = {
  pending: TransferStatusClassification.PENDING,
  otp: TransferStatusClassification.OTP,
  received: TransferStatusClassification.RECEIVED,
  success: TransferStatusClassification.SUCCESS,
  failed: TransferStatusClassification.FAILED,
  abandoned: TransferStatusClassification.ABANDONED,
  blocked: TransferStatusClassification.BLOCKED,
  rejected: TransferStatusClassification.REJECTED,
  reversed: TransferStatusClassification.REVERSED,
};

export interface ProviderExchange {
  readonly operation: string;
  /** null when no answer arrived (timeout, network). */
  readonly httpStatus: number | null;
  /** The exact response bytes, or null when none arrived. */
  readonly rawResponse: Buffer | null;
  readonly providerCallId: string | undefined;
  /** SHA-256 of the exact request body sent (writes), or null. */
  readonly requestSha256: Buffer | null;
}

export interface Observed<T> {
  readonly value: T;
  readonly exchange: ProviderExchange;
}

export interface PaystackPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface PaystackBank {
  readonly code: string;
  readonly name: string;
  readonly currency: string | null;
  readonly type: string | null;
  readonly active: boolean;
  readonly isDeleted: boolean;
  readonly country: string | null;
}

export interface ResolvedAccount {
  readonly accountNumber: string;
  /** Paystack may return null; that is missing evidence, never an empty name. */
  readonly accountName: string | null;
  readonly bankId: string | null;
}

export interface RecipientDetails {
  readonly bankCode: string | null;
  readonly bankName: string | null;
  readonly accountNumber: string | null;
  readonly accountName: string | null;
}

export interface PaystackRecipient {
  readonly recipientId: string;
  readonly recipientCode: string;
  readonly type: string;
  readonly currency: string | null;
  readonly name: string | null;
  readonly active: boolean;
  readonly isDeleted: boolean;
  readonly domain: string | null;
  readonly integrationId: string | null;
  readonly details: RecipientDetails;
  readonly createdAt: Date | null;
}

/**
 * What Paystack said about one transfer, as read — never trusted for more than it states. Fields that are absent or
 * malformed are null and named in `problems`; then the classification is MALFORMED (a review, never a failure). An
 * unknown status string is UNKNOWN. Null provider times and fees are missing evidence, not "now" or zero.
 */
export interface TransferObservation {
  readonly classification: TransferStatusClassification;
  readonly rawStatus: string | null;
  readonly transferId: string | null;
  readonly transferCode: string | null;
  readonly reference: string | null;
  readonly amountMinor: bigint | null;
  readonly currency: string | null;
  readonly domain: string | null;
  readonly integrationId: string | null;
  /** The recipient as nested in verify/fetch/list answers; an initiate answer names only its id. */
  readonly recipient: (Partial<Omit<PaystackRecipient, 'details'>> & { readonly details: RecipientDetails | null }) | null;
  readonly recipientId: string | null;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  readonly transferredAt: Date | null;
  readonly feeChargedMinor: bigint | null;
  readonly problems: readonly string[];
}

export interface PaystackBalance {
  readonly currency: string;
  readonly balanceMinor: bigint;
}

export interface PaystackBalanceLedgerRow {
  readonly rowId: string;
  readonly currency: string;
  readonly differenceMinor: bigint;
  readonly balanceMinor: bigint;
  readonly reason: string | null;
  readonly modelResponsible: string | null;
  readonly modelRow: string | null;
  readonly domain: string | null;
  readonly integrationId: string | null;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
}

export interface InitiateTransferRequest {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly recipientCode: string;
  /** Fixed at admission (`withdrawal-{flowId}`); every retry sends the same one. */
  readonly reference: string;
  readonly reason: string;
}

export interface CreateRecipientRequest {
  readonly name: string;
  readonly accountNumber: string;
  readonly bankCode: string;
  readonly currency: string;
}

export interface TransferListQuery {
  readonly from: Date;
  readonly to: Date;
  readonly page?: string;
  readonly perPage?: number;
}

export interface CallContext {
  readonly flowId?: string;
}

export type VerifyTransferResult =
  | { readonly found: true; readonly observation: TransferObservation; readonly exchange: ProviderExchange }
  | { readonly found: false; readonly exchange: ProviderExchange };

/**
 * Why a call produced no usable value. `REFUSED` carries Paystack's reason; `CONFIGURATION` (bad key, transfers not
 * enabled for the account) is an operations problem, never a money failure; `TRANSIENT` and `INVALID` mean "no
 * answer": after a write they say NOTHING about whether the transfer exists.
 */
export enum TransferCallFailureKind {
  TRANSIENT = 'TRANSIENT',
  INVALID = 'INVALID',
  REFUSED = 'REFUSED',
  CONFIGURATION = 'CONFIGURATION',
}

export enum PaystackTransferRefusal {
  NOT_FOUND = 'not_found',
  DUPLICATE_REFERENCE = 'duplicate_reference',
  INSUFFICIENT_BALANCE = 'insufficient_balance',
  ACCOUNT_NOT_RESOLVED = 'account_not_resolved',
  CONFIGURATION = 'configuration',
  REJECTED = 'rejected',
}

export class PaystackTransferCallFailedError extends DependencyUnavailableError {
  constructor(
    readonly kind: TransferCallFailureKind,
    readonly refusal: PaystackTransferRefusal | null,
    readonly exchange: ProviderExchange,
    message: string,
  ) {
    super(message, { operation: exchange.operation, kind, refusal, httpStatus: exchange.httpStatus });
  }
}

export abstract class PaystackTransfersGateway {
  abstract listBanks(query: { readonly currency: string; readonly cursor?: string; readonly perPage?: number }): Promise<Observed<PaystackPage<PaystackBank>>>;
  abstract resolveAccount(accountNumber: string, bankCode: string, context: CallContext): Promise<Observed<ResolvedAccount>>;
  abstract createRecipient(request: CreateRecipientRequest, context: CallContext): Promise<Observed<PaystackRecipient>>;
  abstract listRecipients(query: { readonly page?: string; readonly perPage?: number }, context: CallContext): Promise<Observed<PaystackPage<PaystackRecipient>>>;
  /** null when Paystack has no such recipient. */
  abstract fetchRecipient(idOrCode: string, context: CallContext): Promise<Observed<PaystackRecipient | null>>;
  abstract initiateTransfer(request: InitiateTransferRequest, context: CallContext): Promise<Observed<TransferObservation>>;
  abstract verifyTransfer(reference: string, context: CallContext): Promise<VerifyTransferResult>;
  abstract fetchTransfer(idOrCode: string, context: CallContext): Promise<Observed<TransferObservation | null>>;
  abstract listTransfers(query: TransferListQuery): Promise<Observed<PaystackPage<TransferObservation>>>;
  abstract balances(): Promise<Observed<readonly PaystackBalance[]>>;
  abstract balanceLedger(query: TransferListQuery): Promise<Observed<PaystackPage<PaystackBalanceLedgerRow>>>;
}
