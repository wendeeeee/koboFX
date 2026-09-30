import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Money } from '../../../common/money';
import { UnitOfWork } from '../../../database/transaction/unit-of-work';

export interface FundingPayment {
  readonly flowId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly amount: Money;
  readonly provider: string;
  readonly paymentMethodToken: string | null;
  readonly providerPaymentId: string | null;
  readonly providerStatus: string | null;
  readonly authorizedAt: Date | null;
  readonly captureRequestedAt: Date | null;
  readonly capturedAt: Date | null;
  readonly failureCode: string | null;
  readonly fundingTransactionId: string | null;
  readonly chargebackTransactionId: string | null;
}

interface FundingPaymentRow {
  flow_id: string;
  user_id: string;
  account_id: string;
  currency_code: string;
  amount_minor: string;
  provider: string;
  payment_method_token: string | null;
  provider_payment_id: string | null;
  provider_status: string | null;
  authorized_at: Date | null;
  capture_requested_at: Date | null;
  captured_at: Date | null;
  failure_code: string | null;
  funding_transaction_id: string | null;
  chargeback_transaction_id: string | null;
}

const COLUMNS = `flow_id, user_id, account_id, currency_code, amount_minor::text AS amount_minor, provider,
  payment_method_token, provider_payment_id, provider_status, authorized_at, capture_requested_at, captured_at,
  failure_code, funding_transaction_id, chargeback_transaction_id`;

function toPayment(row: FundingPaymentRow): FundingPayment {
  return {
    flowId: row.flow_id,
    userId: row.user_id,
    accountId: row.account_id,
    amount: Money.fromMinorString(row.amount_minor, row.currency_code),
    provider: row.provider,
    paymentMethodToken: row.payment_method_token,
    providerPaymentId: row.provider_payment_id,
    providerStatus: row.provider_status,
    authorizedAt: row.authorized_at,
    captureRequestedAt: row.capture_requested_at,
    capturedAt: row.captured_at,
    failureCode: row.failure_code,
    fundingTransactionId: row.funding_transaction_id,
    chargebackTransactionId: row.chargeback_transaction_id,
  };
}

/** The facts a funding flow records, set once each (trigger-enforced). */
export interface FundingPaymentUpdate {
  readonly clearPaymentMethodToken?: boolean;
  readonly providerPaymentId?: string;
  readonly providerStatus?: string;
  readonly authorized?: boolean;
  readonly captureRequested?: boolean;
  readonly capturedAt?: Date;
  readonly failureCode?: string;
  readonly fundingTransactionId?: string;
  readonly chargebackTransactionId?: string;
}

/** `funding_payments` (Phase 5): raw SQL on the ambient UnitOfWork. */
@Injectable()
export class FundingPaymentRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async insert(payment: {
    flowId: string;
    userId: string;
    accountId: string;
    amount: Money;
    provider: string;
    paymentMethodToken: string;
  }): Promise<void> {
    await this.unitOfWork.requireTransaction().query(
      `INSERT INTO funding_payments (flow_id, user_id, account_id, currency_code, amount_minor, provider, payment_method_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        payment.flowId,
        payment.userId,
        payment.accountId,
        payment.amount.currency,
        payment.amount.toMinorString(),
        payment.provider,
        payment.paymentMethodToken,
      ],
    );
  }

  async findByFlowId(flowId: string): Promise<FundingPayment | null> {
    const [row] = (await this.unitOfWork.manager.query(`SELECT ${COLUMNS} FROM funding_payments WHERE flow_id = $1`, [
      flowId,
    ])) as FundingPaymentRow[];
    return row ? toPayment(row) : null;
  }

  async findFlowIdByProviderPayment(provider: string, providerPaymentId: string): Promise<string | null> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT flow_id FROM funding_payments WHERE provider = $1 AND provider_payment_id = $2`,
      [provider, providerPaymentId],
    )) as { flow_id: string }[];
    return row?.flow_id ?? null;
  }

  /**
   * What a PSP settlement said about this deposit (Phase 9): the batch line that paid it out,
   * when, and the PSP's fee for it. Set once, together, only on a posted and not-yet-settled
   * deposit — returns false otherwise (the caller's attribution was stale).
   */
  async recordSettlement(
    manager: EntityManager,
    flowId: string,
    settlement: { settlementBatchLineId: string; settledAt: Date; feeMinor: bigint },
  ): Promise<boolean> {
    const rows = (await manager.query(
      `WITH updated AS (
         UPDATE funding_payments
            SET settled_at = $2, settlement_batch_line_id = $3, settlement_fee_minor = $4, updated_at = now()
          WHERE flow_id = $1 AND funding_transaction_id IS NOT NULL AND settlement_batch_line_id IS NULL
         RETURNING flow_id
       ) SELECT flow_id FROM updated`,
      [flowId, settlement.settledAt, settlement.settlementBatchLineId, settlement.feeMinor.toString()],
    )) as { flow_id: string }[];
    return rows.length === 1;
  }

  /** Set-once facts use `coalesce`, so re-running a step never tries to change one. */
  async update(manager: EntityManager, flowId: string, update: FundingPaymentUpdate): Promise<void> {
    await manager.query(
      `UPDATE funding_payments
          SET payment_method_token = CASE WHEN $2 THEN NULL ELSE payment_method_token END,
              provider_payment_id = coalesce(provider_payment_id, $3),
              provider_status = coalesce($4, provider_status),
              authorized_at = CASE WHEN $5 THEN coalesce(authorized_at, now()) ELSE authorized_at END,
              capture_requested_at = CASE WHEN $6 THEN coalesce(capture_requested_at, now()) ELSE capture_requested_at END,
              captured_at = coalesce(captured_at, $7),
              failure_code = coalesce(failure_code, $8),
              funding_transaction_id = coalesce(funding_transaction_id, $9),
              chargeback_transaction_id = coalesce(chargeback_transaction_id, $10),
              updated_at = now()
        WHERE flow_id = $1`,
      [
        flowId,
        update.clearPaymentMethodToken === true,
        update.providerPaymentId ?? null,
        update.providerStatus ?? null,
        update.authorized === true,
        update.captureRequested === true,
        update.capturedAt ?? null,
        update.failureCode ?? null,
        update.fundingTransactionId ?? null,
        update.chargebackTransactionId ?? null,
      ],
    );
  }
}
