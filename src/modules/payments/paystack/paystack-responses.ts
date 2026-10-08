import { LosslessNumber, isLosslessNumber, parse } from 'lossless-json';
import { z } from 'zod';
import { Money } from '../../../common/money';
import { ProviderResponseInvalidError } from '../payment.errors';
import { PaystackCheckout, PaystackDispute, PaystackTransaction } from './paystack-gateway.port';
import { isPaystackTransactionStatus } from './paystack-status';



const DIGITS = /^(0|[1-9]\d{0,17})$/;


export function minorUnitsFromJsonNumber(value: unknown): bigint | undefined {
  if (!isLosslessNumber(value)) return undefined;
  return DIGITS.test(value.value) ? BigInt(value.value) : undefined;
}

const losslessNumber = z.custom<LosslessNumber>((value) => isLosslessNumber(value), 'must be a JSON number');
const minorUnits = losslessNumber.refine((value) => DIGITS.test(value.value), 'must be a whole number of subunits (digits only)');

const integerId = z.union([losslessNumber, z.string()]).refine(
  (value) => /^[1-9]\d{0,24}$/.test(typeof value === 'string' ? value : value.value),
  'must be a positive integer id',
);
const timestamp = z.string().datetime({ offset: true });
const currency = z.string().regex(/^[A-Z]{3}$/);
const reference = z.string().min(1).max(128);

const envelope = z.object({ status: z.boolean(), message: z.string().max(500).optional(), data: z.unknown() });

const transactionSchema = z.object({
  id: integerId,
  reference,
  status: z.string().min(1).max(32),
  amount: minorUnits,
  currency,
  paid_at: timestamp.nullable().optional(),
  created_at: timestamp.nullable().optional(),
  gateway_response: z.string().max(500).nullable().optional(),
});

const checkoutSchema = z.object({
  authorization_url: z.string().url().max(2048).regex(/^https?:\/\//),
  access_code: z.string().min(1).max(128),
  reference,
});

const pageMeta = z.object({ page: losslessNumber.optional(), pageCount: losslessNumber.optional() }).optional();

const disputeSchema = z.object({
  id: integerId,
  status: z.string().min(1).max(64),
  resolution: z.string().max(64).nullable().optional(),
  refund_amount: minorUnits.nullable().optional(),
  currency: currency.nullable().optional(),
  createdAt: timestamp,
  resolvedAt: timestamp.nullable().optional(),
  transaction: z.object({ id: integerId, reference: reference.nullable().optional(), currency: currency.optional() }),
});

function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function textOf(value: LosslessNumber | string): string {
  return typeof value === 'string' ? value : value.value;
}

export function parsePaystackJson(text: string): unknown {
  return parse(text);
}


function dataOf(body: unknown, operation: string): { data: unknown; meta: unknown } {
  const result = envelope.safeParse(body);
  if (!result.success) throw new ProviderResponseInvalidError(`Malformed Paystack envelope: ${describe(result.error)}`, operation);
  if (!result.data.status) throw new ProviderResponseInvalidError('Paystack answered status:false as a success.', operation);
  return { data: result.data.data, meta: (body as { meta?: unknown }).meta };
}

function toTransaction(wire: z.infer<typeof transactionSchema>, operation: string): PaystackTransaction {
  if (!isPaystackTransactionStatus(wire.status)) {
    throw new ProviderResponseInvalidError(`Paystack transaction status "${wire.status}" is not one we know.`, operation);
  }
  if (wire.status === 'success' && !wire.paid_at) {
    throw new ProviderResponseInvalidError('A successful Paystack transaction must carry paid_at.', operation);
  }
  return {
    transactionId: textOf(wire.id),
    reference: wire.reference,
    status: wire.status,
    amount: Money.of(BigInt(wire.amount.value), wire.currency),
    paidAt: wire.paid_at ? new Date(wire.paid_at) : null,
    createdAt: wire.created_at ? new Date(wire.created_at) : null,
    gatewayResponse: wire.gateway_response ?? null,
  };
}

export function parseTransaction(body: unknown, operation: string): PaystackTransaction {
  const { data } = dataOf(body, operation);
  const result = transactionSchema.safeParse(data);
  if (!result.success) throw new ProviderResponseInvalidError(`Malformed Paystack transaction: ${describe(result.error)}`, operation);
  return toTransaction(result.data, operation);
}

export function parseCheckout(body: unknown, operation: string): PaystackCheckout {
  const { data } = dataOf(body, operation);
  const result = checkoutSchema.safeParse(data);
  if (!result.success) throw new ProviderResponseInvalidError(`Malformed Paystack checkout: ${describe(result.error)}`, operation);
  return { authorizationUrl: result.data.authorization_url, accessCode: result.data.access_code, reference: result.data.reference };
}

/** The next page number, or null on the last page. */
function nextPage(meta: unknown, operation: string): string | null {
  const parsed = pageMeta.safeParse(meta);
  if (!parsed.success || !parsed.data?.page || !parsed.data.pageCount) {
    throw new ProviderResponseInvalidError('A Paystack list must carry meta.page and meta.pageCount.', operation);
  }
  const page = Number.parseInt(parsed.data.page.value, 10);
  const pageCount = Number.parseInt(parsed.data.pageCount.value, 10);
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pageCount) || page < 1) {
    throw new ProviderResponseInvalidError('Paystack list pagination is not a pair of page numbers.', operation);
  }
  return page < pageCount ? String(page + 1) : null;
}

export function parseTransactionPage(body: unknown, operation: string): { items: PaystackTransaction[]; nextCursor: string | null } {
  const { data, meta } = dataOf(body, operation);
  const result = z.array(transactionSchema).safeParse(data);
  if (!result.success) throw new ProviderResponseInvalidError(`Malformed Paystack transaction list: ${describe(result.error)}`, operation);
  return { items: result.data.map((wire) => toTransaction(wire, operation)), nextCursor: nextPage(meta, operation) };
}

export function parseDisputePage(body: unknown, operation: string): { items: PaystackDispute[]; nextCursor: string | null } {
  const { data, meta } = dataOf(body, operation);
  const result = z.array(disputeSchema).safeParse(data);
  if (!result.success) throw new ProviderResponseInvalidError(`Malformed Paystack dispute list: ${describe(result.error)}`, operation);
  const items = result.data.map((wire): PaystackDispute => {
    const disputeCurrency = wire.currency ?? wire.transaction.currency;
    return {
      disputeId: textOf(wire.id),
      transactionId: textOf(wire.transaction.id),
      transactionReference: wire.transaction.reference ?? null,
      status: wire.status,
      resolution: wire.resolution ?? null,
      refundAmount:
        wire.refund_amount && disputeCurrency ? Money.of(BigInt(wire.refund_amount.value), disputeCurrency) : null,
      createdAt: new Date(wire.createdAt),
      resolvedAt: wire.resolvedAt ? new Date(wire.resolvedAt) : null,
    };
  });
  return { items, nextCursor: nextPage(meta, operation) };
}
