import { MigrationInterface, QueryRunner } from 'typeorm';

const GUARD = (settlementColumns: boolean) => `
  CREATE OR REPLACE FUNCTION funding_payments_guard_mutation() RETURNS trigger AS $$
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
           AND NEW.chargeback_transaction_id IS DISTINCT FROM OLD.chargeback_transaction_id)
       ${
         settlementColumns
           ? `OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at)
       OR (OLD.settlement_batch_line_id IS NOT NULL AND NEW.settlement_batch_line_id IS DISTINCT FROM OLD.settlement_batch_line_id)
       OR (OLD.settlement_fee_minor IS NOT NULL AND NEW.settlement_fee_minor IS DISTINCT FROM OLD.settlement_fee_minor)`
           : ''
       } THEN
      RAISE EXCEPTION 'funding payment % has already recorded that fact', OLD.flow_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
  END $$ LANGUAGE plpgsql
`;

/**
 * `funding_payments` records what the PSP's settlement said about each deposit (Phase 9):
 * `settled_at` (the batch's settlement time — history's `settlementTime` for a funding,
 * since the funding's `transactions` row is append-only), the batch line, and the PSP's fee
 * for it. All three are set once, together, by the settlement posting's transaction.
 */
export class FundingPaymentsSettlement1791158400002 implements MigrationInterface {
  name = 'FundingPaymentsSettlement1791158400002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE funding_payments
        ADD COLUMN settled_at               TIMESTAMPTZ,
        ADD COLUMN settlement_batch_line_id UUID UNIQUE REFERENCES settlement_batch_lines (id),
        ADD COLUMN settlement_fee_minor     BIGINT,
        ADD CONSTRAINT funding_payments_settlement_together CHECK (
          (settled_at IS NULL) = (settlement_batch_line_id IS NULL)
          AND (settled_at IS NULL) = (settlement_fee_minor IS NULL)
        ),
        ADD CONSTRAINT funding_payments_settlement_fee_non_negative CHECK (settlement_fee_minor >= 0),
        ADD CONSTRAINT funding_payments_settled_after_posting CHECK (
          settled_at IS NULL OR funding_transaction_id IS NOT NULL
        )
    `);
    await queryRunner.query(GUARD(true));
    await queryRunner.query(`GRANT UPDATE (settled_at, settlement_batch_line_id, settlement_fee_minor) ON funding_payments TO fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE UPDATE (settled_at, settlement_batch_line_id, settlement_fee_minor) ON funding_payments FROM fx_app`);
    await queryRunner.query(GUARD(false));
    await queryRunner.query(`
      ALTER TABLE funding_payments
        DROP CONSTRAINT funding_payments_settled_after_posting,
        DROP CONSTRAINT funding_payments_settlement_fee_non_negative,
        DROP CONSTRAINT funding_payments_settlement_together,
        DROP COLUMN settlement_fee_minor,
        DROP COLUMN settlement_batch_line_id,
        DROP COLUMN settled_at
    `);
  }
}
