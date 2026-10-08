import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Minimal `users` and `wallets` — only what the ledger's foreign keys need
 * (binding decision, CLAUDE.md 2026-09-28). Phase 4 (auth) extends `users` with its
 * own migration; it does not recreate the table.
 */
export class CreateUsersAndWallets1790553600001 implements MigrationInterface {
  name = 'CreateUsersAndWallets1790553600001';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    await queryRunner.query(`
      CREATE TABLE wallets (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID        NOT NULL REFERENCES users (id),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX wallets_user_id_index ON wallets (user_id)`);
    await queryRunner.query(`
      CREATE TRIGGER wallets_set_updated_at BEFORE UPDATE ON wallets
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE wallets`);
    await queryRunner.query(`DROP TABLE users`);
  }
}
