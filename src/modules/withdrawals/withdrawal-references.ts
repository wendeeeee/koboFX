import { InvariantViolationError } from '../../common/errors';

/**
 * Stable references of one withdrawal, all derived from its flow id (WITHDRAWAL_PLAN.md §D.2). The provider reference
 * is fixed at admission and reused by every retry: Paystack deduplicates on it, so a new one could pay twice. The
 * database CHECKs the same derivation.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PROVIDER_REFERENCE_PATTERN = /^withdrawal-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function flowIdOf(flowId: string): string {
  const id = flowId.toLowerCase();
  if (!UUID_V4.test(id)) throw new InvariantViolationError('A withdrawal flow id is a version-4 UUID.', { flowId });
  return id;
}

/** `withdrawal-{flowId}`: 47 characters, inside Paystack's 16–50 lowercase alphanumeric/hyphen rule. */
export function providerReferenceOf(flowId: string): string {
  return `withdrawal-${flowIdOf(flowId)}`;
}

/** The customer's principal posting: also the public history reference from admission on. */
export function principalReferenceOf(flowId: string): string {
  return `withdrawal:${flowIdOf(flowId)}`;
}

export function principalReversalReferenceOf(flowId: string): string {
  return `withdrawal-reversal:${flowIdOf(flowId)}`;
}

export function providerDebitReferenceOf(flowId: string): string {
  return `withdrawal-provider-debit:${flowIdOf(flowId)}`;
}

export function providerReturnReferenceOf(flowId: string): string {
  return `withdrawal-provider-return:${flowIdOf(flowId)}`;
}

const FEE_EVENT_IDENTITY = /^[A-Za-z0-9._:-]{1,64}$/;

/** One attributed fee event: its provider identity and fee component keep two fee facts apart. */
export function providerFeeReferenceOf(flowId: string, providerEventIdentity: string, feeComponent: string): string {
  return `withdrawal-provider-fee:${flowIdOf(flowId)}:${feeSuffix(providerEventIdentity, feeComponent)}`;
}

export function providerFeeRefundReferenceOf(flowId: string, providerEventIdentity: string, feeComponent: string): string {
  return `withdrawal-provider-fee-refund:${flowIdOf(flowId)}:${feeSuffix(providerEventIdentity, feeComponent)}`;
}

function feeSuffix(providerEventIdentity: string, feeComponent: string): string {
  if (!FEE_EVENT_IDENTITY.test(providerEventIdentity) || !/^[a-z][a-z0-9_]{0,31}$/.test(feeComponent)) {
    throw new InvariantViolationError('A fee event needs a bounded provider identity and fee component.', {
      providerEventIdentity,
      feeComponent,
    });
  }
  return `${providerEventIdentity}:${feeComponent}`;
}
