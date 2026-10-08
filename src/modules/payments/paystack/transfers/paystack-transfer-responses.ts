import { isLosslessNumber, parse } from 'lossless-json';
import { isInt64 } from '../../../../common/money';
import { ProviderResponseInvalidError } from '../../payment.errors';
import {
  DOCUMENTED_TRANSFER_STATUSES,
  PaystackBalance,
  PaystackBalanceLedgerRow,
  PaystackBank,
  PaystackPage,
  PaystackRecipient,
  RecipientDetails,
  ResolvedAccount,
  TransferObservation,
  TransferStatusClassification,
} from './paystack-transfers.port';

/**
 * Lossless readers for Paystack's transfer-side answers (WITHDRAWAL_PLAN.md §B, §H). Bodies are parsed with
 * `lossless-json` from the raw text: every number keeps its source digits; money becomes `bigint` only from integer
 * text inside signed 64 bits; ids stay decimal TEXT (they exceed 2^53); fractions, exponents and JavaScript numbers are
 * refused for every money field. Nothing here returns a float.
 *
 * Transfers are read TOLERANTLY: a missing or malformed field is null + a named problem (→ MALFORMED, a review), an
 * unrecognised status is UNKNOWN — a reader never invents a failure from content it cannot read.
 */
type Json = unknown;

const ID_TEXT = /^[1-9]\d{0,29}$/;
const INTEGER_TEXT = /^-?(0|[1-9]\d{0,18})$/;
const MAXIMUM_TEXT = 256;

export function parsePaystackTransferJson(text: string): Json {
  return parse(text);
}

function isObject(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isLosslessNumber(value);
}

/** The envelope's `data` (and `meta`) — `status` must be `true` (the classifier already refused anything else). */
export function envelopeOf(body: Json, operation: string): { data: Json; meta: Json; message: string | null } {
  if (!isObject(body) || body.status !== true) {
    throw new ProviderResponseInvalidError('Paystack answered without status:true.', operation);
  }
  return { data: body.data, meta: body.meta, message: typeof body.message === 'string' ? body.message.slice(0, MAXIMUM_TEXT) : null };
}

/** Decimal text of a positive integer id (JSON number or string). */
export function idText(value: Json): string | null {
  const text = isLosslessNumber(value) ? value.value : typeof value === 'string' ? value : null;
  return text !== null && ID_TEXT.test(text) ? text : null;
}

/** Exact minor units from a JSON NUMBER only (Paystack sends money as integers); signed when allowed. */
export function minorUnits(value: Json, signed = false): bigint | null {
  if (!isLosslessNumber(value) || !INTEGER_TEXT.test(value.value)) return null;
  const amount = BigInt(value.value);
  if (!isInt64(amount) || (!signed && amount < 0n)) return null;
  return amount;
}

function text(value: Json, maximum = MAXIMUM_TEXT): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
}

function currencyOf(value: Json): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
}

function instant(value: Json): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value) ? null : parsed;
}

function bool(value: Json): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function detailsOf(value: Json): RecipientDetails | null {
  if (!isObject(value)) return null;
  return {
    bankCode: text(value.bank_code, 20),
    bankName: text(value.bank_name, 100),
    accountNumber: text(value.account_number, 20),
    accountName: text(value.account_name),
  };
}

function recipientOf(value: Json, problems: string[], path: string): PaystackRecipient | null {
  if (!isObject(value)) {
    problems.push(`${path}: not an object`);
    return null;
  }
  const recipientId = idText(value.id);
  const recipientCode = text(value.recipient_code, 64);
  const type = text(value.type, 32);
  if (!recipientId) problems.push(`${path}.id`);
  if (!recipientCode || !/^RCP_[A-Za-z0-9]+$/.test(recipientCode)) problems.push(`${path}.recipient_code`);
  if (!type) problems.push(`${path}.type`);
  if (!recipientId || !recipientCode || !type) return null;
  return {
    recipientId,
    recipientCode,
    type,
    currency: currencyOf(value.currency),
    name: text(value.name),
    active: bool(value.active) ?? false,
    isDeleted: bool(value.is_deleted) ?? false,
    domain: text(value.domain, 16),
    integrationId: idText(value.integration),
    details: detailsOf(value.details) ?? { bankCode: null, bankName: null, accountNumber: null, accountName: null },
    createdAt: instant(value.createdAt),
  };
}

export function parseRecipient(body: Json, operation: string): PaystackRecipient {
  const { data } = envelopeOf(body, operation);
  const problems: string[] = [];
  const recipient = recipientOf(data, problems, 'data');
  if (!recipient) throw new ProviderResponseInvalidError(`Malformed Paystack recipient: ${problems.join(', ')}`, operation);
  return recipient;
}

export function parseResolvedAccount(body: Json, operation: string): ResolvedAccount {
  const { data } = envelopeOf(body, operation);
  if (!isObject(data)) throw new ProviderResponseInvalidError('Malformed Paystack account resolution: data', operation);
  const accountNumber = text(data.account_number, 20);
  if (!accountNumber) throw new ProviderResponseInvalidError('Malformed Paystack account resolution: data.account_number', operation);
  return { accountNumber, accountName: text(data.account_name), bankId: idText(data.bank_id) };
}

/**
 * One transfer. `recipient` is an id in an initiate answer and an object in verify / fetch / list answers; the
 * observation keeps both forms. Required: id, transfer_code, reference, status, amount, currency.
 */
export function readTransferObservation(data: Json): TransferObservation {
  const problems: string[] = [];
  if (!isObject(data)) {
    return emptyObservation(['data: not an object']);
  }
  const transferId = idText(data.id);
  const transferCode = text(data.transfer_code, 64);
  const reference = text(data.reference, 100);
  const rawStatus = typeof data.status === 'string' ? data.status.slice(0, 64) : null;
  const amountMinor = minorUnits(data.amount);
  const currency = currencyOf(data.currency);
  if (!transferId) problems.push('id');
  if (!transferCode || !/^TRF_[A-Za-z0-9]+$/.test(transferCode)) problems.push('transfer_code');
  if (!reference) problems.push('reference');
  if (rawStatus === null) problems.push('status');
  if (amountMinor === null) problems.push('amount');
  if (!currency) problems.push('currency');

  let feeChargedMinor: bigint | null = null;
  if (data.fee_charged !== undefined && data.fee_charged !== null) {
    feeChargedMinor = minorUnits(data.fee_charged);
    if (feeChargedMinor === null) problems.push('fee_charged');
  }

  let recipient: TransferObservation['recipient'] = null;
  let recipientId: string | null = null;
  if (isObject(data.recipient)) {
    const nested: string[] = [];
    const parsed = recipientOf(data.recipient, nested, 'recipient');
    recipient = parsed ?? { details: detailsOf(data.recipient.details) };
    recipientId = parsed?.recipientId ?? idText(data.recipient.id);
    problems.push(...nested);
  } else {
    recipientId = idText(data.recipient);
  }

  const classification =
    problems.length > 0
      ? TransferStatusClassification.MALFORMED
      : (DOCUMENTED_TRANSFER_STATUSES[rawStatus as string] ?? TransferStatusClassification.UNKNOWN);
  return {
    classification,
    rawStatus,
    transferId,
    transferCode,
    reference,
    amountMinor,
    currency,
    domain: text(data.domain, 16),
    integrationId: idText(data.integration),
    recipient,
    recipientId,
    createdAt: instant(data.createdAt),
    updatedAt: instant(data.updatedAt),
    transferredAt: instant(data.transferred_at),
    feeChargedMinor,
    problems,
  };
}

function emptyObservation(problems: string[]): TransferObservation {
  return {
    classification: TransferStatusClassification.MALFORMED,
    rawStatus: null,
    transferId: null,
    transferCode: null,
    reference: null,
    amountMinor: null,
    currency: null,
    domain: null,
    integrationId: null,
    recipient: null,
    recipientId: null,
    createdAt: null,
    updatedAt: null,
    transferredAt: null,
    feeChargedMinor: null,
    problems,
  };
}

export function parseTransfer(body: Json, operation: string): TransferObservation {
  return readTransferObservation(envelopeOf(body, operation).data);
}

/** Page-number pagination (`meta.page` / `meta.pageCount`): the next page, or null on the last one. */
function nextPageOf(meta: Json, operation: string): string | null {
  if (!isObject(meta)) throw new ProviderResponseInvalidError('A Paystack list must carry meta.', operation);
  const page = isLosslessNumber(meta.page) ? meta.page.value : null;
  const pageCount = isLosslessNumber(meta.pageCount) ? meta.pageCount.value : null;
  if (!page || !pageCount || !/^[1-9]\d{0,6}$/.test(page) || !/^(0|[1-9]\d{0,6})$/.test(pageCount)) {
    throw new ProviderResponseInvalidError('A Paystack list must carry meta.page and meta.pageCount as page numbers.', operation);
  }
  return Number(page) < Number(pageCount) ? String(Number(page) + 1) : null;
}

function arrayOf(data: Json, operation: string): Json[] {
  if (!Array.isArray(data)) throw new ProviderResponseInvalidError('A Paystack list must carry a data array.', operation);
  return data;
}

export function parseTransferPage(body: Json, operation: string): PaystackPage<TransferObservation> {
  const { data, meta } = envelopeOf(body, operation);
  return { items: arrayOf(data, operation).map(readTransferObservation), nextCursor: nextPageOf(meta, operation) };
}

export function parseRecipientPage(body: Json, operation: string): PaystackPage<PaystackRecipient> {
  const { data, meta } = envelopeOf(body, operation);
  const items = arrayOf(data, operation).map((item, index) => {
    const problems: string[] = [];
    const recipient = recipientOf(item, problems, `data[${index}]`);
    if (!recipient) throw new ProviderResponseInvalidError(`Malformed Paystack recipient list: ${problems.join(', ')}`, operation);
    return recipient;
  });
  return { items, nextCursor: nextPageOf(meta, operation) };
}

/**
 * The bank directory: cursor pagination (`meta.next`). A missing or repeated cursor is the caller's to refuse (an
 * incomplete directory is never certified).
 */
export function parseBankPage(body: Json, operation: string): PaystackPage<PaystackBank> {
  const { data, meta } = envelopeOf(body, operation);
  const items = arrayOf(data, operation).map((item, index) => {
    if (!isObject(item)) throw new ProviderResponseInvalidError(`Malformed Paystack bank at ${index}`, operation);
    const code = text(item.code, 20);
    const name = text(item.name, 100);
    if (!code || !/^[0-9A-Za-z]+$/.test(code) || !name) {
      throw new ProviderResponseInvalidError(`Malformed Paystack bank at ${index}: code and name`, operation);
    }
    return {
      code,
      name,
      currency: currencyOf(item.currency),
      type: text(item.type, 32),
      active: bool(item.active) ?? false,
      isDeleted: bool(item.is_deleted) ?? false,
      country: text(item.country, 64),
    };
  });
  const next = isObject(meta) ? meta.next : undefined;
  if (next !== null && next !== undefined && (typeof next !== 'string' || next.length === 0 || next.length > 512)) {
    throw new ProviderResponseInvalidError('A Paystack bank page cursor must be a string or null.', operation);
  }
  return { items, nextCursor: typeof next === 'string' ? next : null };
}

export function parseBalances(body: Json, operation: string): PaystackBalance[] {
  const { data } = envelopeOf(body, operation);
  return arrayOf(data, operation).map((item, index) => {
    const currency = isObject(item) ? currencyOf(item.currency) : null;
    const balanceMinor = isObject(item) ? minorUnits(item.balance, true) : null;
    if (!currency || balanceMinor === null) throw new ProviderResponseInvalidError(`Malformed Paystack balance at ${index}`, operation);
    return { currency, balanceMinor };
  });
}

export function parseBalanceLedgerPage(body: Json, operation: string): PaystackPage<PaystackBalanceLedgerRow> {
  const { data, meta } = envelopeOf(body, operation);
  const items = arrayOf(data, operation).map((item, index) => {
    if (!isObject(item)) throw new ProviderResponseInvalidError(`Malformed Paystack ledger row at ${index}`, operation);
    const rowId = idText(item.id);
    const currency = currencyOf(item.currency);
    const differenceMinor = minorUnits(item.difference, true);
    const balanceMinor = minorUnits(item.balance, true);
    if (!rowId || !currency || differenceMinor === null || balanceMinor === null) {
      throw new ProviderResponseInvalidError(`Malformed Paystack ledger row at ${index}: id, currency, difference, balance`, operation);
    }
    return {
      rowId,
      currency,
      differenceMinor,
      balanceMinor,
      reason: text(item.reason),
      modelResponsible: text(item.model_responsible, 64),
      modelRow: idText(item.model_row) ?? text(item.model_row, 64),
      domain: text(item.domain, 16),
      integrationId: idText(item.integration),
      createdAt: instant(item.createdAt),
      updatedAt: instant(item.updatedAt),
    };
  });
  return { items, nextCursor: nextPageOf(meta, operation) };
}
