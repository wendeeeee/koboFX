import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Access control as state (design §9.3; Phase 10 plan §E.1).
 *
 * - `role_assignments`: the history of every privileged role anybody ever held — granted when, by whom,
 *   through which approval (or the one-time bootstrap), revoked when, by whom, through which approval.
 *   Recertification reads it. One live assignment per person (a person holds one role). Append-only but
 *   for the revocation columns (set once); `fx_app` may only read it.
 * - `users.role` changes ONLY inside `apply_role_change` / `bootstrap_first_administrators` (a trigger
 *   refuses anything else, for a superuser too unless it deliberately sets the same flag). `fx_app` still has
 *   no UPDATE on `users.role` (Phase 4 decision 9): it gets EXECUTE on `apply_role_change` alone, which re-reads
 *   the approval (an APPROVED ROLE_CHANGE, decided by an eligible SECURITY officer) before changing anything.
 * - `bootstrap_first_administrators(admin, security)`: the first ADMIN and the first SECURITY officer, two
 *   different ACTIVE users, once — refused as soon as `role_assignments` holds any row. Owner only.
 *
 * Recorded limit: a holder of `fx_app`'s credentials could still forge a request and an approval between two
 * real privileged users. The database proves two distinct eligible people were recorded, not that they clicked.
 */
export class CreateRoleAssignments1791244800002 implements MigrationInterface {
  name = 'CreateRoleAssignments1791244800002';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE role_assignments (
        id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id             UUID        NOT NULL REFERENCES users (id),
        role                user_role   NOT NULL,
        is_bootstrap        BOOLEAN     NOT NULL DEFAULT FALSE,
        granted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        granted_by          UUID        REFERENCES users (id),
        grant_approval_id   UUID        UNIQUE REFERENCES approvals (id),
        revoked_at          TIMESTAMPTZ,
        revoked_by          UUID        REFERENCES users (id),
        revoke_approval_id  UUID        UNIQUE REFERENCES approvals (id),

        CONSTRAINT role_assignments_privileged CHECK (role <> 'USER'),
        CONSTRAINT role_assignments_granted_how CHECK (
          (is_bootstrap AND grant_approval_id IS NULL AND granted_by IS NULL)
          OR (NOT is_bootstrap AND grant_approval_id IS NOT NULL AND granted_by IS NOT NULL)
        ),
        CONSTRAINT role_assignments_revoked_together CHECK (
          (revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_approval_id IS NULL)
        ),
        CONSTRAINT role_assignments_not_self_granted CHECK (granted_by IS NULL OR granted_by <> user_id)
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX role_assignments_live_unique ON role_assignments (user_id) WHERE revoked_at IS NULL`);

    await queryRunner.query(`
      CREATE FUNCTION role_assignments_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'role assignments are never deleted (attempted DELETE on %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.role IS DISTINCT FROM OLD.role
           OR NEW.is_bootstrap IS DISTINCT FROM OLD.is_bootstrap OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
           OR NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.grant_approval_id IS DISTINCT FROM OLD.grant_approval_id
           OR OLD.revoked_at IS NOT NULL THEN
          RAISE EXCEPTION 'role assignment % is immutable once granted; revocation is recorded once', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER role_assignments_guard_mutation BEFORE UPDATE OR DELETE ON role_assignments
        FOR EACH ROW EXECUTE FUNCTION role_assignments_guard_mutation()
    `);
    await queryRunner.query(`
      CREATE TRIGGER role_assignments_refuse_truncate BEFORE TRUNCATE ON role_assignments
        FOR EACH STATEMENT EXECUTE FUNCTION approvals_refuse_truncate()
    `);
    await queryRunner.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON role_assignments FROM fx_app`);

    // users.role moves only inside the two functions below (they set a transaction-local flag).
    await queryRunner.query(`
      CREATE FUNCTION users_guard_role() RETURNS trigger AS $$
      BEGIN
        IF NEW.role IS DISTINCT FROM OLD.role AND current_setting('fx.role_change', true) IS DISTINCT FROM 'on' THEN
          RAISE EXCEPTION 'user % role changes only through an approved role change', OLD.id
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER users_guard_role BEFORE UPDATE OF role ON users
        FOR EACH ROW EXECUTE FUNCTION users_guard_role()
    `);

    await queryRunner.query(`
      CREATE FUNCTION apply_role_change(p_approval_id UUID) RETURNS UUID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      DECLARE
        approval   approvals%ROWTYPE;
        target     users%ROWTYPE;
        wanted     user_role;
        operation  TEXT;
        remaining  INTEGER;
        assignment UUID;
      BEGIN
        SELECT * INTO approval FROM approvals WHERE id = p_approval_id FOR UPDATE;
        IF NOT FOUND OR approval.action_type <> 'ROLE_CHANGE' OR approval.status <> 'APPROVED' OR approval.approved_by IS NULL
           OR approval.approved_by = approval.requested_by THEN
          RAISE EXCEPTION 'a role change needs an APPROVED ROLE_CHANGE approval (%)', p_approval_id
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NOT approval_actor_eligible(approval.approved_by, 'SECURITY') THEN
          RAISE EXCEPTION 'approval % was not decided by an active SECURITY officer', p_approval_id USING ERRCODE = 'insufficient_privilege';
        END IF;
        wanted := (approval.payload ->> 'role')::user_role;
        operation := approval.payload ->> 'operation';
        IF wanted = 'USER' THEN
          RAISE EXCEPTION 'USER is not a privileged role' USING ERRCODE = 'check_violation';
        END IF;
        -- Serialise changes to one role: "the last holder" is decided under this lock.
        PERFORM pg_advisory_xact_lock(hashtext('role-change:' || wanted::text));
        SELECT * INTO target FROM users WHERE id = (approval.payload ->> 'userId')::uuid FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'role change target does not exist' USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF target.id = approval.requested_by OR target.id = approval.approved_by THEN
          RAISE EXCEPTION 'nobody requests or approves their own role change' USING ERRCODE = 'insufficient_privilege';
        END IF;

        PERFORM set_config('fx.role_change', 'on', true);
        IF operation = 'GRANT' THEN
          IF target.status <> 'ACTIVE' OR target.role <> 'USER' THEN
            RAISE EXCEPTION 'role % can be granted only to an ACTIVE user without a role', wanted USING ERRCODE = 'check_violation';
          END IF;
          UPDATE users SET role = wanted WHERE id = target.id;
          INSERT INTO role_assignments (user_id, role, granted_by, grant_approval_id)
            VALUES (target.id, wanted, approval.approved_by, approval.id)
            RETURNING id INTO assignment;
        ELSIF operation = 'REVOKE' THEN
          IF target.role <> wanted THEN
            RAISE EXCEPTION 'the target does not hold %', wanted USING ERRCODE = 'check_violation';
          END IF;
          SELECT count(*) INTO remaining FROM users WHERE role = wanted AND status = 'ACTIVE' AND id <> target.id;
          IF remaining < 1 THEN
            RAISE EXCEPTION 'refusing to revoke the last active %', wanted USING ERRCODE = 'check_violation';
          END IF;
          UPDATE users SET role = 'USER' WHERE id = target.id;
          UPDATE role_assignments SET revoked_at = now(), revoked_by = approval.approved_by, revoke_approval_id = approval.id
           WHERE user_id = target.id AND revoked_at IS NULL
           RETURNING id INTO assignment;
          IF assignment IS NULL THEN
            RAISE EXCEPTION 'user % holds % without an assignment record', target.id, wanted USING ERRCODE = 'data_exception';
          END IF;
        ELSE
          RAISE EXCEPTION 'unknown role change operation %', operation USING ERRCODE = 'check_violation';
        END IF;
        PERFORM set_config('fx.role_change', 'off', true);
        RETURN assignment;
      END $$
    `);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION apply_role_change(UUID) FROM PUBLIC`);
    await queryRunner.query(`GRANT EXECUTE ON FUNCTION apply_role_change(UUID) TO fx_app`);

    await queryRunner.query(`
      CREATE FUNCTION bootstrap_first_administrators(p_administrator UUID, p_security_officer UUID) RETURNS VOID
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      DECLARE
        person UUID;
        wanted user_role;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('role-bootstrap'));
        IF EXISTS (SELECT 1 FROM role_assignments) THEN
          RAISE EXCEPTION 'the first administrators were already bootstrapped; grant roles through an approval'
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF p_administrator IS NULL OR p_security_officer IS NULL OR p_administrator = p_security_officer THEN
          RAISE EXCEPTION 'the bootstrap needs two different people' USING ERRCODE = 'check_violation';
        END IF;
        PERFORM set_config('fx.role_change', 'on', true);
        FOREACH person IN ARRAY ARRAY[p_administrator, p_security_officer] LOOP
          wanted := CASE WHEN person = p_administrator THEN 'ADMIN'::user_role ELSE 'SECURITY'::user_role END;
          UPDATE users SET role = wanted WHERE id = person AND status = 'ACTIVE' AND role = 'USER';
          IF NOT FOUND THEN
            RAISE EXCEPTION 'user % is not an ACTIVE user without a role', person USING ERRCODE = 'check_violation';
          END IF;
          INSERT INTO role_assignments (user_id, role, is_bootstrap) VALUES (person, wanted, TRUE);
          INSERT INTO audit_logs (actor_type, actor_id, action, subject_type, subject_id, before, after, reason)
            VALUES ('SYSTEM', NULL, 'ADMINISTRATORS_BOOTSTRAPPED', 'USER', person,
                    jsonb_build_object('role', 'USER'), jsonb_build_object('role', wanted::text),
                    'BOOTSTRAP: the first ADMIN and SECURITY officer (one-time, owner connection)');
        END LOOP;
        PERFORM set_config('fx.role_change', 'off', true);
      END $$
    `);
    await queryRunner.query(`REVOKE EXECUTE ON FUNCTION bootstrap_first_administrators(UUID, UUID) FROM PUBLIC`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION bootstrap_first_administrators(UUID, UUID)`);
    await queryRunner.query(`DROP FUNCTION apply_role_change(UUID)`);
    await queryRunner.query(`DROP TRIGGER users_guard_role ON users`);
    await queryRunner.query(`DROP FUNCTION users_guard_role()`);
    await queryRunner.query(`UPDATE users SET role = 'USER' WHERE role <> 'USER'`);
    await queryRunner.query(`DROP TABLE role_assignments`);
    await queryRunner.query(`DROP FUNCTION role_assignments_guard_mutation()`);
  }
}
