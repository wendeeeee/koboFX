import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InvariantViolationError, UnsupportedCurrencyError } from '../../common/errors';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { UnitOfWork } from '../../database/transaction/unit-of-work';
import { FlowRepository } from '../flows/flow.repository';
import { FlowType } from '../flows/flow.types';
import {
  BeneficiaryStatus,
  PaystackBeneficiaryState,
  beneficiaryStatusOf,
  isPaystackBeneficiaryState,
} from '../flows/paystack-beneficiary/paystack-beneficiary-transitions';
import { ProtectionService } from '../protection/protection.service';
import { InvalidCursorError } from '../transactions/transactions.errors';
import { WithdrawalAdmissionGate } from './withdrawal-admission-gate';
import { RECIPIENT_TYPE, WITHDRAWAL_CURRENCY, WithdrawalTrail, beneficiaryContext, maskedAccountNumber } from './withdrawal-records';
import { BeneficiaryNotFoundError } from './withdrawals.errors';

export interface BeneficiaryAccepted {
  readonly beneficiaryId: string;
  readonly status: BeneficiaryStatus;
}

export interface BeneficiaryView {
  readonly beneficiaryId: string;
  readonly status: BeneficiaryStatus;
  readonly bankCode: string;
  readonly bankName: string | null;
  readonly currency: string;
  readonly accountNumberMasked: string;
  /** Paystack's resolved name */
  readonly accountName: string | null;
  readonly failureCode: string | null;
  readonly reviewRequired: boolean;
  readonly createdAt: string;
}

export interface BeneficiaryPage {
  readonly items: readonly BeneficiaryView[];
  readonly nextCursor: string | null;
}

interface BeneficiaryRow {
  id: string;
  user_id: string;
  state: string;
  bank_code: string;
  bank_name: string | null;
  currency_code: string;
  account_number_last_four: string;
  sealing_key_id: string;
  resolved_account_name_sealed: Buffer | null;
  failure_code: string | null;
  review_open: boolean;
  created_at: Date;
  created_at_micros: string;
}

const COLUMNS = `withdrawal_beneficiaries.id, withdrawal_beneficiaries.user_id, flow_instances.state, withdrawal_beneficiaries.bank_code,
  withdrawal_beneficiaries.bank_name, withdrawal_beneficiaries.currency_code, withdrawal_beneficiaries.account_number_last_four,
  withdrawal_beneficiaries.sealing_key_id, withdrawal_beneficiaries.resolved_account_name_sealed, withdrawal_beneficiaries.failure_code,
  coalesce((SELECT event_kind <> 'RESOLVED' FROM withdrawal_review_events WHERE id = withdrawal_beneficiaries.current_review_event_id), false) AS review_open,
  withdrawal_beneficiaries.created_at,
  (extract(epoch FROM withdrawal_beneficiaries.created_at) * 1000000)::bigint::text AS created_at_micros`;

const MAXIMUM_LIMIT = 100;


@Injectable()
export class BeneficiaryService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly flows: FlowRepository,
    private readonly protection: ProtectionService,
    private readonly trail: WithdrawalTrail,
    private readonly gate: WithdrawalAdmissionGate,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async request(userId: string, input: { bankCode: string; accountNumber: string; currency: string }): Promise<BeneficiaryAccepted> {
    await this.gate.assertOpen();
    if (input.currency !== WITHDRAWAL_CURRENCY) throw new UnsupportedCurrencyError(input.currency);
    const accountIdentity = this.config.withdrawals.accountIdentity;
    if (!accountIdentity) throw new InvariantViolationError('Withdrawals are enabled without PAYSTACK_ACCOUNT_IDENTITY.');
    const identity = { userId, bankCode: input.bankCode, accountNumber: input.accountNumber, recipientType: RECIPIENT_TYPE, currency: WITHDRAWAL_CURRENCY };

    return this.unitOfWork.run(async (manager) => {
      await manager.query(`SELECT id FROM users WHERE id = $1 FOR SHARE`, [userId]);
      const candidates = this.protection.destinationFingerprintCandidates(identity);
      // Serialise concurrent adds of the same destination by the same owner (lock on the ACTIVE fingerprint).
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`beneficiary|${userId}|${candidates[0].digest.toString('hex')}`]);
      const [existing] = (await manager.query(
        `SELECT withdrawal_beneficiaries.id, flow_instances.state FROM withdrawal_beneficiaries
           JOIN flow_instances ON flow_instances.id = withdrawal_beneficiaries.flow_id
          WHERE withdrawal_beneficiaries.user_id = $1
            AND (withdrawal_beneficiaries.identity_fingerprint_key_id, withdrawal_beneficiaries.identity_fingerprint)
                IN (SELECT * FROM unnest($2::text[], $3::bytea[]))`,
        [userId, candidates.map((candidate) => candidate.keyId), candidates.map((candidate) => candidate.digest)],
      )) as { id: string; state: string }[];
      if (existing) return { beneficiaryId: existing.id, status: statusOf(existing.state) };

      const beneficiaryId = randomUUID();
      const flow = await this.flows.create(FlowType.PAYSTACK_BENEFICIARY, userId, PaystackBeneficiaryState.REQUESTED);
      const sealed = await this.protection.sealForUser(userId, input.accountNumber, beneficiaryContext(beneficiaryId, userId, 'account_number_sealed'));
      const fingerprint = candidates[0];
      await manager.query(
        `INSERT INTO withdrawal_beneficiaries
           (id, user_id, flow_id, currency_code, bank_code, account_number_last_four, sealing_key_id, account_number_sealed,
            identity_fingerprint, identity_fingerprint_key_id, provider_account_identity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [beneficiaryId, userId, flow.id, WITHDRAWAL_CURRENCY, input.bankCode, input.accountNumber.slice(-4), sealed.keyId, sealed.sealed,
          fingerprint.digest, fingerprint.keyId, accountIdentity],
      );
      await this.trail.requested('BENEFICIARY', flow.id, userId, PaystackBeneficiaryState.REQUESTED);
      return { beneficiaryId, status: 'PENDING' };
    });
  }

  async find(userId: string, beneficiaryId: string): Promise<BeneficiaryView> {
    const [row] = (await this.unitOfWork.manager.query(
      `SELECT ${COLUMNS} FROM withdrawal_beneficiaries JOIN flow_instances ON flow_instances.id = withdrawal_beneficiaries.flow_id
        WHERE withdrawal_beneficiaries.id = $1 AND withdrawal_beneficiaries.user_id = $2`,
      [beneficiaryId, userId],
    )) as BeneficiaryRow[];
    if (!row) throw new BeneficiaryNotFoundError(beneficiaryId);
    return this.view(row);
  }

  async list(userId: string, cursor: string | undefined, limit: number): Promise<BeneficiaryPage> {
    const size = Math.min(Math.max(1, limit), MAXIMUM_LIMIT);
    const after = cursor === undefined ? null : decodeCursor(cursor);
    const rows = (await this.unitOfWork.manager.query(
      `SELECT ${COLUMNS} FROM withdrawal_beneficiaries JOIN flow_instances ON flow_instances.id = withdrawal_beneficiaries.flow_id
        WHERE withdrawal_beneficiaries.user_id = $1
          AND ($2::bigint IS NULL OR ((extract(epoch FROM withdrawal_beneficiaries.created_at) * 1000000)::bigint, withdrawal_beneficiaries.id)
                                      < ($2::bigint, $3::uuid))
        ORDER BY withdrawal_beneficiaries.created_at DESC, withdrawal_beneficiaries.id DESC
        LIMIT $4`,
      [userId, after?.micros ?? null, after?.id ?? null, size + 1],
    )) as BeneficiaryRow[];
    const page = rows.slice(0, size);
    const last = page.at(-1);
    return {
      items: await Promise.all(page.map((row) => this.view(row))),
      nextCursor: rows.length > size && last ? encodeCursor(last.created_at_micros, last.id) : null,
    };
  }

  private async view(row: BeneficiaryRow): Promise<BeneficiaryView> {
    const accountName = row.resolved_account_name_sealed
      ? (
          await this.protection.open(
            { keyId: row.sealing_key_id, sealed: row.resolved_account_name_sealed },
            beneficiaryContext(row.id, row.user_id, 'resolved_account_name_sealed'),
          )
        ).toString('utf8')
      : null;
    return {
      beneficiaryId: row.id,
      status: statusOf(row.state),
      bankCode: row.bank_code,
      bankName: row.bank_name,
      currency: row.currency_code,
      accountNumberMasked: maskedAccountNumber(row.account_number_last_four),
      accountName,
      failureCode: row.failure_code,
      reviewRequired: row.review_open,
      createdAt: row.created_at.toISOString(),
    };
  }
}

function statusOf(state: string): BeneficiaryStatus {
  if (!isPaystackBeneficiaryState(state)) throw new InvariantViolationError(`Unknown beneficiary state ${state}.`);
  return beneficiaryStatusOf(state);
}

function encodeCursor(micros: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, t: micros, i: id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { micros: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; t?: unknown; i?: unknown };
    if (parsed.v === 1 && typeof parsed.t === 'string' && /^\d{1,19}$/.test(parsed.t) && typeof parsed.i === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parsed.i)) {
      return { micros: parsed.t, id: parsed.i };
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError('malformed beneficiary cursor');
}
