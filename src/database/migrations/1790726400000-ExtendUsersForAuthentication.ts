import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the minimal Phase 2 `users` table for authentication (design §7.1, §9.1).
 * It is ALTERed, never recreated (binding decision, CLAUDE.md 2026-09-28).
 *
 * - `email` is stored normalised: lowercase ASCII. The CHECK makes a non-normalised
 *   address unrepresentable, so the plain UNIQUE constraint is the uniqueness rule.
 * - `password_hash` is an argon2id PHC string (it carries its own parameters).
 * - `status` never returns to `PENDING_VERIFICATION`; `verified_at` is set once.
 *   `id`, `email` and `created_at` are immutable. A trigger RAISEs otherwise.
 * - `fx_app` may UPDATE only `password_hash`, `status` and `verified_at`: granting
 *   roles is a Phase 10 (audited, four-eyes) capability. No DELETE, ever — erasure is
 *   redaction (design §9.5), done by a later, dedicated migration.
 *
 * The new columns are NOT NULL without defaults on purpose: if `users` already holds
 * rows without credentials, this migration fails loudly instead of inventing them.
 */
export class ExtendUsersForAuthentication1790726400000 implements MigrationInterface {
  name = 'ExtendUsersForAuthentication1790726400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE user_status AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED')`);
    await queryRunner.query(`CREATE TYPE user_role AS ENUM ('USER', 'ADMIN')`);
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN email          TEXT        NOT NULL,
        ADD COLUMN password_hash  TEXT        NOT NULL,
        ADD COLUMN status         user_status NOT NULL DEFAULT 'PENDING_VERIFICATION',
        ADD COLUMN role           user_role   NOT NULL DEFAULT 'USER',
        ADD COLUMN verified_at    TIMESTAMPTZ,
        ADD CONSTRAINT users_email_unique UNIQUE (email),
        ADD CONSTRAINT users_email_normalized CHECK (
          email = lower(email) AND length(email) <= 254 AND email ~ '^[!-~]+@[a-z0-9.-]+$'
        ),
        ADD CONSTRAINT users_password_hash_argon2id CHECK (password_hash LIKE '$argon2id$%'),
        ADD CONSTRAINT users_verified_when_active CHECK (status <> 'ACTIVE' OR verified_at IS NOT NULL),
        ADD CONSTRAINT users_unverified_when_pending CHECK (status <> 'PENDING_VERIFICATION' OR verified_at IS NULL)
    `);

    await queryRunner.query(`
      CREATE FUNCTION users_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'users are never deleted (attempted DELETE on id %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.email IS DISTINCT FROM OLD.email
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'user % has immutable id, email and created_at', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
          RAISE EXCEPTION 'user % has already recorded its verification', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.status = 'PENDING_VERIFICATION' AND OLD.status <> 'PENDING_VERIFICATION' THEN
          RAISE EXCEPTION 'user % cannot return to PENDING_VERIFICATION from %', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER users_guard_mutation BEFORE UPDATE OR DELETE ON users
        FOR EACH ROW EXECUTE FUNCTION users_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON users FROM fx_app`);
    await queryRunner.query(`GRANT UPDATE (password_hash, status, verified_at) ON users TO fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER users_guard_mutation ON users`);
    await queryRunner.query(`DROP FUNCTION users_guard_mutation()`);
    await queryRunner.query(`GRANT UPDATE, DELETE ON users TO fx_app`);
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN verified_at,
        DROP COLUMN role,
        DROP COLUMN status,
        DROP COLUMN password_hash,
        DROP COLUMN email
    `);
    await queryRunner.query(`DROP TYPE user_role`);
    await queryRunner.query(`DROP TYPE user_status`);
  }
}
