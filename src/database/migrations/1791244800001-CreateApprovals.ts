import { MigrationInterface, QueryRunner } from 'typeorm';

/** Keep in step with `ApprovalActionType` (`admin/approvals/approval.types.ts`); a spec asserts they match. */
export const APPROVAL_ACTION_TYPES = [
  'CORRECTION',
  'WRITE_OFF',
  'RATE_OVERRIDE',
  'SPREAD_CHANGE',
  'SUSPEND_USER',
  'REINSTATE_USER',
  'CLOSE_PERIOD',
  'ROLE_CHANGE',
  'RESOLVE_BREAK',
] as const;

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'EXECUTED', 'EXECUTION_FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const;

/**
 * `approvals` (design §9.2; Phase 10 plan §B): four-eyes as a property of the SCHEMA, not of the service.
 *
 * - `four_eyes`: the approver is never the requester (the design's CHECK, verbatim). A rejecter and a
 *   break-glass reviewer are never the requester either.
 * - One decision, ever: `status` moves only along `approval_transition_allowed` (the SQL mirror of
 *   `approval-transitions.ts`): PENDING → APPROVED | REJECTED | CANCELLED | EXPIRED, APPROVED → EXECUTED |
 *   EXECUTION_FAILED. EXECUTED is reachable ONLY through APPROVED — except break-glass, which goes PENDING →
 *   EXECUTED | EXECUTION_FAILED with no approver and the flag set, for SUSPEND_USER and RATE_OVERRIDE only.
 *   Every decision column is set once, together with its status (the shape CHECKs spell every column out:
 *   a CHECK passes on NULL).
 * - Who may decide is checked HERE too (`approvals_check_eligibility`): the requester and the decider are
 *   locked `FOR SHARE` and must be ACTIVE with the role the action needs (`approval_decider_role`), so an
 *   approval racing the requester's (or approver's) role revocation serialises on the user row.
 * - The request (type, payload, its hash, reason, requester, expiry, flag, break) is immutable.
 * - Evidence: no DELETE or TRUNCATE, for a superuser too. `fx_app` UPDATEs the decision columns only.
 */
export class CreateApprovals1791244800001 implements MigrationInterface {
  name = 'CreateApprovals1791244800001';

  async up(queryRunner: QueryRunner): Promise<void> {
    const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
    await queryRunner.query(`CREATE TYPE approval_action_type AS ENUM (${list(APPROVAL_ACTION_TYPES)})`);
    await queryRunner.query(`CREATE TYPE approval_status AS ENUM (${list(APPROVAL_STATUSES)})`);

    await queryRunner.query(`
      CREATE FUNCTION approval_transition_allowed(from_status TEXT, to_status TEXT, is_break_glass BOOLEAN) RETURNS BOOLEAN AS $$
        SELECT CASE WHEN is_break_glass
          THEN (from_status, to_status) IN (('PENDING', 'EXECUTED'), ('PENDING', 'EXECUTION_FAILED'))
          ELSE (from_status, to_status) IN (
            ('PENDING', 'APPROVED'), ('PENDING', 'REJECTED'), ('PENDING', 'CANCELLED'), ('PENDING', 'EXPIRED'),
            ('APPROVED', 'EXECUTED'), ('APPROVED', 'EXECUTION_FAILED'))
        END
      $$ LANGUAGE sql IMMUTABLE
    `);
    // Who approves (and rejects) each action: a SECURITY officer for role changes, an ADMIN otherwise.
    await queryRunner.query(`
      CREATE FUNCTION approval_decider_role(action approval_action_type) RETURNS user_role AS $$
        SELECT CASE WHEN action = 'ROLE_CHANGE' THEN 'SECURITY'::user_role ELSE 'ADMIN'::user_role END
      $$ LANGUAGE sql IMMUTABLE
    `);

    await queryRunner.query(`
      CREATE TABLE approvals (
        id                              UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
        action_type                     approval_action_type NOT NULL,
        payload                         JSONB                NOT NULL,
        payload_hash                    CHAR(64)             NOT NULL,
        reason                          TEXT                 NOT NULL,
        status                          approval_status      NOT NULL DEFAULT 'PENDING',
        is_break_glass                  BOOLEAN              NOT NULL DEFAULT FALSE,
        break_id                        UUID                 REFERENCES reconciliation_breaks (id),
        requested_by                    UUID                 NOT NULL REFERENCES users (id),
        requested_at                    TIMESTAMPTZ          NOT NULL DEFAULT now(),
        expires_at                      TIMESTAMPTZ          NOT NULL,
        approved_by                     UUID                 REFERENCES users (id),
        approved_at                     TIMESTAMPTZ,
        rejected_by                     UUID                 REFERENCES users (id),
        rejected_at                     TIMESTAMPTZ,
        rejection_reason                TEXT,
        cancelled_by                    UUID                 REFERENCES users (id),
        cancelled_at                    TIMESTAMPTZ,
        expired_at                      TIMESTAMPTZ,
        executed_by                     UUID                 REFERENCES users (id),
        executed_at                     TIMESTAMPTZ,
        execution_failure_code          TEXT,
        result_reference                TEXT,
        break_glass_reviewed_by         UUID                 REFERENCES users (id),
        break_glass_reviewed_at         TIMESTAMPTZ,
        break_glass_review_note         TEXT,
        break_glass_overdue_alerted_at  TIMESTAMPTZ,
        updated_at                      TIMESTAMPTZ          NOT NULL DEFAULT now(),

        -- The design's constraint, verbatim: the approver is a different person.
        CONSTRAINT four_eyes CHECK (approved_by IS NULL OR approved_by <> requested_by),
        CONSTRAINT approvals_rejecter_differs CHECK (rejected_by IS NULL OR rejected_by <> requested_by),
        CONSTRAINT approvals_reviewer_differs CHECK (break_glass_reviewed_by IS NULL OR break_glass_reviewed_by <> requested_by),
        CONSTRAINT approvals_payload_hash_hex CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT approvals_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
        CONSTRAINT approvals_reason_present CHECK (length(reason) BETWEEN 1 AND 500),
        CONSTRAINT approvals_expiry_after_request CHECK (expires_at > requested_at),
        CONSTRAINT approvals_break_glass_subset CHECK (NOT is_break_glass OR action_type IN ('SUSPEND_USER', 'RATE_OVERRIDE')),

        -- Status shapes. Every column spelled out: a CHECK passes when it evaluates to NULL.
        CONSTRAINT approvals_approval_recorded CHECK (
          (approved_by IS NULL) = (approved_at IS NULL)
          AND (approved_by IS NOT NULL) = (status IN ('APPROVED', 'EXECUTED', 'EXECUTION_FAILED') AND NOT is_break_glass)
        ),
        CONSTRAINT approvals_rejection_recorded CHECK (
          (status = 'REJECTED') = (rejected_by IS NOT NULL)
          AND (status = 'REJECTED') = (rejected_at IS NOT NULL)
          AND (status = 'REJECTED') = (rejection_reason IS NOT NULL)
          AND (rejection_reason IS NULL OR length(rejection_reason) BETWEEN 1 AND 500)
        ),
        CONSTRAINT approvals_cancellation_recorded CHECK (
          (status = 'CANCELLED') = (cancelled_by IS NOT NULL)
          AND (status = 'CANCELLED') = (cancelled_at IS NOT NULL)
          AND (cancelled_by IS NULL OR cancelled_by = requested_by)
        ),
        CONSTRAINT approvals_expiry_recorded CHECK ((status = 'EXPIRED') = (expired_at IS NOT NULL)),
        CONSTRAINT approvals_execution_recorded CHECK (
          (status IN ('EXECUTED', 'EXECUTION_FAILED')) = (executed_at IS NOT NULL)
          AND (status IN ('EXECUTED', 'EXECUTION_FAILED')) = (executed_by IS NOT NULL)
          AND (status = 'EXECUTED') = (result_reference IS NOT NULL)
          AND (status = 'EXECUTION_FAILED') = (execution_failure_code IS NOT NULL)
        ),
        -- The approver executes (in the approve transaction); a break-glass actor executes their own.
        CONSTRAINT approvals_executor_is_decider CHECK (
          executed_by IS NULL
          OR (is_break_glass AND executed_by = requested_by)
          OR (NOT is_break_glass AND approved_by IS NOT NULL AND executed_by = approved_by)
        ),
        CONSTRAINT approvals_review_recorded CHECK (
          (break_glass_reviewed_by IS NULL) = (break_glass_reviewed_at IS NULL)
          AND (break_glass_reviewed_by IS NULL) = (break_glass_review_note IS NULL)
          AND (break_glass_reviewed_by IS NULL OR (is_break_glass AND status IN ('EXECUTED', 'EXECUTION_FAILED')))
          AND (break_glass_overdue_alerted_at IS NULL OR is_break_glass)
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX approvals_requested_index ON approvals (requested_at DESC, id DESC)`);
    await queryRunner.query(`CREATE INDEX approvals_status_requested_index ON approvals (status, requested_at DESC, id DESC)`);
    await queryRunner.query(`CREATE INDEX approvals_break_index ON approvals (break_id) WHERE break_id IS NOT NULL`);
    await queryRunner.query(`
      CREATE INDEX approvals_break_glass_unreviewed_index ON approvals (requested_at)
        WHERE is_break_glass AND break_glass_reviewed_at IS NULL
    `);
    // Not unique: a revoke returns the assignment its grant created, two suspensions of one user both return the
    // user. "Executed at most once" is the transition trigger's (and a posting's reference `approval:{id}`).
    await queryRunner.query(`
      CREATE INDEX approvals_result_reference_index ON approvals (result_reference) WHERE result_reference IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE FUNCTION approvals_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'approvals are never deleted (attempted DELETE on %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.action_type IS DISTINCT FROM OLD.action_type
           OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
           OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.is_break_glass IS DISTINCT FROM OLD.is_break_glass
           OR NEW.break_id IS DISTINCT FROM OLD.break_id OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
           OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
          RAISE EXCEPTION 'approval % request is immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.status IS DISTINCT FROM OLD.status THEN
          IF NOT approval_transition_allowed(OLD.status::text, NEW.status::text, OLD.is_break_glass) THEN
            RAISE EXCEPTION 'approval % cannot move from % to %', OLD.id, OLD.status, NEW.status
              USING ERRCODE = 'integrity_constraint_violation';
          END IF;
        ELSIF (NEW.approved_by, NEW.approved_at, NEW.rejected_by, NEW.rejected_at, NEW.rejection_reason, NEW.cancelled_by,
               NEW.cancelled_at, NEW.expired_at, NEW.executed_by, NEW.executed_at, NEW.execution_failure_code,
               NEW.result_reference)
              IS DISTINCT FROM
              (OLD.approved_by, OLD.approved_at, OLD.rejected_by, OLD.rejected_at, OLD.rejection_reason, OLD.cancelled_by,
               OLD.cancelled_at, OLD.expired_at, OLD.executed_by, OLD.executed_at, OLD.execution_failure_code,
               OLD.result_reference) THEN
          RAISE EXCEPTION 'approval % decision columns change only with its status', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        -- Set once: a decision, once recorded, is never rewritten (APPROVED → EXECUTED keeps the approver).
        IF (OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by)
           OR (OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at)
           OR (OLD.break_glass_reviewed_by IS NOT NULL AND NEW.break_glass_reviewed_by IS DISTINCT FROM OLD.break_glass_reviewed_by)
           OR (OLD.break_glass_reviewed_at IS NOT NULL AND NEW.break_glass_reviewed_at IS DISTINCT FROM OLD.break_glass_reviewed_at)
           OR (OLD.break_glass_review_note IS NOT NULL AND NEW.break_glass_review_note IS DISTINCT FROM OLD.break_glass_review_note)
           OR (OLD.break_glass_overdue_alerted_at IS NOT NULL
               AND NEW.break_glass_overdue_alerted_at IS DISTINCT FROM OLD.break_glass_overdue_alerted_at) THEN
          RAISE EXCEPTION 'approval % has already recorded that fact', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER approvals_guard_mutation BEFORE UPDATE OR DELETE ON approvals
        FOR EACH ROW EXECUTE FUNCTION approvals_guard_mutation()
    `);

    // Eligibility, re-read under a row lock on each person involved (deny unless ACTIVE with the role).
    await queryRunner.query(`
      CREATE FUNCTION approval_actor_eligible(actor UUID, required user_role) RETURNS BOOLEAN AS $$
        SELECT EXISTS (SELECT 1 FROM users WHERE id = actor AND status = 'ACTIVE' AND role = required)
      $$ LANGUAGE sql STABLE
    `);
    await queryRunner.query(`
      CREATE FUNCTION approvals_check_eligibility() RETURNS trigger AS $$
      DECLARE
        decider UUID;
      BEGIN
        IF TG_OP = 'INSERT' THEN
          IF NEW.status <> 'PENDING' THEN
            RAISE EXCEPTION 'an approval is requested PENDING, not %', NEW.status USING ERRCODE = 'integrity_constraint_violation';
          END IF;
          PERFORM 1 FROM users WHERE id = NEW.requested_by FOR SHARE;
          IF NOT approval_actor_eligible(NEW.requested_by, 'ADMIN') THEN
            RAISE EXCEPTION 'approval requester % is not an active ADMIN', NEW.requested_by USING ERRCODE = 'insufficient_privilege';
          END IF;
          RETURN NEW;
        END IF;

        IF OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED') THEN
          decider := COALESCE(NEW.approved_by, NEW.rejected_by);
        ELSIF OLD.status = 'PENDING' AND NEW.status IN ('EXECUTED', 'EXECUTION_FAILED') THEN
          decider := NULL;  -- break-glass: the requester alone, checked below
        ELSE
          decider := NULL;
        END IF;

        IF OLD.status = 'PENDING' AND NEW.status IN ('APPROVED', 'REJECTED', 'EXECUTED', 'EXECUTION_FAILED') THEN
          PERFORM 1 FROM users WHERE id IN (NEW.requested_by, decider) ORDER BY id FOR SHARE;
          IF NOT approval_actor_eligible(NEW.requested_by, 'ADMIN') THEN
            RAISE EXCEPTION 'approval % requester is no longer an active ADMIN', NEW.id USING ERRCODE = 'insufficient_privilege';
          END IF;
          IF decider IS NOT NULL AND NOT approval_actor_eligible(decider, approval_decider_role(NEW.action_type)) THEN
            RAISE EXCEPTION 'approval % decider % may not decide %', NEW.id, decider, NEW.action_type
              USING ERRCODE = 'insufficient_privilege';
          END IF;
        END IF;

        IF OLD.break_glass_reviewed_by IS NULL AND NEW.break_glass_reviewed_by IS NOT NULL THEN
          PERFORM 1 FROM users WHERE id = NEW.break_glass_reviewed_by FOR SHARE;
          IF NOT approval_actor_eligible(NEW.break_glass_reviewed_by, 'SECURITY') THEN
            RAISE EXCEPTION 'approval % reviewer is not an active SECURITY officer', NEW.id USING ERRCODE = 'insufficient_privilege';
          END IF;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER approvals_check_eligibility BEFORE INSERT OR UPDATE ON approvals
        FOR EACH ROW EXECUTE FUNCTION approvals_check_eligibility()
    `);
    await queryRunner.query(`
      CREATE FUNCTION approvals_refuse_truncate() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'approvals are the control trail and are never truncated' USING ERRCODE = 'integrity_constraint_violation';
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER approvals_refuse_truncate BEFORE TRUNCATE ON approvals
        FOR EACH STATEMENT EXECUTE FUNCTION approvals_refuse_truncate()
    `);

    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON approvals FROM fx_app`);
    await queryRunner.query(`
      GRANT UPDATE (status, approved_by, approved_at, rejected_by, rejected_at, rejection_reason, cancelled_by, cancelled_at,
                    expired_at, executed_by, executed_at, execution_failure_code, result_reference, break_glass_reviewed_by,
                    break_glass_reviewed_at, break_glass_review_note, break_glass_overdue_alerted_at, updated_at)
        ON approvals TO fx_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE approvals`);
    await queryRunner.query(`DROP FUNCTION approvals_refuse_truncate()`);
    await queryRunner.query(`DROP FUNCTION approvals_check_eligibility()`);
    await queryRunner.query(`DROP FUNCTION approval_actor_eligible(UUID, user_role)`);
    await queryRunner.query(`DROP FUNCTION approvals_guard_mutation()`);
    await queryRunner.query(`DROP FUNCTION approval_decider_role(approval_action_type)`);
    await queryRunner.query(`DROP FUNCTION approval_transition_allowed(TEXT, TEXT, BOOLEAN)`);
    await queryRunner.query(`DROP TYPE approval_status`);
    await queryRunner.query(`DROP TYPE approval_action_type`);
  }
}
