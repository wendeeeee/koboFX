import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Break types added by withdrawals W4 (WITHDRAWAL_PLAN.md §I.2). The Phase 9 migration's `BREAK_TYPES` is FROZEN (it
 * is what that migration created); `reconciliation_break_type` = its list ∪ this one (a spec checks the union equals
 * `BreakType`).
 */
export const WITHDRAWAL_BREAK_TYPES = [
  'TRANSFER_WITHOUT_INTENT',
  'TRANSFER_IDENTITY_MISMATCH',
  'WITHDRAWAL_NOT_POSTED',
  'WITHDRAWAL_RETURN_NOT_POSTED',
  'WITHDRAWAL_RESERVATION_INCONSISTENT',
  'STASH_RECEIPT_INCONSISTENT',
  'PAYOUT_BALANCE_PROOF_FAILED',
  'PAYOUT_FEE_EVIDENCE_MISSING',
  'PAYOUT_TREASURY_EVIDENCE_MISSING',
] as const;

/** `reconciliation_resolution_kind` additions: an approved withdrawal recovery (§I.3) resolved the break. */
export const WITHDRAWAL_RESOLUTION_KINDS = ['RECOVERY_APPLIED'] as const;

/** `approval_action_type` additions (Phase 10's `APPROVAL_ACTION_TYPES` is frozen likewise). */
export const WITHDRAWAL_APPROVAL_ACTION_TYPES = ['PAYSTACK_WITHDRAWAL_RECOVERY'] as const;

/** `withdrawal_value_time_basis` additions: the approved accounting date of a late fact (§F.3, D4). */
export const WITHDRAWAL_VALUE_TIME_BASES = ['APPROVED_LATE_FACT'] as const;

/**
 * Withdrawals W4, enum values only: a new value cannot be used in the transaction that adds it, so the migration that
 * uses them (`1791676800001-WithdrawalReconciliationAndRecovery`) comes next.
 */
export class AddWithdrawalReconciliationEnumValues1791676800000 implements MigrationInterface {
  name = 'AddWithdrawalReconciliationEnumValues1791676800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of WITHDRAWAL_BREAK_TYPES) await queryRunner.query(`ALTER TYPE reconciliation_break_type ADD VALUE '${value}'`);
    for (const value of WITHDRAWAL_RESOLUTION_KINDS) await queryRunner.query(`ALTER TYPE reconciliation_resolution_kind ADD VALUE '${value}'`);
    for (const value of WITHDRAWAL_APPROVAL_ACTION_TYPES) await queryRunner.query(`ALTER TYPE approval_action_type ADD VALUE '${value}'`);
    for (const value of WITHDRAWAL_VALUE_TIME_BASES) await queryRunner.query(`ALTER TYPE withdrawal_value_time_basis ADD VALUE '${value}'`);
  }

  async down(): Promise<void> {
    // Postgres cannot drop an enum value; the next migration's down removes every use of them.
  }
}
