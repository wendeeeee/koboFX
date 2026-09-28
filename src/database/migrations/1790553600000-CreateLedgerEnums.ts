import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The ledger's vocabulary (design §5.1, §5.4, §5.5). Names are spelled out in full:
 * `transaction_type` / `transaction_status` rather than the design's `txn_*`.
 */
export class CreateLedgerEnums1790553600000 implements MigrationInterface {
  name = 'CreateLedgerEnums1790553600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE account_type AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')`,
    );
    await queryRunner.query(`CREATE TYPE normal_side AS ENUM ('DEBIT', 'CREDIT')`);
    await queryRunner.query(`
      CREATE TYPE transaction_type AS ENUM
        ('FUNDING', 'CONVERSION', 'WITHDRAWAL', 'REVERSAL', 'CORRECTION', 'PROMOTIONAL', 'WRITE_OFF')
    `);
    await queryRunner.query(
      `CREATE TYPE transaction_status AS ENUM ('PENDING', 'POSTED', 'FAILED', 'REVERSED')`,
    );
    await queryRunner.query(`CREATE TYPE entry_direction AS ENUM ('DEBIT', 'CREDIT')`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TYPE entry_direction`);
    await queryRunner.query(`DROP TYPE transaction_status`);
    await queryRunner.query(`DROP TYPE transaction_type`);
    await queryRunner.query(`DROP TYPE normal_side`);
    await queryRunner.query(`DROP TYPE account_type`);
  }
}
