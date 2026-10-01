import { MigrationInterface, QueryRunner } from 'typeorm';

const FUNDING_TRANSITIONS = `
          WHEN 'FUNDING' THEN (from_state, to_state) IN (
            ('INITIATED', 'AUTHORIZED'), ('INITIATED', 'FAILED'),
            ('AUTHORIZED', 'CAPTURED'), ('AUTHORIZED', 'FAILED'),
            ('CAPTURED', 'POSTED'),
            ('POSTED', 'SETTLED'), ('POSTED', 'REVERSED'),
            ('SETTLED', 'REVERSED'))
          WHEN 'CONVERSION' THEN (from_state, to_state) IN (('INITIATED', 'POSTED'))`;

const PAYSTACK_FUNDING_TRANSITIONS = `
          WHEN 'PAYSTACK_FUNDING' THEN (from_state, to_state) IN (
            ('INITIATED', 'CHECKOUT_READY'), ('INITIATED', 'POSTED'), ('INITIATED', 'FAILED'), ('INITIATED', 'HELD'),
            ('CHECKOUT_READY', 'POSTED'), ('CHECKOUT_READY', 'FAILED'), ('CHECKOUT_READY', 'HELD'),
            ('POSTED', 'SETTLED'), ('POSTED', 'REVERSED'),
            ('SETTLED', 'REVERSED'))`;

const STATE_VALID = (paystack: boolean) => `
      ALTER TABLE flow_instances ADD CONSTRAINT flow_instances_state_valid CHECK (
        (flow_type <> 'FUNDING'
          OR state IN ('INITIATED', 'AUTHORIZED', 'CAPTURED', 'POSTED', 'SETTLED', 'FAILED', 'REVERSED'))
        AND (flow_type <> 'CONVERSION' OR state IN ('INITIATED', 'POSTED'))${
          paystack
            ? `
        AND (flow_type <> 'PAYSTACK_FUNDING'
          OR state IN ('INITIATED', 'CHECKOUT_READY', 'POSTED', 'SETTLED', 'FAILED', 'REVERSED', 'HELD'))`
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
 * Paystack funding flows (PAYSTACK_PLAN.md C2, D2).
 *
 * - `PAYSTACK_FUNDING`: `INITIATED → CHECKOUT_READY → POSTED`, failures to `FAILED`, a verified success whose amount or
 *   currency differs from ours to `HELD` (no credit; completion state — a human resolves it), chargebacks
 *   `POSTED | SETTLED → REVERSED`. `paystack-funding-transitions.ts` is the TypeScript mirror (tested pair for pair).
 *   `INITIATED → POSTED | HELD` is only the "initialize accepted, answer lost, and the read-back shows it paid" path.
 * - `HELD` joins the completion states (the resumer has no more work); FUNDING's and CONVERSION's rules are unchanged.
 * - `funding_payments` + the checkout Paystack returned (`checkout_authorization_url`, `checkout_access_code`) and OUR
 *   window end (`checkout_expires_at`): set once, together, by a trigger of their own (the Phase 9 guard is untouched).
 * - By construction: a `paystack` funding payment belongs to a `PAYSTACK_FUNDING` flow and nothing else does (insert
 *   trigger), so neither provider's flow can ever be driven by the other's adapter.
 */
export class PaystackFunding1791331200001 implements MigrationInterface {
  name = 'PaystackFunding1791331200001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION flow_transition_allowed(type flow_type, from_state TEXT, to_state TEXT) RETURNS BOOLEAN AS $$
        SELECT CASE type${FUNDING_TRANSITIONS}${PAYSTACK_FUNDING_TRANSITIONS}
          ELSE FALSE
        END
      $$ LANGUAGE sql IMMUTABLE
    `);
    await queryRunner.query(`ALTER TABLE flow_instances DROP CONSTRAINT flow_instances_state_valid`);
    await queryRunner.query(STATE_VALID(true));
    await queryRunner.query(FLOW_GUARD(`'POSTED', 'SETTLED', 'FAILED', 'REVERSED', 'HELD'`));

    await queryRunner.query(`
      ALTER TABLE funding_payments
        ADD COLUMN checkout_authorization_url TEXT,
        ADD COLUMN checkout_access_code       TEXT,
        ADD COLUMN checkout_expires_at        TIMESTAMPTZ,
        ADD CONSTRAINT funding_payments_checkout_together CHECK (
          (checkout_authorization_url IS NULL) = (checkout_access_code IS NULL)
          AND (checkout_authorization_url IS NULL) = (checkout_expires_at IS NULL)
        ),
        ADD CONSTRAINT funding_payments_checkout_only_paystack CHECK (
          checkout_authorization_url IS NULL OR provider = 'paystack'
        ),
        ADD CONSTRAINT funding_payments_checkout_url_https CHECK (
          checkout_authorization_url IS NULL OR checkout_authorization_url ~ '^https?://'
        )
    `);
    await queryRunner.query(`
      CREATE FUNCTION funding_payments_guard_checkout() RETURNS trigger AS $$
      BEGIN
        IF (OLD.checkout_authorization_url IS NOT NULL AND NEW.checkout_authorization_url IS DISTINCT FROM OLD.checkout_authorization_url)
           OR (OLD.checkout_access_code IS NOT NULL AND NEW.checkout_access_code IS DISTINCT FROM OLD.checkout_access_code)
           OR (OLD.checkout_expires_at IS NOT NULL AND NEW.checkout_expires_at IS DISTINCT FROM OLD.checkout_expires_at) THEN
          RAISE EXCEPTION 'funding payment % checkout is set once', OLD.flow_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER funding_payments_guard_checkout BEFORE UPDATE ON funding_payments
        FOR EACH ROW EXECUTE FUNCTION funding_payments_guard_checkout()
    `);
    await queryRunner.query(`
      CREATE FUNCTION funding_payments_check_provider_flow() RETURNS trigger AS $$
      DECLARE
        type flow_type;
      BEGIN
        SELECT flow_type INTO type FROM flow_instances WHERE id = NEW.flow_id;
        IF (NEW.provider = 'paystack') <> (type = 'PAYSTACK_FUNDING') THEN
          RAISE EXCEPTION 'funding payment % of provider % cannot belong to a % flow', NEW.flow_id, NEW.provider, type
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER funding_payments_check_provider_flow BEFORE INSERT ON funding_payments
        FOR EACH ROW EXECUTE FUNCTION funding_payments_check_provider_flow()
    `);
    await queryRunner.query(`
      GRANT UPDATE (checkout_authorization_url, checkout_access_code, checkout_expires_at) ON funding_payments TO fx_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      REVOKE UPDATE (checkout_authorization_url, checkout_access_code, checkout_expires_at) ON funding_payments FROM fx_app
    `);
    await queryRunner.query(`DROP TRIGGER funding_payments_check_provider_flow ON funding_payments`);
    await queryRunner.query(`DROP FUNCTION funding_payments_check_provider_flow()`);
    await queryRunner.query(`DROP TRIGGER funding_payments_guard_checkout ON funding_payments`);
    await queryRunner.query(`DROP FUNCTION funding_payments_guard_checkout()`);
    await queryRunner.query(`
      ALTER TABLE funding_payments
        DROP CONSTRAINT funding_payments_checkout_url_https,
        DROP CONSTRAINT funding_payments_checkout_only_paystack,
        DROP CONSTRAINT funding_payments_checkout_together,
        DROP COLUMN checkout_expires_at,
        DROP COLUMN checkout_access_code,
        DROP COLUMN checkout_authorization_url
    `);
    await queryRunner.query(FLOW_GUARD(`'POSTED', 'SETTLED', 'FAILED', 'REVERSED'`));
    await queryRunner.query(`ALTER TABLE flow_instances DROP CONSTRAINT flow_instances_state_valid`);
    await queryRunner.query(STATE_VALID(false));
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION flow_transition_allowed(type flow_type, from_state TEXT, to_state TEXT) RETURNS BOOLEAN AS $$
        SELECT CASE type${FUNDING_TRANSITIONS}
          ELSE FALSE
        END
      $$ LANGUAGE sql IMMUTABLE
    `);
  }
}
