import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Protected holds and payout accounts (WITHDRAWAL_PLAN.md §G.2, §F.1; D2, D5).
 *
 * - `reservations.expiry_policy` (`AUTOMATIC` default, `FLOW_CONTROLLED`), immutable (the Phase 3 guard already
 *   freezes every non-resolution column). A `FLOW_CONTROLLED` hold never expires: the trigger refuses
 *   `→ EXPIRED` for every role, so the sweeper cannot free a payout hold even through direct SQL. Its
 *   `expires_at` is a review deadline only. Releasing or settling one is checked at COMMIT against the
 *   withdrawal's facts (the next migration's deferred consistency triggers).
 * - `FLOW_CONTROLLED` ⇔ the reservation's flow is a `PAYSTACK_WITHDRAWAL` (insert trigger): a payout hold cannot
 *   be weakened to AUTOMATIC, and no other flow can claim the protection.
 * - Templates (data only, provisioned at boot × currency × bucket): `PAYSTACK_PAYOUT_BALANCE` (our money at the
 *   provider), `PAYSTACK_PAYOUT_IN_TRANSIT` (principal the provider deducted, not yet discharged against the
 *   customer's liability), `EXPENSE:PAYSTACK_TRANSFER_FEES` (platform-borne; the customer pays no fee).
 *   No stash account: the stash is outside the company's books.
 */
export class ProtectedReservationsAndPayoutAccounts1791417600002 implements MigrationInterface {
  name = 'ProtectedReservationsAndPayoutAccounts1791417600002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE reservation_expiry_policy AS ENUM ('AUTOMATIC', 'FLOW_CONTROLLED')`);
    await queryRunner.query(`
      ALTER TABLE reservations ADD COLUMN expiry_policy reservation_expiry_policy NOT NULL DEFAULT 'AUTOMATIC'
    `);
    await queryRunner.query(`
      CREATE INDEX reservations_active_automatic_expiry_index ON reservations (expires_at)
        WHERE status = 'ACTIVE' AND expiry_policy = 'AUTOMATIC'
    `);
    await queryRunner.query(`
      CREATE INDEX reservations_active_flow_controlled_index ON reservations (expires_at)
        WHERE status = 'ACTIVE' AND expiry_policy = 'FLOW_CONTROLLED'
    `);

    await queryRunner.query(`
      CREATE FUNCTION reservations_guard_expiry_policy() RETURNS trigger AS $$
      BEGIN
        IF OLD.expiry_policy = 'FLOW_CONTROLLED' AND NEW.status = 'EXPIRED' AND OLD.status IS DISTINCT FROM 'EXPIRED' THEN
          RAISE EXCEPTION 'reservation % is flow-controlled: it never expires, only its flow resolves it', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER reservations_guard_expiry_policy BEFORE UPDATE ON reservations
        FOR EACH ROW EXECUTE FUNCTION reservations_guard_expiry_policy()
    `);
    await queryRunner.query(`
      CREATE FUNCTION reservations_check_expiry_policy() RETURNS trigger AS $$
      DECLARE
        type flow_type;
      BEGIN
        SELECT flow_type INTO type FROM flow_instances WHERE id = NEW.flow_id;
        IF (NEW.expiry_policy = 'FLOW_CONTROLLED') <> (type IS NOT DISTINCT FROM 'PAYSTACK_WITHDRAWAL') THEN
          RAISE EXCEPTION 'a % reservation cannot belong to a % flow', NEW.expiry_policy, type
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER reservations_check_expiry_policy BEFORE INSERT ON reservations
        FOR EACH ROW EXECUTE FUNCTION reservations_check_expiry_policy()
    `);

    await queryRunner.query(`
      INSERT INTO system_account_templates (name, account_type, normal_side, description) VALUES
        ('PAYSTACK_PAYOUT_BALANCE',       'ASSET',   'DEBIT', 'Our merchant balance at Paystack, available for transfers'),
        ('PAYSTACK_PAYOUT_IN_TRANSIT',    'ASSET',   'DEBIT', 'Transfer principal Paystack deducted, not yet discharged against the customer'),
        ('EXPENSE:PAYSTACK_TRANSFER_FEES', 'EXPENSE', 'DEBIT', 'Paystack transfer fees, borne by the platform')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Templates change by migration only, and accounts provisioned from them may hold entries: never removed.
    await queryRunner.query(`DROP TRIGGER reservations_check_expiry_policy ON reservations`);
    await queryRunner.query(`DROP FUNCTION reservations_check_expiry_policy()`);
    await queryRunner.query(`DROP TRIGGER reservations_guard_expiry_policy ON reservations`);
    await queryRunner.query(`DROP FUNCTION reservations_guard_expiry_policy()`);
    await queryRunner.query(`DROP INDEX reservations_active_flow_controlled_index`);
    await queryRunner.query(`DROP INDEX reservations_active_automatic_expiry_index`);
    await queryRunner.query(`ALTER TABLE reservations DROP COLUMN expiry_policy`);
    await queryRunner.query(`DROP TYPE reservation_expiry_policy`);
  }
}
