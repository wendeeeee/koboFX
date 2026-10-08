import { exactJsonBody } from '../../../../common/http/exact-json';
import { InvariantViolationError } from '../../../../common/errors';
import { isInt64 } from '../../../../common/money';
import { ProviderResponseInvalidError } from '../../payment.errors';
import {
  parseBalanceLedgerPage,
  parseBalances,
  parseBankPage,
  parseRecipient,
  parseRecipientPage,
  parseResolvedAccount,
  parseTransfer,
  parseTransferPage,
} from './paystack-transfer-responses';
import { PaystackTransfersHttpClient } from './paystack-transfers-http-client';
import {
  CallContext,
  CreateRecipientRequest,
  InitiateTransferRequest,
  Observed,
  PaystackBalance,
  PaystackBalanceLedgerRow,
  PaystackBank,
  PaystackPage,
  PaystackRecipient,
  PaystackTransferCallFailedError,
  PaystackTransferRefusal,
  PaystackTransfersGateway,
  ResolvedAccount,
  TransferCallFailureKind,
  TransferListQuery,
  TransferObservation,
  VerifyTransferResult,
} from './paystack-transfers.port';

const ACCOUNT_NUMBER = /^\d{6,20}$/;
const BANK_CODE = /^[0-9A-Za-z]{1,20}$/;
const REFERENCE = /^[a-z0-9_-]{16,50}$/;
const RECIPIENT = /^RCP_[A-Za-z0-9]{1,64}$/;
const ID_OR_CODE = /^([1-9]\d{0,29}|(RCP|TRF)_[A-Za-z0-9]{1,64})$/;
const PAGE_SIZE = 100;

function assertShape(valid: boolean, message: string, details: Record<string, unknown> = {}): void {
  if (!valid) throw new InvariantViolationError(message, details);
}

/** Re-throws with the exchange kept: a body we could not read is still evidence. */
function readOrInvalid<T>(exchange: Observed<unknown>['exchange'], read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof ProviderResponseInvalidError) {
      throw new PaystackTransferCallFailedError(TransferCallFailureKind.INVALID, null, exchange, error.message);
    }
    throw error;
  }
}

function isNotFound(error: unknown): error is PaystackTransferCallFailedError {
  return error instanceof PaystackTransferCallFailedError && error.refusal === PaystackTransferRefusal.NOT_FOUND;
}

/**
 * The real Paystack Transfers adapter (WITHDRAWAL_PLAN.md §H). Writes go out ONCE, as exact JSON (money as an
 * integer, `exactJsonBody`); reads are retried by the transport. The account number in a resolve query is never
 * recorded (`recordedPath`, `sensitiveValues`). Every result and every failure carries its exchange.
 */
export class PaystackTransfersAdapter extends PaystackTransfersGateway {
  constructor(private readonly client: PaystackTransfersHttpClient) {
    super();
  }

  async listBanks(query: { readonly currency: string; readonly cursor?: string; readonly perPage?: number }): Promise<Observed<PaystackPage<PaystackBank>>> {
    const parameters = new URLSearchParams({ country: 'nigeria', currency: query.currency, perPage: String(query.perPage ?? PAGE_SIZE), use_cursor: 'true' });
    if (query.cursor) parameters.set('next', query.cursor);
    const { body, exchange } = await this.client.send({ operation: 'bank.list', method: 'GET', path: `/bank?${parameters.toString()}` });
    return { value: readOrInvalid(exchange, () => parseBankPage(body, 'bank.list')), exchange };
  }

  async resolveAccount(accountNumber: string, bankCode: string, context: CallContext): Promise<Observed<ResolvedAccount>> {
    assertShape(ACCOUNT_NUMBER.test(accountNumber) && BANK_CODE.test(bankCode), 'Resolve needs a digit account number and a bank code.');
    const { body, exchange } = await this.client.send({
      operation: 'bank.resolve',
      method: 'GET',
      path: `/bank/resolve?${new URLSearchParams({ account_number: accountNumber, bank_code: bankCode }).toString()}`,
      recordedPath: `/bank/resolve?account_number=[REDACTED]&bank_code=${encodeURIComponent(bankCode)}`,
      sensitiveValues: [accountNumber],
      flowId: context.flowId,
    });
    return { value: readOrInvalid(exchange, () => parseResolvedAccount(body, 'bank.resolve')), exchange };
  }

  async createRecipient(request: CreateRecipientRequest, context: CallContext): Promise<Observed<PaystackRecipient>> {
    assertShape(ACCOUNT_NUMBER.test(request.accountNumber) && BANK_CODE.test(request.bankCode), 'A recipient needs a digit account number and a bank code.');
    assertShape(request.name.length > 0 && request.name.length <= 200, 'A recipient needs a name.');
    const { body, exchange } = await this.client.send({
      operation: 'recipient.create',
      method: 'POST',
      path: '/transferrecipient',
      rawBody: exactJsonBody({ type: 'nuban', name: request.name, account_number: request.accountNumber, bank_code: request.bankCode, currency: request.currency }),
      recordedBody: { type: 'nuban', name: '[REDACTED]', account_number: '[REDACTED]', bank_code: request.bankCode, currency: request.currency },
      sensitiveValues: [request.accountNumber, request.name],
      flowId: context.flowId,
    });
    return { value: readOrInvalid(exchange, () => parseRecipient(body, 'recipient.create')), exchange };
  }

  async listRecipients(query: { readonly page?: string; readonly perPage?: number }, context: CallContext): Promise<Observed<PaystackPage<PaystackRecipient>>> {
    const parameters = new URLSearchParams({ perPage: String(query.perPage ?? PAGE_SIZE), page: query.page ?? '1' });
    const { body, exchange } = await this.client.send({ operation: 'recipient.list', method: 'GET', path: `/transferrecipient?${parameters.toString()}`, flowId: context.flowId });
    return { value: readOrInvalid(exchange, () => parseRecipientPage(body, 'recipient.list')), exchange };
  }

  async fetchRecipient(idOrCode: string, context: CallContext): Promise<Observed<PaystackRecipient | null>> {
    assertShape(ID_OR_CODE.test(idOrCode), 'A recipient is fetched by numeric id or RCP_ code.');
    try {
      const { body, exchange } = await this.client.send({ operation: 'recipient.fetch', method: 'GET', path: `/transferrecipient/${encodeURIComponent(idOrCode)}`, flowId: context.flowId });
      return { value: readOrInvalid(exchange, () => parseRecipient(body, 'recipient.fetch')), exchange };
    } catch (error) {
      if (isNotFound(error)) return { value: null, exchange: error.exchange };
      throw error;
    }
  }

  async initiateTransfer(request: InitiateTransferRequest, context: CallContext): Promise<Observed<TransferObservation>> {
    assertShape(request.amountMinor > 0n && isInt64(request.amountMinor), 'A transfer amount is a positive 64-bit integer of subunits.');
    assertShape(REFERENCE.test(request.reference), 'A transfer reference is 16–50 lowercase alphanumerics, hyphens or underscores.');
    assertShape(RECIPIENT.test(request.recipientCode), 'A transfer names an RCP_ recipient code.');
    assertShape(/^[A-Z]{3}$/.test(request.currency) && request.reason.length <= 100, 'A transfer needs a currency and a short reason.');
    const { body, exchange } = await this.client.send({
      operation: 'transfer.initiate',
      method: 'POST',
      path: '/transfer',
      rawBody: exactJsonBody({
        source: 'balance',
        amount: request.amountMinor,
        currency: request.currency,
        recipient: request.recipientCode,
        reference: request.reference,
        reason: request.reason,
      }),
      recordedBody: { source: 'balance', amount: request.amountMinor.toString(), currency: request.currency, recipient: '[REDACTED]', reference: request.reference },
      flowId: context.flowId,
    });
    return { value: readOrInvalid(exchange, () => parseTransfer(body, 'transfer.initiate')), exchange };
  }

  async verifyTransfer(reference: string, context: CallContext): Promise<VerifyTransferResult> {
    assertShape(REFERENCE.test(reference), 'A transfer reference is 16–50 lowercase alphanumerics, hyphens or underscores.');
    try {
      const { body, exchange } = await this.client.send({ operation: 'transfer.verify', method: 'GET', path: `/transfer/verify/${encodeURIComponent(reference)}`, flowId: context.flowId });
      return { found: true, observation: readOrInvalid(exchange, () => parseTransfer(body, 'transfer.verify')), exchange };
    } catch (error) {
      if (isNotFound(error)) return { found: false, exchange: error.exchange };
      throw error;
    }
  }

  async fetchTransfer(idOrCode: string, context: CallContext): Promise<Observed<TransferObservation | null>> {
    assertShape(ID_OR_CODE.test(idOrCode), 'A transfer is fetched by numeric id or TRF_ code.');
    try {
      const { body, exchange } = await this.client.send({ operation: 'transfer.fetch', method: 'GET', path: `/transfer/${encodeURIComponent(idOrCode)}`, flowId: context.flowId });
      return { value: readOrInvalid(exchange, () => parseTransfer(body, 'transfer.fetch')), exchange };
    } catch (error) {
      if (isNotFound(error)) return { value: null, exchange: error.exchange };
      throw error;
    }
  }

  async listTransfers(query: TransferListQuery): Promise<Observed<PaystackPage<TransferObservation>>> {
    const { body, exchange } = await this.client.send({ operation: 'transfer.list', method: 'GET', path: `/transfer?${listQuery(query)}` });
    return { value: readOrInvalid(exchange, () => parseTransferPage(body, 'transfer.list')), exchange };
  }

  async balances(): Promise<Observed<readonly PaystackBalance[]>> {
    const { body, exchange } = await this.client.send({ operation: 'balance.fetch', method: 'GET', path: '/balance' });
    return { value: readOrInvalid(exchange, () => parseBalances(body, 'balance.fetch')), exchange };
  }

  async balanceLedger(query: TransferListQuery): Promise<Observed<PaystackPage<PaystackBalanceLedgerRow>>> {
    const { body, exchange } = await this.client.send({ operation: 'balance.ledger', method: 'GET', path: `/balance/ledger?${listQuery(query)}` });
    return { value: readOrInvalid(exchange, () => parseBalanceLedgerPage(body, 'balance.ledger')), exchange };
  }
}

function listQuery(query: TransferListQuery): string {
  return new URLSearchParams({
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    perPage: String(query.perPage ?? PAGE_SIZE),
    page: query.page ?? '1',
  }).toString();
}
