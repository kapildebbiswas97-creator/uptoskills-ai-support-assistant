-- Replace the caller-trusted custom-GUC policy with an HMAC-verified transaction context.
-- Provision the key through the operator procedure; never put a key in a migration.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_rls_context_owner') THEN
    EXECUTE 'CREATE ROLE uts_rls_context_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;
END
$roles$;

ALTER ROLE uts_rls_context_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
-- The migration operator must be able to transfer private objects to this NOLOGIN role.
-- This membership is for the operator only; runtime roles are explicitly rejected below.
GRANT uts_rls_context_owner TO CURRENT_USER;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_rls_key_admin') THEN
    EXECUTE 'CREATE ROLE uts_rls_key_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;
END
$roles$;
ALTER ROLE uts_rls_key_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
-- Keep key provisioning separate from runtime roles while allowing the migration operator
-- to assume this role when inserting or rotating a key.
GRANT uts_rls_key_admin TO CURRENT_USER;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_assistant_reader')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_assistant_writer') THEN
    RAISE EXCEPTION 'Create the least-privilege uts_assistant_reader and uts_assistant_writer roles before applying signed RLS';
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

CREATE SCHEMA IF NOT EXISTS app_private AUTHORIZATION uts_rls_context_owner;
ALTER SCHEMA app_private OWNER TO uts_rls_context_owner;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;

DO $extension$
DECLARE
  crypto_schema text;
BEGIN
  SELECT namespace.nspname INTO crypto_schema
  FROM pg_extension extension
  JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'pgcrypto';

  IF crypto_schema IS NULL THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA app_private';
  ELSIF crypto_schema <> 'app_private' THEN
    RAISE EXCEPTION 'pgcrypto is installed in schema %, review and move it to app_private before applying signed RLS', crypto_schema;
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
