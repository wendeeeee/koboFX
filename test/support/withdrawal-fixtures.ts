import { createHash, randomBytes } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { Money } from '../../src/common/money';
import { EntryDirection, PostingAuthorization, TransactionType } from '../../src/modules/ledger/ledger.types';
import { ReservationExpiryPolicy } from '../../src/modules/reservations/reservation.types';
import { resolvePayoutAccounts, withdrawalInternalBucket } from '../../src/modules/withdrawals/withdrawal-accounts';
import {
  principalReferenceOf,
  principalReversalReferenceOf,
  providerDebitReferenceOf,
  providerReferenceOf,
  providerReturnReferenceOf,
} from '../../src/modules/withdrawals/withdrawal-references';
import { LedgerHarness, UserAccount } from './ledger-harness';

/**
 * W1 fixtures: build beneficiaries and withdrawals through their LEGAL steps, with the real ReservationService and
 * LedgerService, so the schema's deferred consistency checks see exactly what W3's services will produce. Sealed
 * columns hold random bytes (the sealing codec is W2's); nothing here is plaintext PII.
 */
export const PROVIDER_ACCOUNT_IDENTITY = 'test-integration-1';

export interface ReadyBeneficiary {
  readonly beneficiaryId: string;
  readonly flowId: string;
  readonly fingerprint: Buffer;
  readonly fingerprintKeyId: string;
}

export interface AdmittedWithdrawal {
  readonly flowId: string;
  readonly reservationId: string;
  readonly owner: UserAccount;
  readonly principalMinor: bigint;
  readonly bucket: number;
  readonly fingerprint: Buffer;
}

export interface ObservationInput {
  readonly operation?: string;
  readonly classification?: string;
  readonly amountMinor?: bigint | null;
  readonly currency?: string;
  readonly domain?: string;
  readonly fingerprint?: Buffer;
  readonly transferId?: string;
  readonly transferCode?: string;
  readonly source?: string;
  readonly transferredAt?: Date | null;
}

const sealed = () => randomBytes(48);

export class WithdrawalFixtures {
  private transferSequence = 1000;

  constructor(private readonly harness: LedgerHarness) {}

  private get manager(): EntityManager {
    return this.harness.unitOfWork.manager;
  }

  async bucketCount(): Promise<number> {
    const [row] = (await this.harness.dataSource.query(
      `SELECT count(*)::int AS count FROM accounts WHERE code = 'PAYSTACK_PAYOUT_IN_TRANSIT:NGN' AND wallet_id IS NULL`,
    )) as { count: number }[];
    return row.count;
  }

  async evidence(manager: EntityManager = this.manager): Promise<string> {
    const [row] = (await manager.query(
      `INSERT INTO protected_provider_evidence
         (provider, environment, operation, codec_version, key_id, sealed_content, content_sha256, content_length)
       VALUES ('paystack', 'test', 'transfer.verify', 1, 'evidence-key-1', $1, $2, 64) RETURNING id`,
      [sealed(), randomBytes(32)],
    )) as { id: string }[];
    return row.id;
  }

  /** A beneficiary walked REQUESTED → RESOLVED → CREATING → READY in one transaction (the deferred check sees READY). */
  async readyBeneficiary(userId: string, bankCode = '058'): Promise<ReadyBeneficiary> {
    const fingerprint = randomBytes(32);
    return this.harness.unitOfWork.run(async (manager) => {
      const [flow] = (await manager.query(
        `INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('PAYSTACK_BENEFICIARY', 'REQUESTED', $1) RETURNING id`,
        [userId],
      )) as { id: string }[];
      const [beneficiary] = (await manager.query(
        `INSERT INTO withdrawal_beneficiaries
           (user_id, flow_id, currency_code, bank_code, account_number_last_four, sealing_key_id, account_number_sealed,
            identity_fingerprint, identity_fingerprint_key_id, provider_account_identity)
         VALUES ($1, $2, 'NGN', $3, '6789', 'data-key-1', $4, $5, 'fingerprint-key-1', $6) RETURNING id`,
        [userId, flow.id, bankCode, sealed(), fingerprint, PROVIDER_ACCOUNT_IDENTITY],
      )) as { id: string }[];
      await manager.query(
        `UPDATE withdrawal_beneficiaries SET resolved_account_name_sealed = $2, resolution_evidence_id = $3, resolved_at = now()
          WHERE id = $1`,
        [beneficiary.id, sealed(), await this.evidence(manager)],
      );
      await manager.query(`UPDATE flow_instances SET state = 'RESOLVED' WHERE id = $1`, [flow.id]);
      await manager.query(`UPDATE flow_instances SET state = 'CREATING' WHERE id = $1`, [flow.id]);
      await manager.query(
        `UPDATE withdrawal_beneficiaries
            SET provider_recipient_code_sealed = $2, provider_recipient_id_sealed = $3, recipient_evidence_id = $4,
                recipient_bound_at = now()
          WHERE id = $1`,
        [beneficiary.id, sealed(), sealed(), await this.evidence(manager)],
      );
      await manager.query(`UPDATE flow_instances SET state = 'READY', completed_at = now() WHERE id = $1`, [flow.id]);
      return { beneficiaryId: beneficiary.id, flowId: flow.id, fingerprint, fingerprintKeyId: 'fingerprint-key-1' };
    });
  }

  async stashOf(userId: string, manager: EntityManager = this.manager): Promise<string> {
    await manager.query(`INSERT INTO customer_stashes (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    const [row] = (await manager.query(`SELECT id FROM customer_stashes WHERE user_id = $1`, [userId])) as { id: string }[];
    return row.id;
  }

  /** Admission's database half (§G.1 step 2), minus guards and limits: flow, typed intent, frozen destination, hold. */
  async admit(owner: UserAccount, beneficiary: ReadyBeneficiary, principalMinor: bigint): Promise<AdmittedWithdrawal> {
    const bucketCount = await this.bucketCount();
    return this.harness.unitOfWork.run(async (manager) => {
      const stashId = await this.stashOf(owner.userId, manager);
      const [flow] = (await manager.query(
        `INSERT INTO flow_instances (flow_type, state, user_id) VALUES ('PAYSTACK_WITHDRAWAL', 'RESERVED', $1) RETURNING id`,
        [owner.userId],
      )) as { id: string }[];
      const bucket = withdrawalInternalBucket(flow.id, bucketCount);
      await manager.query(
        `INSERT INTO paystack_withdrawals
           (flow_id, user_id, account_id, stash_id, beneficiary_id, currency_code, principal_minor, total_debit_minor,
            provider_account_identity, provider_reference, internal_bucket)
         VALUES ($1, $2, $3, $4, $5, 'NGN', $6, $6, $7, $8, $9)`,
        [flow.id, owner.userId, owner.accountId, stashId, beneficiary.beneficiaryId, principalMinor.toString(),
          PROVIDER_ACCOUNT_IDENTITY, providerReferenceOf(flow.id), bucket],
      );
      await this.freezeDestination(manager, flow.id, beneficiary.beneficiaryId);
      const reservation = await this.harness.reservations.reserve({
        accountId: owner.accountId,
        flowId: flow.id,
        amount: Money.of(principalMinor, 'NGN'),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        expiryPolicy: ReservationExpiryPolicy.FLOW_CONTROLLED,
      });
      await manager.query(`UPDATE paystack_withdrawals SET reservation_id = $2 WHERE flow_id = $1`, [flow.id, reservation.id]);
      return { flowId: flow.id, reservationId: reservation.id, owner, principalMinor, bucket, fingerprint: beneficiary.fingerprint };
    });
  }

  async freezeDestination(manager: EntityManager, flowId: string, beneficiaryId: string): Promise<void> {
    await manager.query(
      `INSERT INTO withdrawal_destinations
         (withdrawal_id, user_id, currency_code, beneficiary_id, recipient_type, bank_code, bank_name, account_number_last_four,
          sealing_key_id, account_number_sealed, resolved_account_name_sealed, provider_recipient_code_sealed,
          provider_recipient_id_sealed, identity_fingerprint, identity_fingerprint_key_id)
       SELECT $1, user_id, currency_code, id, recipient_type, bank_code, 'Test Bank', account_number_last_four,
              sealing_key_id, account_number_sealed, resolved_account_name_sealed, provider_recipient_code_sealed,
              provider_recipient_id_sealed, identity_fingerprint, identity_fingerprint_key_id
         FROM withdrawal_beneficiaries WHERE id = $2`,
      [flowId, beneficiaryId],
    );
  }

  /** §G.1 step 3: the marker, under the owner's lock taken before the flow's. */
  async markSubmitting(flowId: string): Promise<void> {
    await this.harness.unitOfWork.run(async (manager) => {
      await manager.query(`SELECT id FROM users WHERE id = (SELECT user_id FROM flow_instances WHERE id = $1) FOR SHARE`, [flowId]);
      await manager.query(`SELECT id FROM flow_instances WHERE id = $1 FOR UPDATE`, [flowId]);
      await manager.query(
        `UPDATE paystack_withdrawals SET submission_started_at = now(), submission_payload_sha256 = $2 WHERE flow_id = $1`,
        [flowId, createHash('sha256').update(flowId).digest()],
      );
      await manager.query(`UPDATE flow_instances SET state = 'SUBMITTING' WHERE id = $1`, [flowId]);
    });
  }

  async bindTransfer(flowId: string): Promise<{ transferId: string; transferCode: string }> {
    const transferId = String(this.transferSequence++);
    const transferCode = `TRF_${transferId}abc`;
    await this.harness.unitOfWork.run(async (manager) => {
      await manager.query(
        `UPDATE paystack_withdrawals SET provider_transfer_id = $2, provider_transfer_code = $3 WHERE flow_id = $1`,
        [flowId, transferId, transferCode],
      );
      await manager.query(`UPDATE flow_instances SET state = 'PROCESSING' WHERE id = $1`, [flowId]);
    });
    return { transferId, transferCode };
  }

  async observe(withdrawal: AdmittedWithdrawal, input: ObservationInput = {}): Promise<{ observationId: string; observedAt: Date }> {
    const [bound] = (await this.harness.dataSource.query(
      `SELECT provider_transfer_id, provider_transfer_code FROM paystack_withdrawals WHERE flow_id = $1`,
      [withdrawal.flowId],
    )) as { provider_transfer_id: string | null; provider_transfer_code: string | null }[];
    const source = input.source ?? 'RESUMER';
    const [row] = (await this.harness.dataSource.query(
      `INSERT INTO paystack_transfer_observations
         (withdrawal_id, provider_account_identity, operation, observed_domain, provider_reference, provider_transfer_id,
          provider_transfer_code, status_classification, raw_status, amount_minor, currency_code,
          recipient_identity_fingerprint, recipient_identity_fingerprint_key_id, provider_transferred_at, evidence_id,
          response_sha256, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::transfer_status_classification, lower($8::text), $9, $10, $11, 'fingerprint-key-1', $12, $13, $14, $15)
       RETURNING id, observed_at`,
      [
        withdrawal.flowId,
        PROVIDER_ACCOUNT_IDENTITY,
        input.operation ?? 'transfer.verify',
        input.domain ?? 'test',
        providerReferenceOf(withdrawal.flowId),
        input.transferId ?? bound.provider_transfer_id,
        input.transferCode ?? bound.provider_transfer_code,
        input.classification ?? 'SUCCESS',
        input.amountMinor === null ? null : (input.amountMinor ?? withdrawal.principalMinor).toString(),
        input.currency ?? 'NGN',
        input.fingerprint ?? withdrawal.fingerprint,
        input.transferredAt ?? null,
        await this.evidence(this.harness.dataSource.manager),
        randomBytes(32),
        source,
      ],
    )) as { id: string; observed_at: Date }[];
    return { observationId: row.id, observedAt: row.observed_at };
  }

  async verify(
    withdrawal: AdmittedWithdrawal,
    outcome: 'SUCCESS' | 'DEFINITIVE_FAILURE' | 'FULL_RETURN',
    observation: { observationId: string; observedAt: Date },
  ): Promise<string> {
    const [row] = (await this.harness.dataSource.query(
      `INSERT INTO withdrawal_verifications
         (withdrawal_id, user_id, currency_code, amount_minor, observation_id, outcome, value_time, value_time_basis)
       VALUES ($1, $2, 'NGN', $3, $4, $5, $6, 'OBSERVED_TEST_STATE') RETURNING id`,
      [withdrawal.flowId, withdrawal.owner.userId, withdrawal.principalMinor.toString(), observation.observationId, outcome,
        observation.observedAt],
    )) as { id: string }[];
    return row.id;
  }

  /**
   * §G.1 step 6 in one unit: user account → reservation → the exact internal union (ascending) → provider debit event
   * → `settle()` once → links → receipt → POSTED. `postedAt` lets a test age the completion for the 24-hour window.
   */
  async complete(
    withdrawal: AdmittedWithdrawal,
    options: { postedAt?: Date; skipReceipt?: boolean } = {},
  ): Promise<{ verificationId: string; principalTransactionId: string; receiptId: string | null; debitEventId: string }> {
    await this.markSubmitting(withdrawal.flowId);
    await this.bindTransfer(withdrawal.flowId);
    const observation = await this.observe(withdrawal);
    const verificationId = await this.verify(withdrawal, 'SUCCESS', observation);
    const amount = Money.of(withdrawal.principalMinor, 'NGN');

    return this.harness.unitOfWork.run(async (manager) => {
      await this.harness.ledger.lockUserAccounts([withdrawal.owner.accountId]);
      await manager.query(`SELECT id FROM reservations WHERE id = $1 FOR UPDATE`, [withdrawal.reservationId]);
      const accounts = await resolvePayoutAccounts(manager, 'NGN', withdrawal.bucket);
      await this.harness.ledger.lockInternalAccounts([accounts.payoutBalanceId, accounts.payoutInTransitId]);

      const debit = await this.harness.ledger.post({
        transaction: {
          type: TransactionType.SETTLEMENT,
          authorization: PostingAuthorization.SYSTEM_DRIVEN,
          valueTime: observation.observedAt,
          initiatedBy: 'job:withdrawal',
          reference: providerDebitReferenceOf(withdrawal.flowId),
          reasonCode: 'PAYSTACK_TRANSFER_DEBIT',
        },
        entries: [
          { account: { accountId: accounts.payoutInTransitId }, direction: EntryDirection.DEBIT, amount },
          { account: { accountId: accounts.payoutBalanceId }, direction: EntryDirection.CREDIT, amount },
        ],
      });
      const [debitEvent] = (await manager.query(
        `INSERT INTO withdrawal_accounting_events
           (withdrawal_id, event_kind, currency_code, amount_minor, transaction_id, evidence_basis, observation_id, provider_event_identity)
         VALUES ($1, 'PRINCIPAL_DEBIT', 'NGN', $2, $3, 'TRANSFER_STATE', $4, $5) RETURNING id`,
        [withdrawal.flowId, withdrawal.principalMinor.toString(), debit.transactionId, observation.observationId,
          `transfer:${withdrawal.flowId}`],
      )) as { id: string }[];

      const settled = await this.harness.reservations.settle(withdrawal.reservationId, {
        transaction: {
          type: TransactionType.WITHDRAWAL,
          valueTime: observation.observedAt,
          initiatedBy: 'job:withdrawal',
          reference: principalReferenceOf(withdrawal.flowId),
          userId: withdrawal.owner.userId,
          reasonCode: 'PAYSTACK_WITHDRAWAL',
        },
        entries: [
          { account: { accountId: withdrawal.owner.accountId }, direction: EntryDirection.DEBIT, amount },
          { account: { accountId: accounts.payoutInTransitId }, direction: EntryDirection.CREDIT, amount },
        ],
      });
      const principalTransactionId = settled.settlementTransactionId as string;
      await manager.query(
        `UPDATE paystack_withdrawals
            SET principal_transaction_id = $2, confirmation_verification_id = $3, posted_at = coalesce($4::timestamptz, now())
          WHERE flow_id = $1`,
        [withdrawal.flowId, principalTransactionId, verificationId, options.postedAt ?? null],
      );
      let receiptId: string | null = null;
      if (!options.skipReceipt) {
        [{ receiptId }] = (await manager.query(`SELECT record_stash_receipt($1, $2) AS "receiptId"`, [
          withdrawal.flowId,
          verificationId,
        ])) as { receiptId: string }[];
      }
      await manager.query(`UPDATE flow_instances SET state = 'POSTED', completed_at = now() WHERE id = $1`, [withdrawal.flowId]);
      return { verificationId, principalTransactionId, receiptId, debitEventId: debitEvent.id };
    });
  }

  /** §G.1 step 7. `sent = false` is the conclusively-unsent cancellation from RESERVED; otherwise a verified failure. */
  async fail(withdrawal: AdmittedWithdrawal, options: { sent: boolean; certify?: boolean }): Promise<void> {
    let verificationId: string | undefined;
    if (options.sent) {
      await this.markSubmitting(withdrawal.flowId);
      if (options.certify !== false) {
        const observation = await this.observe(withdrawal, { classification: 'FAILED' });
        verificationId = await this.verify(withdrawal, 'DEFINITIVE_FAILURE', observation);
      }
    }
    await this.harness.unitOfWork.run(async (manager) => {
      await this.harness.reservations.release(withdrawal.reservationId);
      await manager.query(
        `UPDATE paystack_withdrawals SET failed_at = now(), failure_code = $2 WHERE flow_id = $1`,
        [withdrawal.flowId, options.sent ? 'TRANSFER_FAILED' : 'CANCELLED_BEFORE_SENDING'],
      );
      await manager.query(`UPDATE flow_instances SET state = 'FAILED', completed_at = now() WHERE id = $1`, [withdrawal.flowId]);
    });
    void verificationId;
  }

  /** §G.1 step 8: the full return after success — principal compensation, provider return, reversal receipt, REVERSED. */
  async reverse(
    withdrawal: AdmittedWithdrawal,
    completion: { principalTransactionId: string; debitEventId: string },
  ): Promise<{ reversalTransactionId: string; receiptId: string }> {
    const observation = await this.observe(withdrawal, { classification: 'REVERSED' });
    const verificationId = await this.verify(withdrawal, 'FULL_RETURN', observation);
    const amount = Money.of(withdrawal.principalMinor, 'NGN');

    return this.harness.unitOfWork.run(async (manager) => {
      await manager.query(`SELECT id FROM transactions WHERE id = $1 FOR UPDATE`, [completion.principalTransactionId]);
      await this.harness.ledger.lockUserAccounts([withdrawal.owner.accountId]);
      const accounts = await resolvePayoutAccounts(manager, 'NGN', withdrawal.bucket);
      await this.harness.ledger.lockInternalAccounts([accounts.payoutBalanceId, accounts.payoutInTransitId]);

      const request = await this.harness.ledger.buildReversalRequest(completion.principalTransactionId, {
        valueTime: observation.observedAt,
        initiatedBy: 'job:withdrawal',
        reasonCode: 'PAYSTACK_TRANSFER_REVERSED',
      });
      const reversal = await this.harness.ledger.post({
        transaction: { ...request.transaction, reference: principalReversalReferenceOf(withdrawal.flowId) },
        entries: request.entries,
      });
      const providerReturn = await this.harness.ledger.post({
        transaction: {
          type: TransactionType.SETTLEMENT,
          authorization: PostingAuthorization.SYSTEM_DRIVEN,
          valueTime: observation.observedAt,
          initiatedBy: 'job:withdrawal',
          reference: providerReturnReferenceOf(withdrawal.flowId),
          reasonCode: 'PAYSTACK_TRANSFER_RETURN',
        },
        entries: [
          { account: { accountId: accounts.payoutBalanceId }, direction: EntryDirection.DEBIT, amount },
          { account: { accountId: accounts.payoutInTransitId }, direction: EntryDirection.CREDIT, amount },
        ],
      });
      await manager.query(
        `INSERT INTO withdrawal_accounting_events
           (withdrawal_id, event_kind, currency_code, amount_minor, transaction_id, evidence_basis, observation_id,
            original_event_id, provider_event_identity)
         VALUES ($1, 'PRINCIPAL_RETURN', 'NGN', $2, $3, 'TRANSFER_STATE', $4, $5, $6)`,
        [withdrawal.flowId, withdrawal.principalMinor.toString(), providerReturn.transactionId, observation.observationId,
          completion.debitEventId, `transfer-return:${withdrawal.flowId}`],
      );
      await manager.query(
        `UPDATE paystack_withdrawals SET reversal_transaction_id = $2, return_verification_id = $3, reversed_at = now()
          WHERE flow_id = $1`,
        [withdrawal.flowId, reversal.transactionId, verificationId],
      );
      const [{ receiptId }] = (await manager.query(`SELECT record_stash_receipt($1, $2) AS "receiptId"`, [
        withdrawal.flowId,
        verificationId,
      ])) as { receiptId: string }[];
      await manager.query(`UPDATE flow_instances SET state = 'REVERSED' WHERE id = $1`, [withdrawal.flowId]);
      return { reversalTransactionId: reversal.transactionId, receiptId };
    });
  }

  /** The derived stash balance: immutable confirmations less linked reversals (no stored sum anywhere). */
  async stashBalance(userId: string): Promise<bigint> {
    const [row] = (await this.harness.dataSource.query(
      `SELECT coalesce(sum(CASE event_kind WHEN 'CONFIRMATION' THEN amount_minor ELSE -amount_minor END), 0)::text AS balance
         FROM stash_receipts WHERE user_id = $1`,
      [userId],
    )) as { balance: string }[];
    return BigInt(row.balance);
  }
}
