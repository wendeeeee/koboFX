import { z } from 'zod';
import { Money } from '../../common/money';
import { ProviderPayment, ProviderPaymentStatus } from './payment-provider.port';
import { ProviderResponseInvalidError } from './payment.errors';

/**
 * Boundary schemas for the PSP (design §7.2 point 1): ONLY the fields we use.
 * `.passthrough()` is deliberately not used and unknown keys are simply ignored, so a
 * provider adding or changing a field we don't read can never become our outage.
 *
 * Amounts must be strings of minor units: a JSON number has already passed through a
 * float, so it is refused rather than trusted (no floats in the money path).
 */
const minorUnits = z.string().regex(/^(0|[1-9]\d{0,17})$/, 'amount must be a string of minor units');
const timestamp = z.string().datetime({ offset: true });

const STATUS_BY_WIRE: Readonly<Record<string, ProviderPaymentStatus>> = {
  authorized: ProviderPaymentStatus.AUTHORIZED,
  capture_pending: ProviderPaymentStatus.CAPTURE_PENDING,
  captured: ProviderPaymentStatus.CAPTURED,
  declined: ProviderPaymentStatus.DECLINED,
  expired: ProviderPaymentStatus.EXPIRED,
  voided: ProviderPaymentStatus.VOIDED,
  capture_failed: ProviderPaymentStatus.CAPTURE_FAILED,
  charged_back: ProviderPaymentStatus.CHARGED_BACK,
};

const paymentSchema = z.object({
  id: z.string().min(1).max(128),
  reference: z.string().min(1).max(128),
  status: z.enum(Object.keys(STATUS_BY_WIRE) as [string, ...string[]]),
  amount: minorUnits,
  currency: z.string().regex(/^[A-Z]{3}$/),
  captured_at: timestamp.nullable().optional(),
  decline_code: z.string().max(64).nullable().optional(),
  chargeback: z
    .object({ id: z.string().min(1).max(128), amount: minorUnits, created_at: timestamp })
    .nullable()
    .optional(),
});

const paymentListSchema = z.object({ data: z.array(paymentSchema) });

type WirePayment = z.infer<typeof paymentSchema>;

function describe(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function toPayment(wire: WirePayment): ProviderPayment {
  if (wire.status === 'captured' && !wire.captured_at) {
    throw new ProviderResponseInvalidError('A captured payment must carry captured_at.', 'parse-payment');
  }
  return {
    paymentId: wire.id,
    reference: wire.reference,
    status: STATUS_BY_WIRE[wire.status],
    amount: Money.fromMinorString(wire.amount, wire.currency),
    capturedAt: wire.captured_at ? new Date(wire.captured_at) : null,
    declineCode: wire.decline_code ?? null,
    chargeback: wire.chargeback
      ? {
          chargebackId: wire.chargeback.id,
          amount: Money.fromMinorString(wire.chargeback.amount, wire.currency),
          createdAt: new Date(wire.chargeback.created_at),
        }
      : null,
  };
}

export function parsePayment(body: unknown, operation: string): ProviderPayment {
  const result = paymentSchema.safeParse(body);
  if (!result.success) {
    throw new ProviderResponseInvalidError(`Malformed payment from the PSP: ${describe(result.error)}`, operation);
  }
  return toPayment(result.data);
}

export function parsePaymentList(body: unknown, operation: string): ProviderPayment[] {
  const result = paymentListSchema.safeParse(body);
  if (!result.success) {
    throw new ProviderResponseInvalidError(`Malformed payment list from the PSP: ${describe(result.error)}`, operation);
  }
  return result.data.data.map(toPayment);
}

/** A `{ "error": { "code" } }` body — which some providers send with a `200`. */
export function providerErrorCode(body: unknown): string | null | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const error = (body as { error: unknown }).error;
  if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return null;
}
