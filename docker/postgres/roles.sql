-- Role bootstrap. Run once per database, as a superuser.
-- Used by docker compose (docker/postgres/init/01-roles.sh) AND by the test harness,
-- so the permission model under test is the permission model in dev.
--
--   fx_owner  owns the schema and runs migrations.
--   fx_app    the runtime role: DML only. It cannot alter the schema

CREATE ROLE fx_owner LOGIN PASSWORD '{{FX_OWNER_PASSWORD}}';
CREATE ROLE fx_app   LOGIN PASSWORD '{{FX_APP_PASSWORD}}';

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO fx_owner, fx_app', current_database());
END $$;

ALTER SCHEMA public OWNER TO fx_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO fx_app;


ALTER DEFAULT PRIVILEGES FOR ROLE fx_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fx_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fx_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fx_app;
