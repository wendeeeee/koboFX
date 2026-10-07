import { MigrationInterface, QueryRunner } from 'typeorm';

const WITHDRAWAL_SET_ONCE = [
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

/**
 * The approved recovery an approval execution names in the transaction-local `fx.withdrawal_recovery` setting, if it is
 * a live (APPROVED: executing in this transaction) `PAYSTACK_WITHDRAWAL_RECOVERY` approval for this withdrawal. The
 * setting is only a pointer — anyone may set a custom setting; the APPROVED four-eyes row is the authority, and only
 * the approvals machinery can produce one (Phase 10 triggers). Returns its payload, or NULL.
 */
const RECOVERY_PAYLOAD_FUNCTION = `
      CREATE FUNCTION withdrawal_recovery_payload(p_flow_id UUID) RETURNS JSONB AS $$
        SELECT approvals.payload FROM approvals
         WHERE current_setting('fx.withdrawal_recovery', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           AND approvals.id = current_setting('fx.withdrawal_recovery', true)::uuid
           AND approvals.action_type = 'PAYSTACK_WITHDRAWAL_RECOVERY'
           AND approvals.status = 'APPROVED'
           AND approvals.payload ->> 'withdrawalId' = p_flow_id::text
      $$ LANGUAGE sql STABLE`;

/** W1's flow guard (as `1791417600001` left it), plus — when `recovery` — the guarded FAILED → POSTED edge. */
const FLOW_GUARD = (recovery: boolean) => `
      CREATE OR REPLACE FUNCTION flow_instances_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'flow instances are never deleted (attempted DELETE on id %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.flow_type IS DISTINCT FROM OLD.flow_type
           OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'flow % identity is immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.state IS DISTINCT FROM OLD.state
           AND NOT flow_transition_allowed(OLD.flow_type, OLD.state, NEW.state)${
             recovery
               ? `
           -- W4: an approved late-success recovery (WITHDRAWAL_PLAN.md §E.2, §I.3) — never a normal transition.
           AND NOT (OLD.flow_type = 'PAYSTACK_WITHDRAWAL' AND OLD.state = 'FAILED' AND NEW.state = 'POSTED'
                    AND withdrawal_recovery_payload(OLD.id) ->> 'mode' IN ('COMPLETE_MATCHED_SUCCESS', 'LATE_FACT_POST'))`
               : ''
           } THEN
          RAISE EXCEPTION 'flow % (%) cannot move from % to %', OLD.id, OLD.flow_type, OLD.state, NEW.state
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
          RAISE EXCEPTION 'flow % completion time is set once', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
           AND NEW.state NOT IN ('POSTED', 'SETTLED', 'FAILED', 'REVERSED', 'HELD', 'READY') THEN
          RAISE EXCEPTION 'flow % cannot complete in state %', OLD.id, NEW.state
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql`;

/** The withdrawal guard (W3's shape), plus — when `recovery` — `recovery_approval_id`, set once and only by its approval. */
const WITHDRAWAL_GUARD = (recovery: boolean) => {
  const setOnceColumns = recovery ? [...WITHDRAWAL_SET_ONCE, 'recovery_approval_id'] : WITHDRAWAL_SET_ONCE;
  const mutable = [...setOnceColumns, 'submission_attempts', 'current_review_event_id'];
  return `
        CREATE OR REPLACE FUNCTION paystack_withdrawals_guard_mutation() RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'paystack_withdrawals rows are never deleted (attempted DELETE on %)', OLD.flow_id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF (to_jsonb(NEW)${without(mutable)}) IS DISTINCT FROM (to_jsonb(OLD)${without(mutable)}) THEN
            RAISE EXCEPTION 'paystack_withdrawals % is immutable apart from its progression', OLD.flow_id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF ${setOnce(setOnceColumns)} THEN
            RAISE EXCEPTION 'paystack_withdrawals % has already recorded that fact; it is set once', OLD.flow_id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          IF NEW.submission_attempts IS DISTINCT FROM OLD.submission_attempts AND NEW.submission_attempts IS DISTINCT FROM OLD.submission_attempts + 1 THEN
            RAISE EXCEPTION 'paystack_withdrawals % submission_attempts only ever increases by one', OLD.flow_id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;${
            recovery
              ? `
          IF NEW.recovery_approval_id IS DISTINCT FROM OLD.recovery_approval_id
             AND (NEW.recovery_approval_id::text IS DISTINCT FROM current_setting('fx.withdrawal_recovery', true)
                  OR withdrawal_recovery_payload(NEW.flow_id) IS NULL) THEN
            RAISE EXCEPTION 'paystack_withdrawals % records a recovery only inside its approved execution', OLD.flow_id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;`
              : ''
          }
          IF NEW.current_review_event_id IS DISTINCT FROM OLD.current_review_event_id AND NEW.current_review_event_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM withdrawal_review_events
                              WHERE id = NEW.current_review_event_id AND flow_id = NEW.flow_id) THEN
            RAISE EXCEPTION 'paystack_withdrawals % can only point at its own flow''s review', OLD.flow_id
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`;
};

/** W1's per-state facts; with `recovery`, the approved late-success proof replaces the settled-hold requirement. */
const CONSISTENCY = (recovery: boolean) => `
      CREATE OR REPLACE FUNCTION assert_withdrawal_consistent(p_flow_id UUID) RETURNS VOID AS $$
      DECLARE
        flow           flow_instances%ROWTYPE;
        withdrawal     paystack_withdrawals%ROWTYPE;
        reservation    reservations%ROWTYPE;
        confirmations  INTEGER;
        reversals      INTEGER;
        problem        TEXT;
      BEGIN
        SELECT * INTO flow FROM flow_instances WHERE id = p_flow_id;
        SELECT * INTO withdrawal FROM paystack_withdrawals WHERE flow_id = p_flow_id;
        IF withdrawal.flow_id IS NULL THEN
          problem := 'has no withdrawal';
        ELSIF NOT EXISTS (SELECT 1 FROM withdrawal_destinations WHERE withdrawal_id = p_flow_id) THEN
          problem := 'has no frozen destination';
        ELSE
          SELECT * INTO reservation FROM reservations WHERE id = withdrawal.reservation_id;
          SELECT count(*) FILTER (WHERE event_kind = 'CONFIRMATION'), count(*) FILTER (WHERE event_kind = 'REVERSAL')
            INTO confirmations, reversals FROM stash_receipts WHERE withdrawal_id = p_flow_id;

          IF reservation.id IS NULL THEN
            problem := 'has no reservation';
          ELSIF (reservation.flow_id, reservation.account_id, reservation.amount_minor, reservation.expiry_policy)
                IS DISTINCT FROM (p_flow_id, withdrawal.account_id, withdrawal.total_debit_minor, 'FLOW_CONTROLLED'::reservation_expiry_policy) THEN
            problem := 'holds a reservation that is not its protected hold of the total debit';
          ELSIF flow.state IN ('RESERVED', 'SUBMITTING', 'PROCESSING') THEN
            IF reservation.status <> 'ACTIVE' THEN
              problem := 'is unresolved but its hold is ' || reservation.status;
            ELSIF (flow.state = 'RESERVED') <> (withdrawal.submission_started_at IS NULL) THEN
              problem := 'disagrees with its submission marker';
            ELSIF num_nonnulls(withdrawal.posted_at, withdrawal.failed_at, withdrawal.reversed_at) > 0 OR confirmations + reversals > 0 THEN
              problem := 'is unresolved but records an outcome';
            END IF;
          ELSIF flow.state IN ('POSTED', 'REVERSED') THEN${
            recovery
              ? `
            IF withdrawal.recovery_approval_id IS NOT NULL THEN
              -- The approved late-success proof (§D.2, §E.2): the hold was RELEASED by the original failure and is never
              -- pretended settled; the principal was posted by post() itself under the approval, exactly once.
              IF reservation.status <> 'RELEASED' THEN
                problem := 'is a recovered late success but its hold is ' || reservation.status;
              ELSIF withdrawal.failed_at IS NULL OR withdrawal.submission_started_at IS NULL THEN
                problem := 'is a recovered late success without its original failure and submission';
              ELSIF NOT EXISTS (
                      SELECT 1 FROM approvals
                       WHERE approvals.id = withdrawal.recovery_approval_id
                         AND approvals.action_type = 'PAYSTACK_WITHDRAWAL_RECOVERY'
                         AND approvals.status IN ('APPROVED', 'EXECUTED')
                         AND approvals.payload ->> 'withdrawalId' = p_flow_id::text
                         AND approvals.payload ->> 'mode' IN ('COMPLETE_MATCHED_SUCCESS', 'LATE_FACT_POST')) THEN
                problem := 'is a recovered late success without its approved recovery';
              ELSIF NOT EXISTS (
                      SELECT 1 FROM transactions
                       WHERE transactions.id = withdrawal.principal_transaction_id AND transactions.type = 'WITHDRAWAL'
                         AND transactions.reference = 'withdrawal:' || p_flow_id::text
                         AND transactions.user_id = withdrawal.user_id
                         AND transactions.status IN ('POSTED', 'REVERSED')) THEN
                problem := 'is a recovered late success without its principal posting';
              END IF;
            ELSIF reservation.status <> 'SETTLED' OR reservation.settlement_transaction_id IS DISTINCT FROM withdrawal.principal_transaction_id
               OR reservation.settled_minor IS DISTINCT FROM withdrawal.total_debit_minor THEN
              problem := 'is posted but its hold was not settled by exactly its principal posting';
            END IF;
            IF problem IS NOT NULL THEN
              NULL;
            ELSIF withdrawal.posted_at IS NULL OR confirmations <> 1 THEN`
              : `
            IF reservation.status <> 'SETTLED' OR reservation.settlement_transaction_id IS DISTINCT FROM withdrawal.principal_transaction_id
               OR reservation.settled_minor IS DISTINCT FROM withdrawal.total_debit_minor THEN
              problem := 'is posted but its hold was not settled by exactly its principal posting';
            ELSIF withdrawal.posted_at IS NULL OR confirmations <> 1 THEN`
          }
              problem := 'is posted without exactly one confirmation';
            ELSIF (flow.state = 'REVERSED') <> (withdrawal.reversed_at IS NOT NULL) OR (flow.state = 'REVERSED') <> (reversals = 1)
                  OR reversals > 1 THEN
              problem := 'disagrees with its reversal facts';
            END IF;
          ELSIF flow.state = 'FAILED' THEN
            IF reservation.status <> 'RELEASED' THEN
              problem := 'failed but its hold is ' || reservation.status;
            ELSIF withdrawal.failed_at IS NULL OR withdrawal.posted_at IS NOT NULL OR confirmations + reversals > 0 THEN
              problem := 'failed but records a completion';
            ELSIF withdrawal.submission_started_at IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = p_flow_id AND outcome = 'DEFINITIVE_FAILURE') THEN
              problem := 'failed after sending without a definitive-failure certificate';
            END IF;
          ELSE
            problem := 'is in unknown state ' || flow.state;
          END IF;
        END IF;

        IF problem IS NOT NULL THEN
          RAISE EXCEPTION 'withdrawal flow % (%) %', p_flow_id, flow.state, problem USING ERRCODE = 'check_violation';
        END IF;
      END $$ LANGUAGE plpgsql`;

/** W3's verification check; with `recovery`: SUCCESS after a failure only under an approved recovery, and the late-fact basis. */
const VERIFICATION_CHECK = (recovery: boolean) => `
      CREATE OR REPLACE FUNCTION withdrawal_verifications_check_insert() RETURNS trigger AS $$
      DECLARE
        withdrawal  paystack_withdrawals%ROWTYPE;
        destination withdrawal_destinations%ROWTYPE;
        observation paystack_transfer_observations%ROWTYPE;${recovery ? `
        recovery    JSONB;` : ''}
      BEGIN
        SELECT * INTO withdrawal FROM paystack_withdrawals WHERE flow_id = NEW.withdrawal_id;
        SELECT * INTO destination FROM withdrawal_destinations WHERE withdrawal_id = NEW.withdrawal_id;
        SELECT * INTO observation FROM paystack_transfer_observations WHERE id = NEW.observation_id;${recovery ? `
        recovery := withdrawal_recovery_payload(NEW.withdrawal_id);` : ''}

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
             SELECT 1 FROM withdrawal_verifications WHERE withdrawal_id = NEW.withdrawal_id AND outcome = 'DEFINITIVE_FAILURE')${
               recovery
                 ? `
             -- W4: a late success after a certified failure only under its approved recovery (§E.2, §I.3).
             AND (recovery ->> 'mode') IS DISTINCT FROM 'COMPLETE_MATCHED_SUCCESS' AND (recovery ->> 'mode') IS DISTINCT FROM 'LATE_FACT_POST'`
                 : ''
             }
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
          END IF;${
            recovery
              ? `
        ELSIF NEW.value_time_basis = 'APPROVED_LATE_FACT' THEN
          -- §F.3: the open-period accounting date an approver chose for a late fact, exactly as approved.
          IF NOT ((NEW.outcome = 'SUCCESS' AND recovery ->> 'mode' = 'LATE_FACT_POST')
                  OR (NEW.outcome = 'FULL_RETURN' AND recovery ->> 'mode' = 'LATE_FACT_RETURN'))
             OR NEW.value_time IS DISTINCT FROM (recovery ->> 'valueTime')::timestamptz THEN
            RAISE EXCEPTION 'an approved late-fact time is the approved recovery''s valueTime, exactly' USING ERRCODE = 'check_violation';
          END IF;`
              : ''
          }
        ELSIF withdrawal.environment <> 'test' OR NEW.value_time IS DISTINCT FROM observation.observed_at THEN
          RAISE EXCEPTION 'an observed test-state time is the matched observation''s time, exactly' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;

const FAILED_TOGETHER = (recovery: boolean) => `
      ALTER TABLE paystack_withdrawals ADD CONSTRAINT paystack_withdrawals_failed_together CHECK (
        (failed_at IS NULL) = (failure_code IS NULL)
        AND (failed_at IS NULL OR posted_at IS NULL${recovery ? ' OR recovery_approval_id IS NOT NULL' : ''})
        AND (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
      )`;

/**
 * Withdrawals W4 (WITHDRAWAL_PLAN.md §I.2, §I.3, §E.2, §F.3; D7):
 *
 * - **Approved late success.** `fx.withdrawal_recovery` (transaction-local, set by the recovery executor) NAMES the
 *   approval being executed; `withdrawal_recovery_payload(flow)` accepts it only when that approval is an APPROVED
 *   `PAYSTACK_WITHDRAWAL_RECOVERY` for this withdrawal — the same shape as `fx.role_change`, but the authority is the
 *   four-eyes row, not the flag. Under it (and only then):
 *   - the flow guard allows FAILED → POSTED (`flow_transition_allowed` is UNCHANGED: it is never a normal transition);
 *   - `paystack_withdrawals.recovery_approval_id` may be set (once) to that approval, and `failed_together` lets
 *     `failed_at` and `posted_at` coexist only with it;
 *   - a SUCCESS certificate may follow a DEFINITIVE_FAILURE one;
 *   - `assert_withdrawal_consistent` accepts, instead of a settled hold, a RELEASED hold + the approval + the principal
 *     posting `post()` made (SYSTEM_DRIVEN; it may overdraw — recorded, never clamped).
 * - **Late facts.** Value-time basis `APPROVED_LATE_FACT` is accepted only when it equals the approved payload's
 *   `valueTime` (LATE_FACT_POST for a success, LATE_FACT_RETURN for a full return).
 * - **`reconciliation_component_progress`**: a durable, resumable watermark per (provider, component) — the historical
 *   transfer census walks from integration inception in windows and never claims coverage it has not read.
 * - **Indexes**: posted-not-reversed withdrawals `(posted_at, flow_id)`; the unresolved payout keyset `(created_at, id)`;
 *   unmatched TRANSFER-family webhooks.
 */
export class WithdrawalReconciliationAndRecovery1791676800001 implements MigrationInterface {
  name = 'WithdrawalReconciliationAndRecovery1791676800001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE paystack_withdrawals ADD COLUMN recovery_approval_id UUID REFERENCES approvals (id)`);
    await queryRunner.query(RECOVERY_PAYLOAD_FUNCTION);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION withdrawal_recovery_payload(UUID) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION withdrawal_recovery_payload(UUID) TO fx_app`);
    await queryRunner.query(`ALTER TABLE paystack_withdrawals DROP CONSTRAINT paystack_withdrawals_failed_together`);
    await queryRunner.query(FAILED_TOGETHER(true));
    await queryRunner.query(`
      ALTER TABLE paystack_withdrawals ADD CONSTRAINT paystack_withdrawals_recovery_after_failure CHECK (
        recovery_approval_id IS NULL OR (failed_at IS NOT NULL AND posted_at IS NOT NULL)
      )
    `);
    await queryRunner.query(WITHDRAWAL_GUARD(true));
    await queryRunner.query(`GRANT UPDATE (recovery_approval_id) ON paystack_withdrawals TO fx_app`);
    await queryRunner.query(FLOW_GUARD(true));
    await queryRunner.query(CONSISTENCY(true));
    await queryRunner.query(VERIFICATION_CHECK(true));

    await queryRunner.query(`
      CREATE TABLE reconciliation_component_progress (
        provider        TEXT        NOT NULL,
        component       TEXT        NOT NULL,
        origin          TIMESTAMPTZ NOT NULL,
        watermark       TIMESTAMPTZ NOT NULL,
        cycles          INTEGER     NOT NULL DEFAULT 0,
        last_run_id     UUID        REFERENCES reconciliation_runs (id),
        last_cycle_completed_at TIMESTAMPTZ,
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (provider, component),
        CONSTRAINT reconciliation_component_progress_names_valid CHECK (
          provider ~ '^[a-z0-9-]{1,32}$' AND component ~ '^[a-z][a-z0-9-]{0,63}$'
        ),
        CONSTRAINT reconciliation_component_progress_watermark_after_origin CHECK (watermark >= origin),
        CONSTRAINT reconciliation_component_progress_cycles_non_negative CHECK (cycles >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION reconciliation_component_progress_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'reconciliation progress is never deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.provider, NEW.component, NEW.origin) IS DISTINCT FROM (OLD.provider, OLD.component, OLD.origin) THEN
          RAISE EXCEPTION 'reconciliation progress identity and origin are immutable' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.cycles < OLD.cycles OR NEW.cycles > OLD.cycles + 1
           OR (NEW.cycles = OLD.cycles AND NEW.watermark < OLD.watermark) THEN
          RAISE EXCEPTION 'reconciliation progress only moves forward (a watermark returns to the origin only with a new cycle)'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER reconciliation_component_progress_guard BEFORE UPDATE OR DELETE ON reconciliation_component_progress
        FOR EACH ROW EXECUTE FUNCTION reconciliation_component_progress_guard()
    `);
    await queryRunner.query(`REVOKE DELETE, TRUNCATE ON reconciliation_component_progress FROM fx_app`);

    await queryRunner.query(`
      CREATE INDEX paystack_withdrawals_posted_unreversed_index ON paystack_withdrawals (posted_at, flow_id)
        WHERE posted_at IS NOT NULL AND reversed_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX flow_instances_unresolved_payout_index ON flow_instances (created_at, id)
        WHERE completed_at IS NULL AND flow_type IN ('PAYSTACK_WITHDRAWAL', 'PAYSTACK_BENEFICIARY')
    `);
    await queryRunner.query(`
      CREATE INDEX webhook_events_unmatched_sealed_index ON webhook_events (provider, received_at, id)
        WHERE outcome = 'UNMATCHED' AND payload_encoding = 'SEALED_V1'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX webhook_events_unmatched_sealed_index`);
    await queryRunner.query(`DROP INDEX flow_instances_unresolved_payout_index`);
    await queryRunner.query(`DROP INDEX paystack_withdrawals_posted_unreversed_index`);
    await queryRunner.query(`DROP TABLE reconciliation_component_progress`);
    await queryRunner.query(`DROP FUNCTION reconciliation_component_progress_guard()`);
    await queryRunner.query(VERIFICATION_CHECK(false));
    await queryRunner.query(CONSISTENCY(false));
    await queryRunner.query(FLOW_GUARD(false));
    await queryRunner.query(`REVOKE UPDATE (recovery_approval_id) ON paystack_withdrawals FROM fx_app`);
    await queryRunner.query(WITHDRAWAL_GUARD(false));
    await queryRunner.query(`ALTER TABLE paystack_withdrawals DROP CONSTRAINT paystack_withdrawals_recovery_after_failure`);
    await queryRunner.query(`ALTER TABLE paystack_withdrawals DROP CONSTRAINT paystack_withdrawals_failed_together`);
    await queryRunner.query(FAILED_TOGETHER(false));
    await queryRunner.query(`DROP FUNCTION withdrawal_recovery_payload(UUID)`);
    await queryRunner.query(`ALTER TABLE paystack_withdrawals DROP COLUMN recovery_approval_id`);
  }
}
