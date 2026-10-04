import { MigrationInterface, QueryRunner } from 'typeorm';

const BENEFICIARY_MUTABLE = [
  'resolved_account_name_sealed',
  'resolution_evidence_id',
  'resolved_at',
  'provider_recipient_code_sealed',
  'provider_recipient_id_sealed',
  'recipient_evidence_id',
  'recipient_bound_at',
  'failure_code',
];
const WITHDRAWAL_MUTABLE = [
  'reservation_id',
  'submission_started_at',
  'submission_payload_sha256',
  'provider_transfer_id',
  'provider_transfer_code',
  'principal_transaction_id',
  'reversal_transaction_id',
  'confirmation_verification_id',
  'return_verification_id',
  'failure_code',
  'posted_at',
  'failed_at',
  'reversed_at',
];

const without = (columns: readonly string[]) => columns.map((column) => ` - '${column}'`).join('');
const setOnce = (columns: readonly string[]) =>
  columns.map((column) => `(OLD.${column} IS NOT NULL AND NEW.${column} IS DISTINCT FROM OLD.${column})`).join('\n           OR ');

/** The W1 guard, regenerated with W3's extra progression columns. */
function guard(table: string, key: string, setOnceColumns: readonly string[], counters: readonly string[]): string {
  const mutable = [...setOnceColumns, ...counters, 'current_review_event_id'];
  const counterRule = counters
    .map(
      (column) => `
          IF NEW.${column} IS DISTINCT FROM OLD.${column} AND NEW.${column} IS DISTINCT FROM OLD.${column} + 1 THEN
            RAISE EXCEPTION '${table} % ${column} only ever increases by one', OLD.${key}
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;`,
    )
    .join('');
  return `
        CREATE OR REPLACE FUNCTION ${table}_guard_mutation() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION '${table} rows are never deleted (attempted DELETE on %)', OLD.${key}
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF (to_jsonb(NEW)${without(mutable)}) IS DISTINCT FROM (to_jsonb(OLD)${without(mutable)}) THEN
            RAISE EXCEPTION '${table} % is immutable apart from its progression', OLD.${key}
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF ${setOnce(setOnceColumns)} THEN
            RAISE EXCEPTION '${table} % has already recorded that fact; it is set once', OLD.${key}
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;${counterRule}
          IF NEW.current_review_event_id IS DISTINCT FROM OLD.current_review_event_id AND NEW.current_review_event_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM withdrawal_review_events
                              WHERE id = NEW.current_review_event_id AND flow_id = NEW.flow_id) THEN
            RAISE EXCEPTION '${table} % can only point at its own flow''s review', OLD.${key}
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`;
}

const BENEFICIARY_CONSISTENCY = (bankName: boolean) => `
      CREATE OR REPLACE FUNCTION assert_beneficiary_consistent(p_flow_id UUID) RETURNS VOID AS $$
      DECLARE
        flow        flow_instances%ROWTYPE;
        beneficiary withdrawal_beneficiaries%ROWTYPE;
        problem     TEXT;
      BEGIN
        SELECT * INTO flow FROM flow_instances WHERE id = p_flow_id;
        SELECT * INTO beneficiary FROM withdrawal_beneficiaries WHERE flow_id = p_flow_id;
        IF beneficiary.id IS NULL THEN
          problem := 'has no beneficiary';
        ELSIF (flow.state = 'FAILED') <> (beneficiary.failure_code IS NOT NULL) THEN
          problem := 'disagrees with its failure code';
        ELSIF flow.state = 'REQUESTED' AND beneficiary.resolved_at IS NOT NULL THEN
          problem := 'is resolved but still REQUESTED';
        ELSIF flow.state IN ('RESOLVED', 'CREATING', 'READY') AND beneficiary.resolved_at IS NULL THEN
          problem := 'has no resolution';
        ELSIF flow.state = 'RESOLVED' AND beneficiary.recipient_bound_at IS NOT NULL THEN
          problem := 'has a recipient before CREATING';
        ELSIF flow.state = 'READY' AND beneficiary.recipient_bound_at IS NULL THEN
          problem := 'is READY without a validated recipient';${
            bankName
              ? `
        ELSIF flow.state = 'READY' AND beneficiary.bank_name IS NULL THEN
          problem := 'is READY without a bank name';`
              : ''
          }
        END IF;
        IF problem IS NOT NULL THEN
          RAISE EXCEPTION 'beneficiary flow % (%) %', p_flow_id, flow.state, problem USING ERRCODE = 'check_violation';
        END IF;
      END $$ LANGUAGE plpgsql`;

/** W1's verification check, amended: a first-send initiate refusal can certify a definitive failure. */
const VERIFICATION_CHECK = `
      CREATE OR REPLACE FUNCTION withdrawal_verifications_check_insert() RETURNS trigger AS $$
      DECLARE
        withdrawal  paystack_withdrawals%ROWTYPE;
        destination withdrawal_destinations%ROWTYPE;
        observation paystack_transfer_observations%ROWTYPE;
      BEGIN
        SELECT * INTO withdrawal FROM paystack_withdrawals WHERE flow_id = NEW.withdrawal_id;
        SELECT * INTO destination FROM withdrawal_destinations WHERE withdrawal_id = NEW.withdrawal_id;
        SELECT * INTO observation FROM paystack_transfer_observations WHERE id = NEW.observation_id;

        IF observation.withdrawal_id IS DISTINCT FROM NEW.withdrawal_id THEN
          RAISE EXCEPTION 'verification of withdrawal % must cite an observation bound to it', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF withdrawal.submission_started_at IS NULL THEN
          RAISE EXCEPTION 'withdrawal % was never authorized for sending; it has no outcome to verify', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.outcome = 'DEFINITIVE_FAILURE' AND observation.operation = 'transfer.initiate' THEN
          -- W3: the first-ever send was definitively refused (no transfer exists to describe): the refusal is the evidence.
          IF observation.status_classification <> 'REJECTED' OR withdrawal.submission_attempts <> 1
             OR withdrawal.provider_transfer_id IS NOT NULL THEN
            RAISE EXCEPTION 'an initiate refusal certifies a failure only for the first send of an unbound withdrawal (%)', NEW.withdrawal_id
              USING ERRCODE = 'check_violation';
          END IF;
        ELSE
          IF observation.observed_domain IS DISTINCT FROM 'test' THEN
            RAISE EXCEPTION 'verification of withdrawal % needs a test-domain observation (saw %)', NEW.withdrawal_id,
              observation.observed_domain USING ERRCODE = 'check_violation';
          END IF;
          IF observation.amount_minor IS DISTINCT FROM withdrawal.principal_minor
             OR observation.currency_code IS DISTINCT FROM withdrawal.currency_code::text THEN
            RAISE EXCEPTION 'verification of withdrawal % needs the exact principal and currency', NEW.withdrawal_id
              USING ERRCODE = 'check_violation';
          END IF;
          IF (observation.recipient_identity_fingerprint, observation.recipient_identity_fingerprint_key_id)
             IS DISTINCT FROM (destination.identity_fingerprint, destination.identity_fingerprint_key_id) THEN
            RAISE EXCEPTION 'verification of withdrawal % needs the frozen recipient identity', NEW.withdrawal_id
              USING ERRCODE = 'check_violation';
          END IF;
          IF withdrawal.provider_transfer_id IS NOT NULL
             AND (observation.provider_transfer_id, observation.provider_transfer_code)
                 IS DISTINCT FROM (withdrawal.provider_transfer_id, withdrawal.provider_transfer_code) THEN
            RAISE EXCEPTION 'verification of withdrawal % names a different transfer', NEW.withdrawal_id
              USING ERRCODE = 'check_violation';
          END IF;

        END IF;

        IF NEW.outcome IN ('SUCCESS', 'FULL_RETURN') THEN
          IF observation.operation <> 'transfer.verify' THEN
            RAISE EXCEPTION 'a % certificate comes only from transfer.verify (got %)', NEW.outcome, observation.operation
              USING ERRCODE = 'check_violation';
          END IF;
          IF withdrawal.provider_transfer_id IS NULL THEN
            RAISE EXCEPTION 'withdrawal % has no bound transfer to verify', NEW.withdrawal_id USING ERRCODE = 'check_violation';
          END IF;
        ELSIF observation.operation NOT IN ('transfer.verify', 'transfer.initiate') THEN
          RAISE EXCEPTION 'a definitive failure comes only from transfer.verify or transfer.initiate (got %)', observation.operation
            USING ERRCODE = 'check_violation';
        END IF;

        IF (NEW.outcome = 'SUCCESS' AND observation.status_classification <> 'SUCCESS')
           OR (NEW.outcome = 'FULL_RETURN' AND observation.status_classification <> 'REVERSED')
           OR (NEW.outcome = 'DEFINITIVE_FAILURE'
               AND observation.status_classification NOT IN ('FAILED', 'ABANDONED', 'BLOCKED', 'REJECTED', 'REVERSED')) THEN
          RAISE EXCEPTION 'a % certificate cannot rest on a % observation', NEW.outcome, observation.status_classification
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.outcome = 'SUCCESS' AND EXISTS (
             SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = NEW.withdrawal_id AND outcome = 'DEFINITIVE_FAILURE')
           OR NEW.outcome = 'DEFINITIVE_FAILURE' AND EXISTS (
             SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = NEW.withdrawal_id AND outcome = 'SUCCESS') THEN
          RAISE EXCEPTION 'withdrawal % already has a contradictory certificate; this needs review', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.outcome = 'FULL_RETURN' AND NOT EXISTS (
             SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = NEW.withdrawal_id AND outcome = 'SUCCESS') THEN
          RAISE EXCEPTION 'a full return of withdrawal % needs its verified success first', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.value_time_basis = 'PROVIDER_EVENT_TIME' THEN
          IF NEW.outcome <> 'SUCCESS' OR observation.provider_transferred_at IS NULL
             OR NEW.value_time IS DISTINCT FROM observation.provider_transferred_at THEN
            RAISE EXCEPTION 'a provider event time is the success''s transferred_at, exactly' USING ERRCODE = 'check_violation';
          END IF;
        ELSIF withdrawal.environment <> 'test' OR NEW.value_time IS DISTINCT FROM observation.observed_at THEN
          RAISE EXCEPTION 'an observed test-state time is the matched observation''s time, exactly' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;

const VERIFICATION_CHECK_W1 = `
      CREATE OR REPLACE FUNCTION withdrawal_verifications_check_insert() RETURNS trigger AS $$
      DECLARE
        withdrawal  paystack_withdrawals%ROWTYPE;
        destination withdrawal_destinations%ROWTYPE;
        observation paystack_transfer_observations%ROWTYPE;
      BEGIN
        SELECT * INTO withdrawal FROM paystack_withdrawals WHERE flow_id = NEW.withdrawal_id;
        SELECT * INTO destination FROM withdrawal_destinations WHERE withdrawal_id = NEW.withdrawal_id;
        SELECT * INTO observation FROM paystack_transfer_observations WHERE id = NEW.observation_id;

        IF observation.withdrawal_id IS DISTINCT FROM NEW.withdrawal_id THEN
          RAISE EXCEPTION 'verification of withdrawal % must cite an observation bound to it', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF withdrawal.submission_started_at IS NULL THEN
          RAISE EXCEPTION 'withdrawal % was never authorized for sending; it has no outcome to verify', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF observation.observed_domain IS DISTINCT FROM 'test' THEN
          RAISE EXCEPTION 'verification of withdrawal % needs a test-domain observation (saw %)', NEW.withdrawal_id,
            observation.observed_domain USING ERRCODE = 'check_violation';
        END IF;
        IF observation.amount_minor IS DISTINCT FROM withdrawal.principal_minor
           OR observation.currency_code IS DISTINCT FROM withdrawal.currency_code::text THEN
          RAISE EXCEPTION 'verification of withdrawal % needs the exact principal and currency', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF (observation.recipient_identity_fingerprint, observation.recipient_identity_fingerprint_key_id)
           IS DISTINCT FROM (destination.identity_fingerprint, destination.identity_fingerprint_key_id) THEN
          RAISE EXCEPTION 'verification of withdrawal % needs the frozen recipient identity', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF withdrawal.provider_transfer_id IS NOT NULL
           AND (observation.provider_transfer_id, observation.provider_transfer_code)
               IS DISTINCT FROM (withdrawal.provider_transfer_id, withdrawal.provider_transfer_code) THEN
          RAISE EXCEPTION 'verification of withdrawal % names a different transfer', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.outcome IN ('SUCCESS', 'FULL_RETURN') THEN
          IF observation.operation <> 'transfer.verify' THEN
            RAISE EXCEPTION 'a % certificate comes only from transfer.verify (got %)', NEW.outcome, observation.operation
              USING ERRCODE = 'check_violation';
          END IF;
          IF withdrawal.provider_transfer_id IS NULL THEN
            RAISE EXCEPTION 'withdrawal % has no bound transfer to verify', NEW.withdrawal_id USING ERRCODE = 'check_violation';
          END IF;
        ELSIF observation.operation NOT IN ('transfer.verify', 'transfer.initiate') THEN
          RAISE EXCEPTION 'a definitive failure comes only from transfer.verify or transfer.initiate (got %)', observation.operation
            USING ERRCODE = 'check_violation';
        END IF;

        IF (NEW.outcome = 'SUCCESS' AND observation.status_classification <> 'SUCCESS')
           OR (NEW.outcome = 'FULL_RETURN' AND observation.status_classification <> 'REVERSED')
           OR (NEW.outcome = 'DEFINITIVE_FAILURE'
               AND observation.status_classification NOT IN ('FAILED', 'ABANDONED', 'BLOCKED', 'REJECTED', 'REVERSED')) THEN
          RAISE EXCEPTION 'a % certificate cannot rest on a % observation', NEW.outcome, observation.status_classification
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.outcome = 'SUCCESS' AND EXISTS (
             SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = NEW.withdrawal_id AND outcome = 'DEFINITIVE_FAILURE')
           OR NEW.outcome = 'DEFINITIVE_FAILURE' AND EXISTS (
             SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = NEW.withdrawal_id AND outcome = 'SUCCESS') THEN
          RAISE EXCEPTION 'withdrawal % already has a contradictory certificate; this needs review', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.outcome = 'FULL_RETURN' AND NOT EXISTS (
             SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = NEW.withdrawal_id AND outcome = 'SUCCESS') THEN
          RAISE EXCEPTION 'a full return of withdrawal % needs its verified success first', NEW.withdrawal_id
            USING ERRCODE = 'check_violation';
        END IF;

        IF NEW.value_time_basis = 'PROVIDER_EVENT_TIME' THEN
          IF NEW.outcome <> 'SUCCESS' OR observation.provider_transferred_at IS NULL
             OR NEW.value_time IS DISTINCT FROM observation.provider_transferred_at THEN
            RAISE EXCEPTION 'a provider event time is the success''s transferred_at, exactly' USING ERRCODE = 'check_violation';
          END IF;
        ELSIF withdrawal.environment <> 'test' OR NEW.value_time IS DISTINCT FROM observation.observed_at THEN
          RAISE EXCEPTION 'an observed test-state time is the matched observation''s time, exactly' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;

/**
 * Withdrawals W3 (WITHDRAWAL_PLAN.md §E–§G, §K):
 *
 * - `paystack_withdrawals.submission_attempts`: how many times a transfer request was SENT for this reference, counted
 *   durably BEFORE each send. Only a refusal of the first-ever send can be a definitive failure; after any send whose
 *   answer was lost, a refusal proves nothing (§F.2) and goes to review. Starts at 0; only ever +1.
 * - `withdrawal_beneficiaries.bank_name`: the bank's name as Paystack's recipient states it, set once with the
 *   recipient; READY requires it (the frozen destination copies it).
 * - The verification insert check accepts a DEFINITIVE_FAILURE resting on `transfer.initiate` only when it is a
 *   `REJECTED` refusal of the FIRST send (`submission_attempts = 1`) of a withdrawal no transfer is bound to — the refusal
 *   body describes no transfer, so the amount/recipient/domain checks of W1 cannot apply to it.
 * - `worker_capabilities`: a worker heartbeat per capability. The API admits new withdrawals only while a worker able to
 *   process them has beaten recently (§K: an enabled API with no worker fails closed).
 */
export class WithdrawalProgress1791590400000 implements MigrationInterface {
  name = 'WithdrawalProgress1791590400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE paystack_withdrawals
        ADD COLUMN submission_attempts INTEGER NOT NULL DEFAULT 0,
        ADD CONSTRAINT paystack_withdrawals_submission_attempts_non_negative CHECK (submission_attempts >= 0),
        ADD CONSTRAINT paystack_withdrawals_attempts_after_marker CHECK (submission_attempts = 0 OR submission_started_at IS NOT NULL)
    `);
    await queryRunner.query(guard('paystack_withdrawals', 'flow_id', WITHDRAWAL_MUTABLE, ['submission_attempts']));
    await queryRunner.query(`GRANT UPDATE (submission_attempts) ON paystack_withdrawals TO fx_app`);

    await queryRunner.query(`
      ALTER TABLE withdrawal_beneficiaries
        ADD COLUMN bank_name TEXT,
        ADD CONSTRAINT withdrawal_beneficiaries_bank_name_present CHECK (bank_name IS NULL OR length(bank_name) BETWEEN 1 AND 100),
        ADD CONSTRAINT withdrawal_beneficiaries_bank_name_with_recipient CHECK (bank_name IS NULL OR recipient_bound_at IS NOT NULL)
    `);
    await queryRunner.query(guard('withdrawal_beneficiaries', 'id', [...BENEFICIARY_MUTABLE, 'bank_name'], []));
    await queryRunner.query(`GRANT UPDATE (bank_name) ON withdrawal_beneficiaries TO fx_app`);
    await queryRunner.query(BENEFICIARY_CONSISTENCY(true));

    await queryRunner.query(`
      CREATE TABLE worker_capabilities (
        capability    TEXT        PRIMARY KEY,
        heartbeat_at  TIMESTAMPTZ NOT NULL,
        CONSTRAINT worker_capabilities_name_valid CHECK (capability ~ '^[a-z][a-z0-9-]{0,63}$')
      )
    `);
    await queryRunner.query(`REVOKE DELETE, TRUNCATE ON worker_capabilities FROM fx_app`);
    await queryRunner.query(VERIFICATION_CHECK);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(VERIFICATION_CHECK_W1);
    await queryRunner.query(`DROP TABLE worker_capabilities`);
    await queryRunner.query(BENEFICIARY_CONSISTENCY(false));
    await queryRunner.query(`REVOKE UPDATE (bank_name) ON withdrawal_beneficiaries FROM fx_app`);
    await queryRunner.query(guard('withdrawal_beneficiaries', 'id', BENEFICIARY_MUTABLE, []));
    await queryRunner.query(`
      ALTER TABLE withdrawal_beneficiaries
        DROP CONSTRAINT withdrawal_beneficiaries_bank_name_with_recipient,
        DROP CONSTRAINT withdrawal_beneficiaries_bank_name_present,
        DROP COLUMN bank_name
    `);
    await queryRunner.query(`REVOKE UPDATE (submission_attempts) ON paystack_withdrawals FROM fx_app`);
    await queryRunner.query(guard('paystack_withdrawals', 'flow_id', WITHDRAWAL_MUTABLE, []));
    await queryRunner.query(`
      ALTER TABLE paystack_withdrawals
        DROP CONSTRAINT paystack_withdrawals_attempts_after_marker,
        DROP CONSTRAINT paystack_withdrawals_submission_attempts_non_negative,
        DROP COLUMN submission_attempts
    `);
  }
}
