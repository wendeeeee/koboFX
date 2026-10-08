import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Refresh tokens (design §9.1): rotation on every refresh, and reuse detection that
 * revokes the whole family.
 *
 * - `refresh_token_families` is one login session. Revoking it (logout, reuse, the
 *   user no longer ACTIVE) is ONE row update, and every token in it dies at once. The
 *   family row is also the lock that serialises rotation within a session.
 * - `refresh_tokens` stores only the SHA-256 of each opaque token (`BYTEA`, 32 bytes).
 *   `parent_id` is UNIQUE: a token has at most one child, so two live children of one
 *   parent are unrepresentable, not merely prevented.
 * - A token is live iff it is unused, unexpired, and its family is not revoked.
 * - Set-once columns (`used_at`; `revoked_at` + `revocation_reason`) are enforced by
 *   triggers; everything else is immutable. `fx_app` has no DELETE.
 */
export class CreateRefreshTokens1790726400004 implements MigrationInterface {
  name = 'CreateRefreshTokens1790726400004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE refresh_token_revocation_reason AS ENUM ('LOGOUT', 'REUSE_DETECTED', 'USER_NOT_ACTIVE')
    `);
    await queryRunner.query(`
      CREATE TABLE refresh_token_families (
        id                 UUID                            PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id            UUID                            NOT NULL REFERENCES users (id),
        created_at         TIMESTAMPTZ                     NOT NULL,
        revoked_at         TIMESTAMPTZ,
        revocation_reason  refresh_token_revocation_reason,

        CONSTRAINT refresh_token_families_revocation_recorded CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
      )
    `);
    await queryRunner.query(`CREATE INDEX refresh_token_families_user_id_index ON refresh_token_families (user_id)`);

    await queryRunner.query(`
      CREATE TABLE refresh_tokens (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        family_id   UUID        NOT NULL REFERENCES refresh_token_families (id),
        parent_id   UUID        REFERENCES refresh_tokens (id),
        token_hash  BYTEA       NOT NULL,
        issued_at   TIMESTAMPTZ NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        used_at     TIMESTAMPTZ,

        CONSTRAINT refresh_tokens_token_hash_unique UNIQUE (token_hash),
        CONSTRAINT refresh_tokens_parent_unique UNIQUE (parent_id),
        CONSTRAINT refresh_tokens_token_hash_sha256 CHECK (octet_length(token_hash) = 32),
        CONSTRAINT refresh_tokens_expiry_after_issue CHECK (expires_at > issued_at)
      )
    `);
    await queryRunner.query(`CREATE INDEX refresh_tokens_family_id_index ON refresh_tokens (family_id)`);

    await queryRunner.query(`
      CREATE FUNCTION refresh_token_families_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'refresh token families are never deleted (attempted DELETE on id %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (to_jsonb(NEW) - 'revoked_at' - 'revocation_reason')
           IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'revocation_reason') THEN
          RAISE EXCEPTION 'refresh token family % is immutable apart from its revocation', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.revoked_at IS NOT NULL
           AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason) THEN
          RAISE EXCEPTION 'refresh token family % has already been revoked', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER refresh_token_families_guard_mutation BEFORE UPDATE OR DELETE ON refresh_token_families
        FOR EACH ROW EXECUTE FUNCTION refresh_token_families_guard_mutation()
    `);

    await queryRunner.query(`
      CREATE FUNCTION refresh_tokens_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'refresh tokens are never deleted (attempted DELETE on id %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (to_jsonb(NEW) - 'used_at') IS DISTINCT FROM (to_jsonb(OLD) - 'used_at') THEN
          RAISE EXCEPTION 'refresh token % is immutable apart from used_at', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at THEN
          RAISE EXCEPTION 'refresh token % has already been used', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER refresh_tokens_guard_mutation BEFORE UPDATE OR DELETE ON refresh_tokens
        FOR EACH ROW EXECUTE FUNCTION refresh_tokens_guard_mutation()
    `);

    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON refresh_token_families FROM fx_app`);
    await queryRunner.query(`GRANT UPDATE (revoked_at, revocation_reason) ON refresh_token_families TO fx_app`);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON refresh_tokens FROM fx_app`);
    await queryRunner.query(`GRANT UPDATE (used_at) ON refresh_tokens TO fx_app`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE refresh_tokens`);
    await queryRunner.query(`DROP TABLE refresh_token_families`);
    await queryRunner.query(`DROP FUNCTION refresh_tokens_guard_mutation()`);
    await queryRunner.query(`DROP FUNCTION refresh_token_families_guard_mutation()`);
    await queryRunner.query(`DROP TYPE refresh_token_revocation_reason`);
  }
}
