-- Replace the caller-trusted custom-GUC policy with an HMAC-verified transaction context.
-- Provision the key through the operator procedure; never put a key in a migration.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_rls_context_owner') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolcreaterole) THEN
      RAISE EXCEPTION 'Migration role % needs CREATEROLE to create uts_rls_context_owner; superuser is not required', current_user;
    END IF;
    EXECUTE 'CREATE ROLE uts_rls_context_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uts_rls_context_owner'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'uts_rls_context_owner exists with unsafe role attributes; use a database operator to set NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS, then retry';
  END IF;
END
$roles$;

-- The migration operator must be able to transfer private objects to this NOLOGIN role.
-- This membership is for the operator only; runtime roles are explicitly rejected below.
DO $grant_context_owner$
BEGIN
  IF NOT pg_has_role(current_user, 'uts_rls_context_owner', 'MEMBER') THEN
    BEGIN
      GRANT uts_rls_context_owner TO CURRENT_USER;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END IF;
END
$grant_context_owner$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_rls_key_admin') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolcreaterole) THEN
      RAISE EXCEPTION 'Migration role % needs CREATEROLE to create uts_rls_key_admin; superuser is not required', current_user;
    END IF;
    EXECUTE 'CREATE ROLE uts_rls_key_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uts_rls_key_admin'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'uts_rls_key_admin exists with unsafe role attributes; use a database operator to set NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS, then retry';
  END IF;
END
$roles$;
-- Keep key provisioning separate from runtime roles while allowing the migration operator
-- to assume this role when inserting or rotating a key.
DO $grant_key_admin$
DECLARE
  v_pg_version integer;
  v_operator_can_set_key_admin boolean;
BEGIN
  IF NOT pg_has_role(current_user, 'uts_rls_key_admin', 'MEMBER') THEN
    BEGIN
      GRANT uts_rls_key_admin TO CURRENT_USER;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
  END IF;

  v_pg_version := current_setting('server_version_num')::integer;
  IF v_pg_version >= 160000 THEN
    -- PostgreSQL 16 separates membership from the ability to SET ROLE.
    v_operator_can_set_key_admin := pg_has_role(current_user, 'uts_rls_key_admin', 'SET');
  ELSE
    -- Before PostgreSQL 16, MEMBER is the supported SET ROLE capability check.
    v_operator_can_set_key_admin := pg_has_role(current_user, 'uts_rls_key_admin', 'MEMBER');
  END IF;

  IF NOT v_operator_can_set_key_admin THEN
    RAISE EXCEPTION 'Migration operator % cannot SET ROLE to uts_rls_key_admin on PostgreSQL % (server_version_num=%). Ensure the operator is authorized to grant itself membership with SET, or have an authorized role administrator grant uts_rls_key_admin with SET to the migration operator, then retry. Existing membership options were not changed',
      current_user, current_setting('server_version'), v_pg_version;
  END IF;
END
$grant_key_admin$;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_assistant_reader')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_assistant_writer') THEN
    RAISE EXCEPTION 'Create distinct LOGIN roles uts_assistant_reader and uts_assistant_writer with NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS before applying migrations 002-004';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('uts_assistant_reader', 'uts_assistant_writer')
      AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Application roles must be distinct LOGIN roles with NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_roles AS app_role
    JOIN pg_roles AS privileged_role
      ON privileged_role.rolsuper OR privileged_role.rolbypassrls OR privileged_role.rolcreaterole
         OR privileged_role.rolname IN ('uts_rls_context_owner', 'uts_rls_key_admin', 'uts_assistant_reader', 'uts_assistant_writer')
    WHERE app_role.rolname IN ('uts_assistant_reader', 'uts_assistant_writer')
      AND privileged_role.oid <> app_role.oid
      AND (
        app_role.rolsuper OR app_role.rolbypassrls OR app_role.rolcreaterole
        OR pg_has_role(app_role.oid, privileged_role.oid, 'MEMBER')
      )
  ) THEN
    RAISE EXCEPTION 'Application PostgreSQL roles must not be privileged or members of privileged/context/key-admin roles';
  END IF;
END
$roles$;

-- PostgreSQL requires the invoking user to have CREATE privilege on the current database
-- when executing CREATE SCHEMA (or ALTER SCHEMA OWNER). Granting CREATE to uts_rls_context_owner
-- does not grant CREATE to current_user.
-- Furthermore, to create a schema with AUTHORIZATION or alter schema owner, the invoking user
-- must be able to SET ROLE to uts_rls_context_owner.
-- PostgreSQL 16 added per-grant SET and INHERIT options; MEMBER alone no longer implies SET ROLE
-- on PG 16+. Version-aware checks are used throughout this block.
DO $schema$
DECLARE
  v_pg_version integer;
  v_database_owner_name text;
  v_database_owner_has_create boolean;
  -- v_operator_is_actual_db_owner: current_user IS the datdba (owns the database directly)
  v_operator_is_actual_db_owner boolean;
  -- v_operator_is_effective_db_owner: actual owner, superuser, or inherited member of datdba role
  v_operator_is_effective_db_owner boolean;
  v_operator_has_database_create boolean;
  v_operator_can_set_context_owner boolean;
  v_context_owner_has_database_create boolean;
  v_temp_granted_context_owner_create boolean := false;
  v_app_private_owner text;
  v_app_private_owner_oid oid;
  v_operator_is_schema_owner boolean;
BEGIN
  v_pg_version := current_setting('server_version_num')::integer;

  -- 1. Identify current database owner and verify privileges separately for:
  --    - current database owner (datdba)
  --    - current_user (migration operator)
  --    - uts_rls_context_owner
  --
  -- v_operator_is_actual_db_owner: true only when current_user = datdba
  -- v_operator_is_effective_db_owner: true when actual owner, superuser, or inherited membership
  --   pg_has_role(user, role, 'USAGE') checks the effective inherited privilege chain (PG 14/15/16).
  --   MEMBER checks membership only; USAGE confirms privileges are actually inherited.
  SELECT
    pg_get_userbyid(d.datdba),
    d.datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user),
    (  d.datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
    OR pg_has_role(current_user, d.datdba, 'USAGE'))
  INTO v_database_owner_name, v_operator_is_actual_db_owner, v_operator_is_effective_db_owner
  FROM pg_database d
  WHERE d.datname = current_database();

  -- Verify privileges for database owner separately
  v_database_owner_has_create := has_database_privilege(v_database_owner_name, current_database(), 'CREATE');

  -- 2. Verify migration operator (current_user) has CREATE privilege on the current database.
  -- PostgreSQL requires the invoking user to have CREATE on the database.
  -- Do not assume granting CREATE to uts_rls_context_owner also grants CREATE to current_user.
  v_operator_has_database_create := has_database_privilege(current_user, current_database(), 'CREATE');
  IF NOT v_operator_has_database_create THEN
    RAISE EXCEPTION 'Migration operator % lacks CREATE privilege on database %. The database owner (currently %) must grant CREATE ON DATABASE % TO % or the migration must run as an appropriately authorized database owner.',
      current_user, current_database(), v_database_owner_name, current_database(), current_user;
  END IF;

  -- 3. Version-aware SET ROLE check for uts_rls_context_owner.
  --    PostgreSQL 14-15: pg_has_role(...,'MEMBER') implies SET ROLE ability.
  --    PostgreSQL 16+:   MEMBER no longer guarantees SET; must check the 'SET' privilege directly.
  --    The 'SET' privilege keyword is only valid in PG 16+; using it on PG 14/15 raises an error.
  IF v_pg_version >= 160000 THEN
    v_operator_can_set_context_owner :=
      pg_has_role(current_user, 'uts_rls_context_owner', 'SET')
      OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper);
  ELSE
    v_operator_can_set_context_owner :=
      pg_has_role(current_user, 'uts_rls_context_owner', 'MEMBER')
      OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper);
  END IF;
  IF NOT v_operator_can_set_context_owner THEN
    RAISE EXCEPTION 'Migration operator % cannot SET ROLE to uts_rls_context_owner on PostgreSQL % (server_version_num=%). On PostgreSQL 16+, MEMBER alone does not grant SET ROLE; the grant must include SET privilege. Ensure % holds the required SET privilege or run as a superuser.',
      current_user, substring(current_setting('server_version') FROM '^[0-9]+'), v_pg_version, current_user;
  END IF;

  -- 4. Verify privileges separately for target owner (uts_rls_context_owner).
  -- Verify/grant temporary CREATE privilege on the database for uts_rls_context_owner if needed.
  -- Preserve pre-existing privileges: if uts_rls_context_owner already has CREATE, do not revoke it later.
  v_context_owner_has_database_create := has_database_privilege('uts_rls_context_owner', current_database(), 'CREATE');
  IF NOT v_context_owner_has_database_create THEN
    -- Only the actual database owner or a superuser may grant CREATE on the database to another role.
    -- Effective (inherited) database owner membership is NOT sufficient to issue a GRANT ON DATABASE.
    -- Bare membership in the datdba role (without inherited authority) must NOT authorize this grant.
    IF NOT (v_operator_is_actual_db_owner
            OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)) THEN
      RAISE EXCEPTION 'Cannot grant temporary CREATE on database % to uts_rls_context_owner: migration role % is not the actual owner of database % and is not a superuser. The database owner (currently %) must pre-grant CREATE to uts_rls_context_owner, or run this migration as the database owner.',
        current_database(), current_user, current_database(), v_database_owner_name;
    END IF;
    EXECUTE format('GRANT CREATE ON DATABASE %I TO uts_rls_context_owner', current_database());
    v_temp_granted_context_owner_create := true;
  END IF;

  -- 5. Create or reassign app_private schema ownership.
  IF to_regnamespace('app_private') IS NULL THEN
    EXECUTE 'CREATE SCHEMA app_private AUTHORIZATION uts_rls_context_owner';
  ELSE
    SELECT pg_get_userbyid(nspowner), nspowner
    INTO v_app_private_owner, v_app_private_owner_oid
    FROM pg_namespace
    WHERE nspname = 'app_private';

    IF v_app_private_owner <> 'uts_rls_context_owner' THEN
      -- Determine whether the operator IS the current schema owner.
      v_operator_is_schema_owner :=
        (SELECT oid FROM pg_roles WHERE rolname = current_user) = v_app_private_owner_oid;

      -- Authorization to ALTER SCHEMA ... OWNER TO requires:
      --   (a) the operator IS the current schema owner, OR
      --   (b) the operator is a superuser, OR
      --   (c) the operator inherits the current schema owner's privileges
      --       (pg_has_role(...,'USAGE') checks the effective inherited privilege chain, not bare membership).
      -- DATABASE OWNERSHIP ALONE does NOT authorize schema ownership transfer.
      -- Bare MEMBER without inherited privileges (NOINHERIT or PG 16 grant without INHERIT) is rejected.
      IF NOT (
        v_operator_is_schema_owner
        OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
        OR pg_has_role(current_user, v_app_private_owner_oid, 'USAGE')
      ) THEN
        RAISE EXCEPTION 'Cannot transfer app_private to uts_rls_context_owner: migration role % does not own schema app_private (currently owned by %) and does not inherit its owner role privileges. Database ownership alone is not sufficient. Run the migration as %, as a role that inherits %''s privileges with USAGE, or as a superuser.',
          current_user, v_app_private_owner, v_app_private_owner, v_app_private_owner;
      END IF;

      BEGIN
        EXECUTE 'ALTER SCHEMA app_private OWNER TO uts_rls_context_owner';
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION 'Cannot transfer app_private to uts_rls_context_owner with the current migration role %. Ensure it owns app_private or inherits its current owner role (not just membership), and that uts_rls_context_owner can temporarily CREATE in database %.',
          current_user, current_database();
      END;
    END IF;
  END IF;

  -- 6. Cleanup temporary privilege if granted, preserving any pre-existing privilege.
  IF v_temp_granted_context_owner_create THEN
    EXECUTE format('REVOKE CREATE ON DATABASE %I FROM uts_rls_context_owner', current_database());
  END IF;
END
$schema$;
-- Least-privilege hardening: remove any existing PUBLIC access to app_private.
-- This deliberately revokes any pre-existing PUBLIC grants on this schema.
-- Individual role access is granted explicitly below.
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;

DO $extension$
DECLARE
  crypto_schema text;
  crypto_owner text;
  crypto_relocatable boolean;
  grant_schema_create boolean := false;
BEGIN
  SELECT namespace.nspname, pg_get_userbyid(extension.extowner), extension.extrelocatable
  INTO crypto_schema, crypto_owner, crypto_relocatable
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'pgcrypto';

  IF crypto_schema IS NULL THEN
    RAISE EXCEPTION 'pgcrypto is not installed; enable pgcrypto in the Supabase Database > Extensions dashboard before applying migration 004. This migration will not create, drop, or recreate extensions';
  ELSIF crypto_schema = 'app_private' THEN
    -- Keep an already-correct extension in place; never move or recreate it.
    NULL;
  ELSIF crypto_schema = 'extensions' AND crypto_owner = current_user AND crypto_relocatable THEN
    IF NOT has_schema_privilege(current_user, 'app_private', 'CREATE') THEN
      BEGIN
        GRANT CREATE ON SCHEMA app_private TO CURRENT_USER;
        grant_schema_create := true;
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE EXCEPTION 'pgcrypto is owned by migration role %, but it cannot temporarily grant CREATE on app_private. Run migration 004 as the app_private owner or grant that operator CREATE on app_private before retrying', current_user;
      END;
    END IF;

    BEGIN
      ALTER EXTENSION pgcrypto SET SCHEMA app_private;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Could not relocate relocatable pgcrypto from extensions to app_private as %. Verify the extension owner and temporary schema CREATE privilege; no extension was dropped or recreated. Original error: %', current_user, SQLERRM;
    END;

    IF grant_schema_create THEN
      REVOKE CREATE ON SCHEMA app_private FROM CURRENT_USER;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsafe pgcrypto installation: schema=%, owner=%, relocatable=%. Expected pgcrypto already in app_private, or in extensions owned by migration role % with relocatable=true. Correct the extension through Supabase before retrying; this migration will not force, drop, or recreate it', crypto_schema, crypto_owner, crypto_relocatable, current_user;
  END IF;

  IF to_regprocedure('app_private.hmac(bytea,bytea,text)') IS NULL THEN
    RAISE EXCEPTION 'pgcrypto is present in app_private but app_private.hmac(bytea, bytea, text) is missing; inspect/repair the extension installation through Supabase before applying migration 004';
  END IF;
END
$extension$;

CREATE TABLE IF NOT EXISTS app_private.rls_context_keys (
  key_id text PRIMARY KEY CHECK (key_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  secret bytea NOT NULL CHECK (octet_length(secret) = 32),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_private.rls_context_keys OWNER TO uts_rls_context_owner;
REVOKE ALL ON TABLE app_private.rls_context_keys FROM PUBLIC, uts_assistant_reader, uts_assistant_writer;
GRANT SELECT ON TABLE app_private.rls_context_keys TO uts_rls_context_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app_private.rls_context_keys TO uts_rls_key_admin;

CREATE OR REPLACE FUNCTION app_private.rls_context_matches(p_row_tenant_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $function$
DECLARE
  v_tenant_id text;
  v_allow_all text;
  v_key_id text;
  v_issued_at_text text;
  v_nonce text;
  v_signature text;
  v_secret bytea;
  v_expected_signature bytea;
  v_issued_at bigint;
  v_payload text;
BEGIN
  v_tenant_id := current_setting('app.tenant_id', true);
  v_allow_all := current_setting('app.allow_all_tenants', true);
  v_key_id := current_setting('app.rls_key_id', true);
  v_issued_at_text := current_setting('app.rls_issued_at', true);
  v_nonce := current_setting('app.rls_nonce', true);
  v_signature := current_setting('app.rls_signature', true);

  IF v_tenant_id IS NULL OR length(v_tenant_id) > 800
     OR v_allow_all IS NULL OR v_allow_all NOT IN ('true', 'false')
     OR v_key_id IS NULL OR v_key_id !~ '^[A-Za-z0-9_-]{1,40}$'
     OR v_issued_at_text IS NULL OR v_issued_at_text !~ '^[0-9]{10}$'
     OR v_nonce IS NULL OR v_nonce !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
     OR v_signature IS NULL OR v_signature !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  v_issued_at := v_issued_at_text::bigint;
  IF abs(extract(epoch FROM statement_timestamp())::bigint - v_issued_at) > 300 THEN
    RETURN false;
  END IF;

  SELECT context_key.secret INTO v_secret
  FROM app_private.rls_context_keys AS context_key
  WHERE context_key.key_id = v_key_id AND context_key.enabled;
  IF v_secret IS NULL THEN
    RETURN false;
  END IF;

  v_payload := 'v1|' || v_key_id || '|' || encode(convert_to(v_tenant_id, 'UTF8'), 'hex')
    || '|' || v_allow_all || '|' || v_issued_at_text || '|' || v_nonce;
  v_expected_signature := hmac(convert_to(v_payload, 'UTF8'), v_secret, 'sha256');
  IF v_expected_signature <> decode(v_signature, 'hex') THEN
    RETURN false;
  END IF;

  RETURN v_allow_all = 'true'
    OR p_row_tenant_id IS NOT DISTINCT FROM NULLIF(v_tenant_id, '');
END
$function$;
ALTER FUNCTION app_private.rls_context_matches(text) OWNER TO uts_rls_context_owner;

CREATE OR REPLACE FUNCTION app_private.rls_context_ready(p_key_id text, p_expected_role text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM app_private.rls_context_keys
    WHERE key_id = p_key_id AND enabled AND octet_length(secret) = 32
  )
  AND p_expected_role IN ('uts_assistant_reader', 'uts_assistant_writer')
  AND session_user::text = p_expected_role
  AND EXISTS (
    SELECT 1 FROM pg_roles AS session_role
    WHERE session_role.rolname = session_user
      AND session_role.rolcanlogin
      AND NOT session_role.rolsuper
      AND NOT session_role.rolbypassrls
      AND NOT session_role.rolcreaterole
  )
  AND EXISTS (
    SELECT 1 FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'knowledge'
      AND relation.relname = 'document_chunks'
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
      AND relation.relowner NOT IN (
        SELECT oid FROM pg_roles WHERE rolname IN ('uts_assistant_reader', 'uts_assistant_writer')
      )
      AND NOT pg_has_role('uts_assistant_reader', relation.relowner, 'MEMBER')
      AND NOT pg_has_role('uts_assistant_writer', relation.relowner, 'MEMBER')
  )
  AND EXISTS (
    SELECT 1 FROM pg_policy AS policy
    JOIN pg_class AS relation ON relation.oid = policy.polrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'knowledge'
      AND relation.relname = 'document_chunks'
      AND policy.polname = 'document_chunks_signed_tenant_context'
      AND policy.polcmd = '*'
      AND policy.polpermissive
      AND cardinality(policy.polroles) = 2
      AND policy.polroles @> ARRAY[
        (SELECT oid FROM pg_roles WHERE rolname = 'uts_assistant_reader'),
        (SELECT oid FROM pg_roles WHERE rolname = 'uts_assistant_writer')
      ]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) ~ '(^|app_private[.])rls_context_matches[(]tenant_id[)]$'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) ~ '(^|app_private[.])rls_context_matches[(]tenant_id[)]$'
  )
  AND NOT has_table_privilege('uts_assistant_reader', 'app_private.rls_context_keys', 'SELECT')
  AND NOT has_table_privilege('uts_assistant_reader', 'app_private.rls_context_keys', 'INSERT')
  AND NOT has_table_privilege('uts_assistant_reader', 'app_private.rls_context_keys', 'UPDATE')
  AND NOT has_table_privilege('uts_assistant_reader', 'app_private.rls_context_keys', 'DELETE')
  AND NOT has_table_privilege('uts_assistant_writer', 'app_private.rls_context_keys', 'SELECT')
  AND NOT has_table_privilege('uts_assistant_writer', 'app_private.rls_context_keys', 'INSERT')
  AND NOT has_table_privilege('uts_assistant_writer', 'app_private.rls_context_keys', 'UPDATE')
  AND NOT has_table_privilege('uts_assistant_writer', 'app_private.rls_context_keys', 'DELETE')
  AND NOT EXISTS (
    SELECT 1
    FROM pg_roles AS app_role
    JOIN pg_roles AS privileged_role
      ON privileged_role.rolsuper OR privileged_role.rolbypassrls OR privileged_role.rolcreaterole
         OR privileged_role.rolname IN ('uts_rls_context_owner', 'uts_rls_key_admin', 'uts_assistant_reader', 'uts_assistant_writer')
    WHERE app_role.rolname IN ('uts_assistant_reader', 'uts_assistant_writer')
      AND privileged_role.oid <> app_role.oid
      AND (
        app_role.rolsuper OR app_role.rolbypassrls OR app_role.rolcreaterole
        OR pg_has_role(app_role.oid, privileged_role.oid, 'MEMBER')
      )
  )
  AND NOT pg_has_role('uts_assistant_reader', 'uts_rls_context_owner', 'MEMBER')
  AND NOT pg_has_role('uts_assistant_writer', 'uts_rls_context_owner', 'MEMBER')
  AND NOT pg_has_role('uts_assistant_reader', 'uts_rls_key_admin', 'MEMBER')
  AND NOT pg_has_role('uts_assistant_writer', 'uts_rls_key_admin', 'MEMBER')
$function$;
ALTER FUNCTION app_private.rls_context_ready(text, text) OWNER TO uts_rls_context_owner;

REVOKE ALL ON FUNCTION app_private.rls_context_matches(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.rls_context_ready(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.hmac(bytea, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.hmac(bytea, bytea, text) TO uts_rls_context_owner;

DROP POLICY IF EXISTS document_chunks_tenant_isolation ON knowledge.document_chunks;
DROP POLICY IF EXISTS document_chunks_signed_tenant_context ON knowledge.document_chunks;
ALTER TABLE knowledge.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.document_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY document_chunks_signed_tenant_context ON knowledge.document_chunks
  AS PERMISSIVE
  FOR ALL
  TO uts_assistant_reader, uts_assistant_writer
  USING (app_private.rls_context_matches(tenant_id))
  WITH CHECK (app_private.rls_context_matches(tenant_id));

GRANT USAGE ON SCHEMA app_private TO uts_assistant_reader, uts_assistant_writer;
GRANT EXECUTE ON FUNCTION app_private.rls_context_matches(text) TO uts_assistant_reader, uts_assistant_writer;
GRANT EXECUTE ON FUNCTION app_private.rls_context_ready(text, text) TO uts_assistant_reader, uts_assistant_writer;
