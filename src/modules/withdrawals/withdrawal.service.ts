import { Inject, Injectable } from '@nestjs/common';
import { InvalidAmountError, InvariantViolationError, UnsupportedCurrencyError } from '../../common/errors';
import { Money } from '../../common/money';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { FlowRepository } from '../flows/flow.repository';
import { FlowType } from '../flows/flow.types';
import { isPaystackBeneficiaryState, PaystackBeneficiaryState, beneficiaryStatusOf } from '../flows/paystack-beneficiary/paystack-beneficiary-transitions';
import {
  PaystackWithdrawalState,
  WithdrawalStatus,
  isPaystackWithdrawalState,
  withdrawalStatusOf,
} from '../flows/paystack-withdrawal/paystack-withdrawal-transitions';
import { ChartOfAccountsService } from '../ledger/chart-of-accounts.service';
import { LedgerService } from '../ledger/ledger.service';
import { ProtectionService } from '../protection/protection.service';
import { ReservationService } from '../reservations/reservation.service';
import { ReservationExpiryPolicy } from '../reservations/reservation.types';
import { WithdrawalAdmissionGate } from './withdrawal-admission-gate';
import { WithdrawalCodeService } from './withdrawal-code.service';
import { withdrawalInternalBucket } from './withdrawal-accounts';
import { assertWithinWithdrawalLimits } from './withdrawal-limits';
import { WITHDRAWAL_CURRENCY, WithdrawalTrail, beneficiaryContext, maskedAccountNumber } from './withdrawal-records';
import { principalReferenceOf, providerReferenceOf } from './withdrawal-references';
import { measureWithdrawalUsage } from './withdrawal-usage';
import { BeneficiaryNotFoundError, BeneficiaryNotReadyError, WithdrawalNotFoundError } from './withdrawals.errors';

export interface WithdrawalAccepted {
  readonly withdrawalId: string;
  readonly status: 'PENDING';
  readonly amount: string;
  readonly currency: string;
  readonly fee: string;
  readonly totalDebit: string;
  readonly provider: 'paystack';
  readonly simulated: true;
}

export interface WithdrawalView {
  readonly withdrawalId: string;
  readonly status: WithdrawalStatus;
  readonly amount: string;
  readonly currency: string;
  readonly minorUnit: number;
  readonly fee: string;
  readonly totalDebit: string;
  readonly provider: 'paystack';
  readonly simulated: true;
  readonly destination: { readonly bankCode: string; readonly bankName: string; readonly accountNumberMasked: string; readonly accountName: string };
  readonly transactionReference: string;
  readonly stashReceiptId: string | null;
  readonly failureCode: string | null;
  readonly reviewRequired: boolean;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

const AMOUNT = /^[1-9]\d{0,17}$/;

/**
 * Admitting a withdrawal (WITHDRAWAL_PLAN.md §G.1 step 2; D5, D8): database-only, inside the idempotency barrier, in the
 * global lock order — user (eligibility) → stash identity → new flow → beneficiary → wallet account (limits measured
 * under its lock) → the protected hold (`FLOW_CONTROLLED`, the review deadline as `expires_at`). The destination is
 * frozen byte for byte; the provider reference is fixed now (`withdrawal-{flowId}`). Paystack is asked nothing: the
 * worker sends after this commits. Any refusal rolls everything back, stash identity and hold included.
 */
@Injectable()
export class WithdrawalService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly flows: FlowRepository,
    private readonly ledger: LedgerService,
    private readonly reservations: ReservationService,
    private readonly chartOfAccounts: ChartOfAccountsService,
    private readonly protection: ProtectionService,
    private readonly trail: WithdrawalTrail,
    private readonly gate: WithdrawalAdmissionGate,
    private readonly codes: WithdrawalCodeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async request(userId: string, input: { beneficiaryId: string; amount: string; currency: string; oneTimePassword: string }): Promise<WithdrawalAccepted> {
    await this.gate.assertOpen();
    if (input.currency !== WITHDRAWAL_CURRENCY) throw new UnsupportedCurrencyError(input.currency);
    if (!AMOUNT.test(input.amount)) {
      throw new InvalidAmountError('Amount must be a positive whole number of minor units, as a string.', { amount: input.amount });
    }
    const amount = Money.fromMinorString(input.amount, WITHDRAWAL_CURRENCY);
    const limit = this.config.withdrawals.limits?.get(WITHDRAWAL_CURRENCY);
    const accountIdentity = this.config.withdrawals.accountIdentity;
    if (!limit || !accountIdentity) throw new InvariantViolationError('Withdrawals are enabled without limits or an account identity.');
    // The emailed code (2026-10-07): checked before any money is held, consumed as the admission's last step.
    const code = await this.codes.check(userId, input.oneTimePassword);

    return this.unitOfWork.run(async (manager) => {
      await manager.query(`SELECT id FROM users WHERE id = $1 FOR SHARE`, [userId]);
      await manager.query(`INSERT INTO customer_stashes (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
      const [{ id: stashId }] = (await manager.query(`SELECT id FROM customer_stashes WHERE user_id = $1`, [userId])) as { id: string }[];
      const flow = await this.flows.create(FlowType.PAYSTACK_WITHDRAWAL, userId, PaystackWithdrawalState.RESERVED);

      const [beneficiary] = (await manager.query(
        `SELECT withdrawal_beneficiaries.id, flow_instances.state FROM withdrawal_beneficiaries
           JOIN flow_instances ON flow_instances.id = withdrawal_beneficiaries.flow_id
          WHERE withdrawal_beneficiaries.id = $1 AND withdrawal_beneficiaries.user_id = $2
            FOR SHARE OF withdrawal_beneficiaries`,
        [input.beneficiaryId, userId],
      )) as { id: string; state: string }[];
      if (!beneficiary) throw new BeneficiaryNotFoundError(input.beneficiaryId);
      if (beneficiary.state !== PaystackBeneficiaryState.READY) {
        throw new BeneficiaryNotReadyError(input.beneficiaryId, isPaystackBeneficiaryState(beneficiary.state) ? beneficiaryStatusOf(beneficiary.state) : 'PENDING');
      }

      const [wallet] = (await manager.query(`SELECT id FROM wallets WHERE user_id = $1`, [userId])) as { id: string }[];
      if (!wallet) throw new InvariantViolationError('An active user has no wallet.', { userId });
      const account = await this.chartOfAccounts.openUserAccount(wallet.id, WITHDRAWAL_CURRENCY);
      await this.ledger.lockUserAccounts([account.id]);
      assertWithinWithdrawalLimits(limit, WITHDRAWAL_CURRENCY, amount.amountMinor, await measureWithdrawalUsage(manager, account.id));

      await manager.query(
        `INSERT INTO paystack_withdrawals
           (flow_id, user_id, account_id, stash_id, beneficiary_id, currency_code, principal_minor, total_debit_minor,
            provider_account_identity, provider_reference, internal_bucket)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10)`,
        [flow.id, userId, account.id, stashId, beneficiary.id, WITHDRAWAL_CURRENCY, amount.toMinorString(), accountIdentity,
          providerReferenceOf(flow.id), withdrawalInternalBucket(flow.id, this.config.ledger.internalAccountBuckets)],
      );
      await manager.query(
        `INSERT INTO withdrawal_destinations
           (withdrawal_id, user_id, currency_code, beneficiary_id, recipient_type, bank_code, bank_name, account_number_last_four,
            sealing_key_id, account_number_sealed, resolved_account_name_sealed, provider_recipient_code_sealed,
            provider_recipient_id_sealed, identity_fingerprint, identity_fingerprint_key_id)
         SELECT $1, user_id, currency_code, id, recipient_type, bank_code, bank_name, account_number_last_four, sealing_key_id,
                account_number_sealed, resolved_account_name_sealed, provider_recipient_code_sealed, provider_recipient_id_sealed,
                identity_fingerprint, identity_fingerprint_key_id
           FROM withdrawal_beneficiaries WHERE id = $2`,
        [flow.id, beneficiary.id],
      );
      const [{ expires_at: expiresAt }] = (await manager.query(
        `SELECT now() + make_interval(mins => $1) AS expires_at`,
        [this.config.withdrawals.reviewDeadlineMinutes],
      )) as { expires_at: Date }[];
      const hold = await this.reservations.reserve({
        accountId: account.id,
        flowId: flow.id,
        amount,
        expiresAt,
        expiryPolicy: ReservationExpiryPolicy.FLOW_CONTROLLED,
      });
      await manager.query(`UPDATE paystack_withdrawals SET reservation_id = $2 WHERE flow_id = $1`, [flow.id, hold.id]);
      await this.trail.requested('WITHDRAWAL', flow.id, userId, PaystackWithdrawalState.RESERVED);
      await this.codes.consume(userId, code);
      return {
        withdrawalId: flow.id,
        status: 'PENDING',
        amount: amount.toMinorString(),
        currency: WITHDRAWAL_CURRENCY,
        fee: '0',
        totalDebit: amount.toMinorString(),
        provider: 'paystack',
        simulated: true,
      };
    });
  }

  async find(userId: string, withdrawalId: string): Promise<WithdrawalView> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT paystack_withdrawals.flow_id, paystack_withdrawals.user_id, flow_instances.state, flow_instances.completed_at,
              paystack_withdrawals.principal_minor::text AS principal_minor, paystack_withdrawals.customer_fee_minor::text AS fee_minor,
              paystack_withdrawals.total_debit_minor::text AS total_minor, paystack_withdrawals.currency_code, currencies.minor_unit,
              paystack_withdrawals.failure_code, paystack_withdrawals.created_at,
              coalesce((SELECT event_kind <> 'RESOLVED' FROM withdrawal_review_events WHERE id = paystack_withdrawals.current_review_event_id), false) AS review_open,
              (SELECT id FROM stash_receipts WHERE withdrawal_id = paystack_withdrawals.flow_id AND event_kind = 'CONFIRMATION') AS receipt_id,
              withdrawal_destinations.beneficiary_id, withdrawal_destinations.bank_code, withdrawal_destinations.bank_name,
              withdrawal_destinations.account_number_last_four, withdrawal_destinations.sealing_key_id,
              withdrawal_destinations.resolved_account_name_sealed
         FROM paystack_withdrawals
         JOIN flow_instances ON flow_instances.id = paystack_withdrawals.flow_id
         JOIN withdrawal_destinations ON withdrawal_destinations.withdrawal_id = paystack_withdrawals.flow_id
         JOIN currencies ON currencies.code = paystack_withdrawals.currency_code
        WHERE paystack_withdrawals.flow_id = $1 AND paystack_withdrawals.user_id = $2`,
      [withdrawalId, userId],
    )) as {
      flow_id: string;
      user_id: string;
      state: string;
      completed_at: Date | null;
      principal_minor: string;
      fee_minor: string;
      total_minor: string;
      currency_code: string;
      minor_unit: number;
      failure_code: string | null;
      created_at: Date;
      review_open: boolean;
      receipt_id: string | null;
      beneficiary_id: string;
      bank_code: string;
      bank_name: string;
      account_number_last_four: string;
      sealing_key_id: string;
      resolved_account_name_sealed: Buffer;
    }[];
    if (!row) throw new WithdrawalNotFoundError(withdrawalId);
    if (!isPaystackWithdrawalState(row.state)) throw new InvariantViolationError(`Unknown withdrawal state ${row.state}.`);
    const accountName = await this.protection.open(
      { keyId: row.sealing_key_id, sealed: row.resolved_account_name_sealed },
      beneficiaryContext(row.beneficiary_id, row.user_id, 'resolved_account_name_sealed'),
    );
    return {
      withdrawalId: row.flow_id,
      status: withdrawalStatusOf(row.state),
      amount: row.principal_minor,
      currency: row.currency_code,
      minorUnit: row.minor_unit,
      fee: row.fee_minor,
      totalDebit: row.total_minor,
      provider: 'paystack',
      simulated: true,
      destination: {
        bankCode: row.bank_code,
        bankName: row.bank_name,
        accountNumberMasked: maskedAccountNumber(row.account_number_last_four),
        accountName: accountName.toString('utf8'),
      },
      transactionReference: principalReferenceOf(row.flow_id),
      stashReceiptId: row.receipt_id,
      failureCode: row.failure_code,
      reviewRequired: row.review_open,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    };
  }
}
