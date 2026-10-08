import { MigrationInterface, QueryRunner } from 'typeorm';

const EXISTING_TRANSITIONS = `
          WHEN 'FUNDING' THEN (from_state, to_state) IN (
            ('INITIATED', 'AUTHORIZED'), ('INITIATED', 'FAILED'),
            ('AUTHORIZED', 'CAPTURED'), ('AUTHORIZED', 'FAILED'),
            ('CAPTURED', 'POSTED'),
            ('POSTED', 'SETTLED'), ('POSTED', 'REVERSED'),
            ('SETTLED', 'REVERSED'))
          WHEN 'CONVERSION' THEN (from_state, to_state) IN (('INITIATED', 'POSTED'))
          WHEN 'PAYSTACK_FUNDING' THEN (from_state, to_state) IN (
            ('INITIATED', 'CHECKOUT_READY'), ('INITIATED', 'POSTED'), ('INITIATED', 'FAILED'), ('INITIATED', 'HELD'),
            ('CHECKOUT_READY', 'POSTED'), ('CHECKOUT_READY', 'FAILED'), ('CHECKOUT_READY', 'HELD'),
            ('POSTED', 'SETTLED'), ('POSTED', 'REVERSED'),
            ('SETTLED', 'REVERSED'))`;

const WITHDRAWAL_TRANSITIONS = `
          WHEN 'PAYSTACK_WITHDRAWAL' THEN (from_state, to_state) IN (
            ('RESERVED', 'SUBMITTING'), ('RESERVED', 'FAILED'),
            ('SUBMITTING', 'PROCESSING'), ('SUBMITTING', 'POSTED'), ('SUBMITTING', 'FAILED'),
            ('PROCESSING', 'POSTED'), ('PROCESSING', 'FAILED'),
            ('POSTED', 'REVERSED'))
          WHEN 'PAYSTACK_BENEFICIARY' THEN (from_state, to_state) IN (
            ('REQUESTED', 'RESOLVED'), ('REQUESTED', 'FAILED'),
            ('RESOLVED', 'CREATING'), ('RESOLVED', 'FAILED'),
            ('CREATING', 'READY'), ('CREATING', 'FAILED'))`;

const STATE_VALID = (withdrawals: boolean) => `
      ALTER TABLE flow_instances ADD CONSTRAINT flow_instances_state_valid CHECK (
        (flow_type <> 'FUNDING'
          OR state IN ('INITIATED', 'AUTHORIZED', 'CAPTURED', 'POSTED', 'SETTLED', 'FAILED', 'REVERSED'))
        AND (flow_type <> 'CONVERSION' OR state IN ('INITIATED', 'POSTED'))
        AND (flow_type <> 'PAYSTACK_FUNDING'
          OR state IN ('INITIATED', 'CHECKOUT_READY', 'POSTED', 'SETTLED', 'FAILED', 'REVERSED', 'HELD'))${
          withdrawals
            ? `
        AND (flow_type <> 'PAYSTACK_WITHDRAWAL'
          OR state IN ('RESERVED', 'SUBMITTING', 'PROCESSING', 'POSTED', 'FAILED', 'REVERSED'))
        AND (flow_type <> 'PAYSTACK_BENEFICIARY'
          OR state IN ('REQUESTED', 'RESOLVED', 'CREATING', 'READY', 'FAILED'))`
            : ''
        }
      )`;

const FLOW_GUARD = (completionStates: string) => `
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
           AND NOT flow_transition_allowed(OLD.flow_type, OLD.state, NEW.state) THEN
          RAISE EXCEPTION 'flow % (%) cannot move from % to %', OLD.id, OLD.flow_type, OLD.state, NEW.state
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
          RAISE EXCEPTION 'flow % completion time is set once', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
           AND NEW.state NOT IN (${completionStates}) THEN
          RAISE EXCEPTION 'flow % cannot complete in state %', OLD.id, NEW.state
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql`;

/**
 * Withdrawal state machines (WITHDRAWAL_PLAN.md §E.1, §E.2; D1–D9 approved 2026-10-03).
 *
 * - `PAYSTACK_WITHDRAWAL`: `RESERVED → SUBMITTING → PROCESSING → POSTED → REVERSED`, with `FAILED` from RESERVED (a
 *   conclusively unsent cancellation) or after a definitive verified non-payment. No RESERVED → POSTED shortcut: an
 *   external success without a committed submission marker is an authorization break, not a completion.
 * - `PAYSTACK_BENEFICIARY`: `REQUESTED → RESOLVED → CREATING → READY`, `FAILED` before READY. READY is final.
 * - Completion states gain READY. POSTED stays legal to leave (→ REVERSED), exactly as funding's POSTED.
 * - The approved late-success recovery edge (FAILED → POSTED) is W4's, behind its own guard; it is not here.
 * - `paystack-withdrawal-transitions.ts` / `paystack-beneficiary-transitions.ts` mirror this, tested pair for pair.
 */
export class WithdrawalFlowStates1791417600001 implements MigrationInterface {
  name = 'WithdrawalFlowStates1791417600001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION flow_transition_allowed(type flow_type, from_state TEXT, to_state TEXT) RETURNS BOOLEAN AS $$
        SELECT CASE type${EXISTING_TRANSITIONS}${WITHDRAWAL_TRANSITIONS}
          ELSE FALSE
        END
      $$ LANGUAGE sql IMMUTABLE
    `);
    await queryRunner.query(`ALTER TABLE flow_instances DROP CONSTRAINT flow_instances_state_valid`);
    await queryRunner.query(STATE_VALID(true));
    await queryRunner.query(FLOW_GUARD(`'POSTED', 'SETTLED', 'FAILED', 'REVERSED', 'HELD', 'READY'`));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(FLOW_GUARD(`'POSTED', 'SETTLED', 'FAILED', 'REVERSED', 'HELD'`));
    await queryRunner.query(`ALTER TABLE flow_instances DROP CONSTRAINT flow_instances_state_valid`);
    await queryRunner.query(STATE_VALID(false));
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION flow_transition_allowed(type flow_type, from_state TEXT, to_state TEXT) RETURNS BOOLEAN AS $$
        SELECT CASE type${EXISTING_TRANSITIONS}
          ELSE FALSE
        END
      $$ LANGUAGE sql IMMUTABLE
    `);
  }
}
