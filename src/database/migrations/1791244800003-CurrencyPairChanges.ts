import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spread and minimum changes are four-eyes (design §9.2; Phase 6 decision 11: `currency_pairs` is
 * read-only to `fx_app`). It stays read-only: an approved SPREAD_CHANGE reaches the row only through
 * `apply_currency_pair_change(approval_id)` (SECURITY DEFINER), which re-reads the approval — an APPROVED
 * SPREAD_CHANGE — and applies exactly its payload. Quotes already issued keep the spread they locked.
 * The before/after values are in the audit row the executor writes in the same transaction.
 */
export class CurrencyPairChanges1791244800003 implements MigrationInterface {
  name = 'CurrencyPairChanges1791244800003';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION apply_currency_pair_change(p_approval_id UUID)
        RETURNS TABLE (spread_before INTEGER, minimum_before BIGINT, spread_after INTEGER, minimum_after BIGINT)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      DECLARE
        approval approvals%ROWTYPE;
        pair     currency_pairs%ROWTYPE;
      BEGIN
        SELECT * INTO approval FROM approvals WHERE id = p_approval_id FOR UPDATE;
        IF NOT FOUND OR approval.action_type <> 'SPREAD_CHANGE' OR approval.status <> 'APPROVED' OR approval.approved_by IS NULL
           OR approval.approved_by = approval.requested_by THEN
          RAISE EXCEPTION 'a pair change needs an APPROVED SPREAD_CHANGE approval (%)', p_approval_id
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        -- The before-values are read under the same row lock the change takes: the audit row is exact.
        SELECT * INTO pair FROM currency_pairs
         WHERE source_currency_code = approval.payload ->> 'sourceCurrency' AND target_currency_code = approval.payload ->> 'targetCurrency'
           FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'no such currency pair' USING ERRCODE = 'foreign_key_violation';
        END IF;
        spread_before := pair.spread_basis_points;
        minimum_before := pair.minimum_source_amount_minor;
        UPDATE currency_pairs
           SET spread_basis_points = COALESCE((approval.payload ->> 'spreadBasisPoints')::integer, spread_basis_points),
               minimum_source_amount_minor = COALESCE((approval.payload ->> 'minimumSourceAmount')::bigint, minimum_source_amount_minor),
               updated_at = now()
         WHERE source_currency_code = pair.source_currency_code AND target_currency_code = pair.target_currency_code
         RETURNING spread_basis_points, minimum_source_amount_minor INTO spread_after, minimum_after;
        RETURN NEXT;
      END $$
    `);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION apply_currency_pair_change(UUID) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION apply_currency_pair_change(UUID) TO fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION apply_currency_pair_change(UUID)`);
  }
}
