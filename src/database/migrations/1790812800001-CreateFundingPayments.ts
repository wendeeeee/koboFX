import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `funding_payments` — one PSP payment per funding flow (Phase 5; not in the design,
 * approved as a gap fill). The money facts of a deposit live here in typed,
 * trigger-guarded columns rather than in the flow's mutable `context`, and this is the
 * table Phase 9 reconciliation joins on (`provider_payment_id` = the PSP's id).
 *
 * - Identity and amount (`flow_id`, `user_id`, `account_id`, `currency_code`,
 *   `amount_minor`, `provider`, `created_at`) are immutable.
 * - `provider_payment_id`, `authorized_at`, `capture_requested_at`, `captured_at`,
 *   `failure_code`, `funding_transaction_id`, `chargeback_transaction_id` are set once.
 * - `payment_method_token` (a PSP single-use token — never card data) may only be
 *   cleared, which happens as soon as the PSP has answered the authorization.
 * - `provider_status` is the last status observed from the PSP's API (informational).
 * - `fx_app` has column-level UPDATE only, no DELETE or TRUNCATE.
 */
export class CreateFundingPayments1790812800001 implements MigrationInterface {
  name = 'CreateFundingPayments1790812800001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE funding_payments (
        flow_id                    UUID        PRIMARY KEY REFERENCES flow_instances (id),
        user_id                    UUID        NOT NULL REFERENCES users (id),
        account_id                 UUID        NOT NULL REFERENCES accounts (id),
        currency_code              CHAR(3)     NOT NULL REFERENCES currencies (code),
        amount_minor               BIGINT      NOT NULL,
        provider                   TEXT        NOT NULL,
        payment_method_token       TEXT,
        provider_payment_id        TEXT,
        provider_status            TEXT,
        authorized_at              TIMESTAMPTZ,
        capture_requested_at       TIMESTAMPTZ,
        captured_at                TIMESTAMPTZ,
        failure_code               TEXT,
        funding_transaction_id     UUID        UNIQUE REFERENCES transactions (id),
        chargeback_transaction_id  UUID        UNIQUE REFERENCES transactions (id),
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

        CONSTRAINT funding_payments_amount_positive CHECK (amount_minor > 0),
        CONSTRAINT funding_payments_chargeback_after_funding CHECK (
          chargeback_transaction_id IS NULL OR funding_transaction_id IS NOT NULL
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX funding_payments_provider_payment_unique
        ON funding_payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE FUNCTION funding_payments_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'funding payments are never deleted (attempted DELETE on flow %)', OLD.flow_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.flow_id IS DISTINCT FROM OLD.flow_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
           OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.provider IS DISTINCT FROM OLD.provider
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'funding payment % identity and amount are immutable', OLD.flow_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.payment_method_token IS NOT NULL AND NEW.payment_method_token IS DISTINCT FROM OLD.payment_method_token THEN
          RAISE EXCEPTION 'funding payment % payment method token may only be cleared', OLD.flow_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF (OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id)
           OR (OLD.authorized_at IS NOT NULL AND NEW.authorized_at IS DISTINCT FROM OLD.authorized_at)
           OR (OLD.capture_requested_at IS NOT NULL AND NEW.capture_requested_at IS DISTINCT FROM OLD.capture_requested_at)
           OR (OLD.captured_at IS NOT NULL AND NEW.captured_at IS DISTINCT FROM OLD.captured_at)
           OR (OLD.failure_code IS NOT NULL AND NEW.failure_code IS DISTINCT FROM OLD.failure_code)
           OR (OLD.funding_transaction_id IS NOT NULL AND NEW.funding_transaction_id IS DISTINCT FROM OLD.funding_transaction_id)
           OR (OLD.chargeback_transaction_id IS NOT NULL
               AND NEW.chargeback_transaction_id IS DISTINCT FROM OLD.chargeback_transaction_id) THEN
          RAISE EXCEPTION 'funding payment % has already recorded that fact', OLD.flow_id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER funding_payments_guard_mutation BEFORE UPDATE OR DELETE ON funding_payments
        FOR EACH ROW EXECUTE FUNCTION funding_payments_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON funding_payments FROM fx_app`);
    await queryRunner.query(`
      GRANT UPDATE (payment_method_token, provider_payment_id, provider_status, authorized_at, capture_requested_at,
                    captured_at, failure_code, funding_transaction_id, chargeback_transaction_id, updated_at)
        ON funding_payments TO fx_app
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE funding_payments`);
    await queryRunner.query(`DROP FUNCTION funding_payments_guard_mutation()`);
  }
}
