import { Injectable, OnModuleInit } from '@nestjs/common';
import { UnitOfWork } from '../../../../database/transaction/unit-of-work';
import { ResolvedWebhook } from '../../webhooks/webhook-resolvers';
import { PaystackEventFamily, parseTransferHint } from '../webhooks/paystack-event-family';
import { PaystackFamilyResolver, PaystackWebhookRouter } from '../webhooks/paystack-webhook-router';

/**
 * Withdrawals' half of the Paystack webhook route (WITHDRAWAL_PLAN.md §I.1): a supported `transfer.*` event is matched
 * to a withdrawal by transfer id, transfer code or OUR reference only — never by funding ids. When the identifiers point
 * at different withdrawals the event is a recorded conflict and is routed to none. The event stays a hint: whatever it
 * claims, only a matching verify settles anything.
 */
@Injectable()
export class PaystackTransferWebhookResolver implements PaystackFamilyResolver, OnModuleInit {
  readonly family = PaystackEventFamily.TRANSFER as const;

  constructor(
    private readonly router: PaystackWebhookRouter,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  onModuleInit(): void {
    this.router.registerFamily(this);
  }

  async resolve(rawPayload: Buffer, eventType: string): Promise<ResolvedWebhook> {
    const hint = parseTransferHint(rawPayload);
    if (!hint || (!hint.transferId && !hint.transferCode && !hint.reference)) return { eventType, flowId: null };
    const rows = (await this.unitOfWork.manager.query(
      `SELECT flow_id::text AS flow_id,
              (provider_transfer_id = $1) AS by_id,
              (provider_transfer_code = $2) AS by_code,
              (provider_reference = $3) AS by_reference
         FROM paystack_withdrawals
        WHERE provider = 'paystack'
          AND (provider_transfer_id = $1 OR provider_transfer_code = $2 OR provider_reference = $3)`,
      [hint.transferId, hint.transferCode, hint.reference],
    )) as { flow_id: string; by_id: boolean | null; by_code: boolean | null; by_reference: boolean | null }[];
    const flowIds = [...new Set(rows.map((row) => row.flow_id))];
    if (flowIds.length === 0) return { eventType, flowId: null };
    if (flowIds.length > 1) {
      return { eventType, flowId: null, conflict: `transfer identifiers name ${flowIds.length} withdrawals` };
    }
    // One withdrawal: every identifier the event carries must agree with it (a bound id differing is a conflict).
    const [row] = rows;
    const [{ bound_id: boundId, bound_code: boundCode, reference }] = (await this.unitOfWork.manager.query(
      `SELECT provider_transfer_id AS bound_id, provider_transfer_code AS bound_code, provider_reference AS reference
         FROM paystack_withdrawals WHERE flow_id = $1`,
      [row.flow_id],
    )) as { bound_id: string | null; bound_code: string | null; reference: string }[];
    const disagrees =
      (hint.reference !== null && hint.reference !== reference) ||
      (hint.transferId !== null && boundId !== null && hint.transferId !== boundId) ||
      (hint.transferCode !== null && boundCode !== null && hint.transferCode !== boundCode);
    if (disagrees) return { eventType, flowId: null, conflict: 'transfer identifiers disagree with the withdrawal they name' };
    return { eventType, flowId: row.flow_id };
  }
}
