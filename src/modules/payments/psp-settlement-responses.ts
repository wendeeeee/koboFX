import { z } from 'zod';
import { Money } from '../../common/money';
import {
  ProviderChargebackRecord,
  ProviderPage,
  ProviderPayment,
  ProviderSettlementBatchSummary,
  ProviderSettlementLine,
  ProviderSettlementLineType,
} from './payment-provider.port';
import { ProviderResponseInvalidError } from './payment.errors';
import { parsePaymentList } from './psp-responses';

const minorUnits = z.string().regex(/^(0|[1-9]\d{0,17})$/, 'amount must be a string of minor units');
const signedMinorUnits = z.string().regex(/^(0|-?[1-9]\d{0,17})$/, 'amount must be a string of (signed) minor units');
const timestamp = z.string().datetime({ offset: true });
const identifier = z.string().min(1).max(128);
const currency = z.string().regex(/^[A-Z]{3}$/);
const cursor = z.string().min(1).max(512).nullable().optional();
const batchStatus = z.enum(['paid', 'pending']);

const summarySchema = z.object({ id: identifier, currency, status: batchStatus, settled_at: timestamp });
const summaryPageSchema = z.object({ data: z.array(summarySchema), next_cursor: cursor });

const lineSchema = z.object({
  id: identifier,
  type: z.enum(['payment', 'chargeback']),
  payment_id: identifier,
  chargeback_id: identifier.nullable().optional(),
  currency,
  amount: minorUnits,
  fee: minorUnits,
});

const batchPageSchema = z.object({
  id: identifier,
  currency,
  status: batchStatus,
  settled_at: timestamp,
  gross: minorUnits,
  fees: minorUnits,
  chargebacks: minorUnits,
  net: signedMinorUnits,
  line_count: z.number().int().min(0).max(1_000_000),
  lines: z.object({ data: z.array(lineSchema), next_cursor: cursor }),
});

const paymentPageSchema = z.object({ data: z.array(z.unknown()), next_cursor: cursor });

const chargebackPageSchema = z.object({
  data: z.array(z.object({ id: identifier, payment_id: identifier, amount: minorUnits, currency, created_at: timestamp })),
  next_cursor: cursor,
});

export interface SettlementBatchHeader {
  readonly batchId: string;
  readonly currency: string;
  readonly status: 'PAID' | 'PENDING';
  readonly settledAt: Date;
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly chargebackMinor: bigint;
  readonly netMinor: bigint;
  readonly lineCount: number;
}

export interface SettlementBatchPage {
  readonly header: SettlementBatchHeader;
  readonly lines: readonly ProviderSettlementLine[];
  readonly nextCursor: string | null;
}

function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function parse<T>(schema: z.ZodType<T>, body: unknown, operation: string, what: string): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ProviderResponseInvalidError(`Malformed ${what} from the PSP: ${describe(result.error)}`, operation);
  }
  return result.data;
}

const statusOf = (status: 'paid' | 'pending'): 'PAID' | 'PENDING' => (status === 'paid' ? 'PAID' : 'PENDING');

export function parseSettlementSummaryPage(body: unknown, operation: string): ProviderPage<ProviderSettlementBatchSummary> {
  const page = parse(summaryPageSchema, body, operation, 'settlement list');
  return {
    items: page.data.map((batch) => ({
      batchId: batch.id,
      currency: batch.currency,
      status: statusOf(batch.status),
      settledAt: new Date(batch.settled_at),
    })),
    nextCursor: page.next_cursor ?? null,
  };
}

export function parseSettlementBatchPage(body: unknown, operation: string): SettlementBatchPage {
  const page = parse(batchPageSchema, body, operation, 'settlement report');
  for (const line of page.lines.data) {
    if ((line.type === 'chargeback') !== Boolean(line.chargeback_id)) {
      throw new ProviderResponseInvalidError(
        `Malformed settlement report from the PSP: line ${line.id} — a chargeback line (and only one) carries chargeback_id`,
        operation,
      );
    }
  }
  return {
    header: {
      batchId: page.id,
      currency: page.currency,
      status: statusOf(page.status),
      settledAt: new Date(page.settled_at),
      grossMinor: BigInt(page.gross),
      feeMinor: BigInt(page.fees),
      chargebackMinor: BigInt(page.chargebacks),
      netMinor: BigInt(page.net),
      lineCount: page.line_count,
    },
    lines: page.lines.data.map((line) => ({
      lineId: line.id,
      type: line.type === 'payment' ? ProviderSettlementLineType.PAYMENT : ProviderSettlementLineType.CHARGEBACK,
      paymentId: line.payment_id,
      chargebackId: line.chargeback_id ?? null,
      currency: line.currency,
      amountMinor: BigInt(line.amount),
      feeMinor: BigInt(line.fee),
    })),
    nextCursor: page.lines.next_cursor ?? null,
  };
}

export function parsePaymentPage(body: unknown, operation: string): ProviderPage<ProviderPayment> {
  const page = parse(paymentPageSchema, body, operation, 'payment list');
  return { items: parsePaymentList({ data: page.data }, operation), nextCursor: page.next_cursor ?? null };
}

export function parseChargebackPage(body: unknown, operation: string): ProviderPage<ProviderChargebackRecord> {
  const page = parse(chargebackPageSchema, body, operation, 'chargeback list');
  return {
    items: page.data.map((chargeback) => ({
      chargebackId: chargeback.id,
      paymentId: chargeback.payment_id,
      amount: Money.fromMinorString(chargeback.amount, chargeback.currency),
      createdAt: new Date(chargeback.created_at),
    })),
    nextCursor: page.next_cursor ?? null,
  };
}

export function sameHeader(first: SettlementBatchHeader, other: SettlementBatchHeader): boolean {
  return (
    first.batchId === other.batchId &&
    first.currency === other.currency &&
    first.status === other.status &&
    first.settledAt.getTime() === other.settledAt.getTime() &&
    first.grossMinor === other.grossMinor &&
    first.feeMinor === other.feeMinor &&
    first.chargebackMinor === other.chargebackMinor &&
    first.netMinor === other.netMinor &&
    first.lineCount === other.lineCount
  );
}
