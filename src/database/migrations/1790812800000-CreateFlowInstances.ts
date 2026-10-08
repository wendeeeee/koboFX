import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `flow_instances` (design §7.5): durable state machines, resumed by the worker.
 *
 * Decisions (CLAUDE.md, Phase 5):
 * - `flow_type` is an enum; `state` is TEXT with a CHECK listing each type's legal
 *   states, and a trigger that only lets `state` move along the transition table
 *   (`flow_transition_allowed`, the SQL mirror of `funding-transitions.ts` — a test
 *   compares the two exhaustively).
 * - Columns added vs §7.5: `leased_until` + `lease_token` (a claim lease separate from
 *   `next_attempt_at`, so a webhook can claim a flow that is backing off but never one
 *   that is being worked on; the token fences a stale worker's commit) and
 *   `state_changed_at` (what `flows_stalled` measures).
 * - `id`, `flow_type`, `user_id`, `created_at` are immutable; `completed_at` is set once,
 *   only in a completion state. `fx_app` has no DELETE or TRUNCATE.
 * - `reservations.flow_id` gets its foreign key here (Phase 3 decision 1).
 */
export class CreateFlowInstances1790812800000 implements MigrationInterface {
  name = 'CreateFlowInstances1790812800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE flow_type AS ENUM ('FUNDING')`);
    await queryRunner.query(`
      CREATE FUNCTION flow_transition_allowed(type flow_type, from_state TEXT, to_state TEXT) RETURNS BOOLEAN AS $$
        SELECT CASE type
          WHEN 'FUNDING' THEN (from_state, to_state) IN (
            ('INITIATED', 'AUTHORIZED'), ('INITIATED', 'FAILED'),
            ('AUTHORIZED', 'CAPTURED'), ('AUTHORIZED', 'FAILED'),
            ('CAPTURED', 'POSTED'),
            ('POSTED', 'SETTLED'), ('POSTED', 'REVERSED'),
            ('SETTLED', 'REVERSED'))
          ELSE FALSE
        END
      $$ LANGUAGE sql IMMUTABLE
    `);
    await queryRunner.query(`
      CREATE TABLE flow_instances (
        id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        flow_type         flow_type   NOT NULL,
        state             TEXT        NOT NULL,
        user_id           UUID        NOT NULL REFERENCES users (id),
        context           JSONB       NOT NULL DEFAULT '{}',
        attempts          INTEGER     NOT NULL DEFAULT 0,
        next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        leased_until      TIMESTAMPTZ,
        lease_token       UUID,
        last_error        TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        state_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at      TIMESTAMPTZ,

        CONSTRAINT flow_instances_state_valid CHECK (
          flow_type <> 'FUNDING'
          OR state IN ('INITIATED', 'AUTHORIZED', 'CAPTURED', 'POSTED', 'SETTLED', 'FAILED', 'REVERSED')
        ),
        CONSTRAINT flow_instances_context_is_object CHECK (jsonb_typeof(context) = 'object'),
        CONSTRAINT flow_instances_attempts_non_negative CHECK (attempts >= 0),
        CONSTRAINT flow_instances_lease_complete CHECK ((leased_until IS NULL) = (lease_token IS NULL))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX flow_instances_resumable_index ON flow_instances (next_attempt_at) WHERE completed_at IS NULL
    `);
    await queryRunner.query(`CREATE INDEX flow_instances_user_index ON flow_instances (user_id, created_at DESC)`);

    await queryRunner.query(`
      CREATE FUNCTION flow_instances_guard_mutation() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'flow instances are never deleted (attempted DELETE on id %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.flow_type IS DISTINCT FROM OLD.flow_type
           OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'flow % identity is immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF NEW.state IS DISTINCT FROM OLD.state
           AND NOT flow_transition_allowed(OLD.flow_type, OLD.state, NEW.state) THEN
          RAISE EXCEPTION 'flow % (%) cannot move from % to %', OLD.id, OLD.flow_type, OLD.state, NEW.state
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
          RAISE EXCEPTION 'flow % completion time is set once', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        IF OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
           AND NEW.state NOT IN ('POSTED', 'SETTLED', 'FAILED', 'REVERSED') THEN
          RAISE EXCEPTION 'flow % cannot complete in state %', OLD.id, NEW.state
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER flow_instances_guard_mutation BEFORE UPDATE OR DELETE ON flow_instances
        FOR EACH ROW EXECUTE FUNCTION flow_instances_guard_mutation()
    `);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON flow_instances FROM fx_app`);
    await queryRunner.query(`
      GRANT UPDATE (state, context, attempts, next_attempt_at, leased_until, lease_token, last_error,
                    updated_at, state_changed_at, completed_at) ON flow_instances TO fx_app
    `);

    await queryRunner.query(`
      ALTER TABLE reservations
        ADD CONSTRAINT reservations_flow_id_foreign_key FOREIGN KEY (flow_id) REFERENCES flow_instances (id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE reservations DROP CONSTRAINT reservations_flow_id_foreign_key`);
    await queryRunner.query(`DROP TABLE flow_instances`);
    await queryRunner.query(`DROP FUNCTION flow_instances_guard_mutation()`);
    await queryRunner.query(`DROP FUNCTION flow_transition_allowed(flow_type, TEXT, TEXT)`);
    await queryRunner.query(`DROP TYPE flow_type`);
  }
}
