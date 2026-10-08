import { MigrationInterface, QueryRunner } from 'typeorm';

/** Keep in step with `BreakType` (`reconciliation/break-types.ts`); a spec asserts they match. */
export const BREAK_TYPES = [
  'MISSING_IN_LEDGER',
  'PAYMENT_WITHOUT_FLOW',
  'MISSING_AT_PSP',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'UNSETTLED_PAST_WINDOW',
  'UNATTRIBUTED_SETTLEMENT_LINE',
  'DUPLICATE_SETTLEMENT_LINE',
  'CHARGEBACK_NOT_REVERSED',
  'UNMATCHED_WEBHOOK',
  'SETTLEMENT_REPORT_REJECTED',
  'SETTLEMENT_BATCH_CHANGED',
  'SETTLEMENT_IN_LOCKED_PERIOD',
  'RECEIVABLE_PROOF_FAILED',
  'TRIAL_BALANCE_UNBALANCED',
  'ACCOUNTING_EQUATION_FAILED',
  'CACHED_BALANCE_DRIFT',
  'BALANCE_CONTINUITY_BREAK',
  'HASH_CHAIN_BREAK',
  'RESERVED_BALANCE_DRIFT',
  'FX_PROVENANCE_MISMATCH',
] as const;

/**
 * Breaks: every discrepancy reconciliation finds, as a first-class, typed record with a
 * lifecycle (Phase 9; design §8.2 "drift is never fixed by overwriting"). And findings: every
 * violation each run observed, append-only.
 *
 * `reconciliation_breaks`
 * - ONE live break per `(type, subject_key)` (partial unique `WHERE status <> 'RESOLVED'`):
 *   a rerun that sees it again only moves `last_detected_*`. Seen again after resolution →
 *   a NEW row linked by `previous_break_id`.
 * - `status` moves only along `reconciliation_break_transition_allowed` (the SQL mirror of
 *   `break-transitions.ts`): OPEN → ESCALATED | RESOLVED, ESCALATED → RESOLVED.
 * - RESOLVED needs a named cause: kind, reference, who — set once, together. A break that
 *   simply stops being seen is never resolved by that alone.
 * - Identity, evidence (`details`, typed links, amount) and detection origin are immutable.
 * - `fx_app`: column UPDATE on the lifecycle columns only; no DELETE/TRUNCATE.
 *
 * `reconciliation_findings` — append-only evidence (superuser included): what a run measured.
 */
export class CreateReconciliationBreaks1791158400004 implements MigrationInterface {
  name = 'CreateReconciliationBreaks1791158400004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE reconciliation_break_type AS ENUM (${BREAK_TYPES.map((type) => `'${type}'`).join(', ')})`,
    );
    await queryRunner.query(`CREATE TYPE reconciliation_break_status AS ENUM ('OPEN', 'ESCALATED', 'RESOLVED')`);
    // CORRECTION_POSTED and OPERATOR_RESOLVED are for Phase 10's admin resolutions (schema ready).
    await queryRunner.query(`
      CREATE TYPE reconciliation_resolution_kind AS ENUM
        ('FLOW_ADVANCED', 'REVERSAL_POSTED', 'WEBHOOK_REPROCESSED', 'SETTLED_LATE', 'REPORT_INGESTED',
         'CORRECTION_POSTED', 'OPERATOR_RESOLVED')
    `);

    await queryRunner.query(`
      CREATE FUNCTION reconciliation_break_transition_allowed(from_status TEXT, to_status TEXT) RETURNS BOOLEAN AS $$
        SELECT (from_status, to_status) IN (('OPEN', 'ESCALATED'), ('OPEN', 'RESOLVED'), ('ESCALATED', 'RESOLVED'))
      $$ LANGUAGE sql IMMUTABLE
    `);

    await queryRunner.query(`
      CREATE TABLE reconciliation_breaks (
        id                        UUID                          PRIMARY KEY DEFAULT gen_random_uuid(),
        type                      reconciliation_break_type     NOT NULL,
        subject_key               TEXT                          NOT NULL,
        status                    reconciliation_break_status   NOT NULL DEFAULT 'OPEN',
        currency_code             CHAR(3)                       REFERENCES currencies (code),
        amount_minor              BIGINT                        NOT NULL DEFAULT 0,
        details                   JSONB                         NOT NULL DEFAULT '{}',
        flow_id                   UUID                          REFERENCES flow_instances (id),
        provider_payment_id       TEXT,
        settlement_batch_id       UUID                          REFERENCES settlement_batches (id),
        settlement_batch_line_id  UUID                          REFERENCES settlement_batch_lines (id),
        webhook_event_id          UUID                          REFERENCES webhook_events (id),
        ledger_account_id         UUID                          REFERENCES accounts (id),
        detected_by_run_id        UUID                          NOT NULL REFERENCES reconciliation_runs (id),
        first_detected_at         TIMESTAMPTZ                   NOT NULL DEFAULT now(),
        last_detected_run_id      UUID                          NOT NULL REFERENCES reconciliation_runs (id),
        last_detected_at          TIMESTAMPTZ                   NOT NULL DEFAULT now(),
        previous_break_id         UUID                          REFERENCES reconciliation_breaks (id),
        escalated_at              TIMESTAMPTZ,
        resolved_at               TIMESTAMPTZ,
        resolution_kind           reconciliation_resolution_kind,
        resolution_reference      TEXT,
        resolved_by               TEXT,
        resolution_note           TEXT,
        updated_at                TIMESTAMPTZ                   NOT NULL DEFAULT now(),

        CONSTRAINT reconciliation_breaks_subject_present CHECK (length(subject_key) > 0),
        CONSTRAINT reconciliation_breaks_amount_non_negative CHECK (amount_minor >= 0),
        CONSTRAINT reconciliation_breaks_escalated_stamped CHECK (status <> 'ESCALATED' OR escalated_at IS NOT NULL),
        -- Every column spelled out: a CHECK passes when it evaluates to NULL.
        CONSTRAINT reconciliation_breaks_resolution_complete CHECK (
          (status = 'RESOLVED') = (resolved_at IS NOT NULL)
          AND (status = 'RESOLVED') = (resolution_kind IS NOT NULL)
          AND (status = 'RESOLVED') = (resolution_reference IS NOT NULL)
          AND (status = 'RESOLVED') = (resolved_by IS NOT NULL)
        ),
        CONSTRAINT reconciliation_breaks_resolved_by_format CHECK (resolved_by ~ '^(job|operator):.+$')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX reconciliation_breaks_live_subject_unique
        ON reconciliation_breaks (type, subject_key) WHERE status <> 'RESOLVED'
    `);
    await queryRunner.query(`CREATE INDEX reconciliation_breaks_live_index ON reconciliation_breaks (status, type) WHERE status <> 'RESOLVED'`);
    await queryRunner.query(`CREATE INDEX reconciliation_breaks_flow_index ON reconciliation_breaks (flow_id) WHERE flow_id IS NOT NULL`);

    await queryRunner.query(`
      CREATE FUNCTION reconciliation_breaks_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'reconciliation breaks are never deleted (attempted DELETE on %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.type IS DISTINCT FROM OLD.type
           OR NEW.subject_key IS DISTINCT FROM OLD.subject_key OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
           OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.details IS DISTINCT FROM OLD.details
           OR NEW.flow_id IS DISTINCT FROM OLD.flow_id OR NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id
           OR NEW.settlement_batch_id IS DISTINCT FROM OLD.settlement_batch_id
           OR NEW.settlement_batch_line_id IS DISTINCT FROM OLD.settlement_batch_line_id
           OR NEW.webhook_event_id IS DISTINCT FROM OLD.webhook_event_id
           OR NEW.ledger_account_id IS DISTINCT FROM OLD.ledger_account_id
           OR NEW.detected_by_run_id IS DISTINCT FROM OLD.detected_by_run_id
           OR NEW.first_detected_at IS DISTINCT FROM OLD.first_detected_at
           OR NEW.previous_break_id IS DISTINCT FROM OLD.previous_break_id THEN
          RAISE EXCEPTION 'reconciliation break % identity and evidence are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.status IS DISTINCT FROM OLD.status
           AND NOT reconciliation_break_transition_allowed(OLD.status::text, NEW.status::text) THEN
          RAISE EXCEPTION 'reconciliation break % cannot move from % to %', OLD.id, OLD.status, NEW.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status = 'RESOLVED' AND (NEW.last_detected_run_id IS DISTINCT FROM OLD.last_detected_run_id
                                        OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note) THEN
          RAISE EXCEPTION 'reconciliation break % is resolved and immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (OLD.escalated_at IS NOT NULL AND NEW.escalated_at IS DISTINCT FROM OLD.escalated_at)
           OR (OLD.resolved_at IS NOT NULL AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at)
           OR (OLD.resolution_kind IS NOT NULL AND NEW.resolution_kind IS DISTINCT FROM OLD.resolution_kind)
           OR (OLD.resolution_reference IS NOT NULL AND NEW.resolution_reference IS DISTINCT FROM OLD.resolution_reference)
           OR (OLD.resolved_by IS NOT NULL AND NEW.resolved_by IS DISTINCT FROM OLD.resolved_by) THEN
          RAISE EXCEPTION 'reconciliation break % has already recorded that fact', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER reconciliation_breaks_guard_mutation BEFORE UPDATE OR DELETE ON reconciliation_breaks
        FOR EACH ROW EXECUTE FUNCTION reconciliation_breaks_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON reconciliation_breaks FROM fx_app`);
    await queryRunner.query(`
      GRANT UPDATE (status, last_detected_run_id, last_detected_at, escalated_at, resolved_at, resolution_kind,
                    resolution_reference, resolved_by, resolution_note, updated_at)
        ON reconciliation_breaks TO fx_app
    `);

    await queryRunner.query(`
      CREATE TABLE reconciliation_findings (
        id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        run_id         UUID        NOT NULL REFERENCES reconciliation_runs (id),
        kind           TEXT        NOT NULL,
        currency_code  CHAR(3)     REFERENCES currencies (code),
        subject        TEXT        NOT NULL,
        measured       JSONB       NOT NULL DEFAULT '{}',
        drift_minor    BIGINT      NOT NULL DEFAULT 0,
        break_id       UUID        REFERENCES reconciliation_breaks (id),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT reconciliation_findings_kind_format CHECK (kind ~ '^[A-Z][A-Z_]*$'),
        CONSTRAINT reconciliation_findings_drift_non_negative CHECK (drift_minor >= 0)
      )
    `);
    await queryRunner.query(`CREATE INDEX reconciliation_findings_run_index ON reconciliation_findings (run_id)`);
    await queryRunner.query(`
      CREATE FUNCTION reconciliation_findings_refuse_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'reconciliation findings are append-only evidence (attempted %)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER reconciliation_findings_refuse_mutation BEFORE UPDATE OR DELETE ON reconciliation_findings
        FOR EACH ROW EXECUTE FUNCTION reconciliation_findings_refuse_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER reconciliation_findings_refuse_truncate BEFORE TRUNCATE ON reconciliation_findings
        FOR EACH STATEMENT EXECUTE FUNCTION reconciliation_findings_refuse_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON reconciliation_findings FROM fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE reconciliation_findings`);
    await queryRunner.query(`DROP FUNCTION reconciliation_findings_refuse_mutation()`);
    await queryRunner.query(`DROP TABLE reconciliation_breaks`);
    await queryRunner.query(`DROP FUNCTION reconciliation_breaks_guard_mutation()`);
    await queryRunner.query(`DROP FUNCTION reconciliation_break_transition_allowed(TEXT, TEXT)`);
    await queryRunner.query(`DROP TYPE reconciliation_resolution_kind`);
    await queryRunner.query(`DROP TYPE reconciliation_break_status`);
    await queryRunner.query(`DROP TYPE reconciliation_break_type`);
  }
}
