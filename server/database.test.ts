import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setSignedRlsContext, shouldApplyPostgresMigration, vectorLiteral } from './database';
import type { PoolClient } from 'pg';
import { migrateLocalPostgres } from '../scripts/migrate-local-postgres';
import { provisionLocalRlsKey } from '../scripts/provision-local-rls-key';

test('formats finite embedding values for a parameterized pgvector query', () => {
  assert.equal(vectorLiteral([0.25, -0.5, 1]), '[0.25,-0.5,1]');
  assert.throws(() => vectorLiteral([]), /finite numeric values/);
  assert.throws(() => vectorLiteral([Number.NaN]), /finite numeric values/);
});

test('Supabase Auth migration is not applied to a generic application PostgreSQL database', () => {
  assert.equal(shouldApplyPostgresMigration('002-document-chunks.sql', {}), true);
  assert.equal(shouldApplyPostgresMigration('005-supabase-auth-roles-and-hook.sql', {}), false);
  assert.equal(shouldApplyPostgresMigration('005-supabase-auth-roles-and-hook.sql', { SUPABASE_URL: 'https://project.supabase.co' }), true);
});

test('PostgreSQL document chunks enable forced tenant row-level security', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'infra/postgres/migrations/003-document-chunk-rls.sql'), 'utf8');
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migration, /app\.tenant_id/i);
  assert.match(migration, /app\.allow_all_tenants/i);
  assert.match(migration, /IS NOT DISTINCT FROM/i);
});

test('Supabase Auth hook uses the documented response and narrowly scoped invoker permissions', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'infra/postgres/migrations/005-supabase-auth-roles-and-hook.sql'), 'utf8');
  const hook = migration.match(/CREATE OR REPLACE FUNCTION public\.custom_access_token_hook\(event jsonb\)([\s\S]*?)\n\$\$;/i)?.[1] ?? '';
  assert.match(hook, /RETURNS jsonb/i);
  assert.match(hook, /SECURITY INVOKER/i);
  assert.doesNotMatch(hook, /SECURITY DEFINER/i);
  assert.match(hook, /WHERE user_id = v_user_id/i);
  assert.match(hook, /jsonb_build_object\('claims', v_claims\)/i);
  assert.match(migration, /GRANT USAGE ON SCHEMA public TO supabase_auth_admin/i);
  assert.match(migration, /GRANT SELECT ON TABLE public\.user_roles TO supabase_auth_admin/i);
  assert.match(migration, /CREATE POLICY user_roles_auth_hook_read ON public\.user_roles FOR SELECT TO supabase_auth_admin USING \(true\)/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.custom_access_token_hook\(jsonb\) FROM PUBLIC, anon, authenticated/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.assign_user_role\(uuid, text, text\) FROM PUBLIC, anon, authenticated/i);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION public\.assign_user_role\(uuid, text, text\) TO authenticated/i);
  assert.match(migration, /ON CONFLICT \(user_id, role\) DO NOTHING/i);
  assert.match(migration, /VALUES \(NEW\.id, 'user', NULL\)/i);
});

test('signed RLS migration removes direct GUC trust and keeps the signing key behind a hardened function', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'infra/postgres/migrations/004-signed-tenant-rls.sql'), 'utf8');
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migration, /SECURITY DEFINER/i);
  assert.match(migration, /SET search_path = pg_catalog, app_private/i);
  assert.match(migration, /hmac\(convert_to\(v_payload/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app_private\.rls_context_keys/i);
  assert.match(migration, /CREATE POLICY document_chunks_signed_tenant_context/i);
  assert.match(migration, /app_private\.rls_context_matches\(tenant_id\)/i);
  assert.match(migration, /abs\(extract\(epoch FROM statement_timestamp\(\)\)::bigint - v_issued_at\) > 300/i);
  assert.match(migration, /pg_has_role\(app_role\.oid, privileged_role\.oid, 'MEMBER'\)/i);
  assert.match(migration, /GRANT uts_rls_context_owner TO CURRENT_USER/i);
  assert.match(migration, /GRANT uts_rls_key_admin TO CURRENT_USER/i);
  assert.match(migration, /session_user::text = p_expected_role/i);
  assert.match(migration, /pg_catalog\.pg_get_expr\(policy\.polqual, policy\.polrelid\)/i);
  assert.match(migration, /has_table_privilege\('uts_assistant_writer', 'app_private\.rls_context_keys', 'SELECT'\)/i);
  assert.match(migration, /NOBYPASSRLS/i);
  assert.doesNotMatch(migration, /current_setting\('app\.allow_all_tenants',\s*true\)\s*=\s*'true'/i);
  assert.match(migration, /REVOKE ALL ON TABLE app_private\.rls_context_keys FROM PUBLIC, uts_assistant_reader, uts_assistant_writer/i);
});

test('pgcrypto already in app_private is preserved and hmac presence is required', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'infra/postgres/migrations/004-signed-tenant-rls.sql'), 'utf8');
  const cryptoBlock = migration.match(/DO \$extension\$([\s\S]*?)\$extension\$;/i)?.[1] ?? '';
  const alreadyPrivate = cryptoBlock.match(/ELSIF crypto_schema = 'app_private' THEN([\s\S]*?)ELSIF crypto_schema = 'extensions'/i)?.[1] ?? '';
  assert.match(alreadyPrivate, /Keep an already-correct extension in place/i);
  assert.doesNotMatch(alreadyPrivate, /ALTER EXTENSION|CREATE EXTENSION|DROP EXTENSION/i);
  assert.match(cryptoBlock, /to_regprocedure\('app_private\.hmac\(bytea,bytea,text\)'\) IS NULL/i);
  assert.match(cryptoBlock, /pgcrypto is present in app_private but app_private\.hmac/i);
});

test('relocatable pgcrypto in extensions moves only when owned by the migration operator', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'infra/postgres/migrations/004-signed-tenant-rls.sql'), 'utf8');
  const cryptoBlock = migration.match(/DO \$extension\$([\s\S]*?)\$extension\$;/i)?.[1] ?? '';
  assert.match(cryptoBlock, /crypto_schema = 'extensions' AND crypto_owner = current_user AND crypto_relocatable/i);
  assert.match(cryptoBlock, /has_schema_privilege\(current_user, 'app_private', 'CREATE'\)/i);
  assert.match(cryptoBlock, /GRANT CREATE ON SCHEMA app_private TO CURRENT_USER/i);
  assert.match(cryptoBlock, /ALTER EXTENSION pgcrypto SET SCHEMA app_private/i);
  assert.match(cryptoBlock, /REVOKE CREATE ON SCHEMA app_private FROM CURRENT_USER/i);
  assert.match(cryptoBlock, /Unsafe pgcrypto installation: schema=%, owner=%, relocatable=%/i);
});

test('wrong-owner and non-relocatable pgcrypto fail before signed RLS replaces the existing policy', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'infra/postgres/migrations/004-signed-tenant-rls.sql'), 'utf8');
  const cryptoBlock = migration.match(/DO \$extension\$([\s\S]*?)\$extension\$;/i)?.[1] ?? '';
  assert.match(cryptoBlock, /crypto_owner = current_user AND crypto_relocatable/i);
  assert.match(cryptoBlock, /crypto_relocatable boolean/i);
  assert.match(cryptoBlock, /Unsafe pgcrypto installation/i);
  assert.doesNotMatch(cryptoBlock, /^\s*(?:DROP|CREATE)\s+EXTENSION\b/gim);
  const hmacGuard = migration.indexOf("to_regprocedure('app_private.hmac(bytea,bytea,text)') IS NULL");
  const oldPolicyDrop = migration.indexOf('DROP POLICY IF EXISTS document_chunks_tenant_isolation');
  const finalPolicyCreate = migration.indexOf('CREATE POLICY document_chunks_signed_tenant_context');
  assert.ok(hmacGuard >= 0 && oldPolicyDrop > hmacGuard && finalPolicyCreate > oldPolicyDrop);
  assert.match(migration.slice(oldPolicyDrop), /ENABLE ROW LEVEL SECURITY[\s\S]*FORCE ROW LEVEL SECURITY/i);
});

test('pgvector type and cosine operator class resolve from the verified extension schema', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'infra/postgres/migrations/002-document-chunks.sql'), 'utf8');
  const runtime = await readFile(path.resolve(process.cwd(), 'server/database.ts'), 'utf8');
  assert.match(migration, /extension\.extname = 'vector'/i);
  assert.match(migration, /has_schema_privilege\(current_user, vector_schema, 'USAGE'\)/i);
  assert.match(migration, /type\.typname = 'vector'/i);
  assert.match(migration, /opclass\.opcname = 'vector_cosine_ops'/i);
  assert.match(migration, /set_config\([\s\S]*pg_catalog, %I, public, knowledge[\s\S]*true/i);
  assert.match(migration, /embedding vector\(768\)/i);
  assert.match(migration, /GRANT USAGE ON SCHEMA knowledge TO uts_assistant_reader, uts_assistant_writer/i);
  assert.match(migration, /GRANT USAGE ON SCHEMA %I TO uts_assistant_reader, uts_assistant_writer/i);
  assert.match(runtime, /POSTGRES_VECTOR_SEARCH_PATH = 'pg_catalog, extensions, public, knowledge'/i);
  assert.match(runtime, /prepareVectorClient\(client\)/i);
});

test('Supabase migration roles use CREATEROLE safely without superuser role changes', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'infra/postgres/migrations/004-signed-tenant-rls.sql'), 'utf8');
  assert.match(migration, /rolcreaterole\)[\s\S]*CREATE ROLE uts_rls_context_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS/i);
  assert.match(migration, /CREATE ROLE uts_rls_key_admin NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS/i);
  assert.doesNotMatch(migration, /ALTER ROLE\s+uts_rls_/i);
  assert.match(migration, /GRANT CREATE ON DATABASE %I TO uts_rls_context_owner/i);
  assert.match(migration, /REVOKE CREATE ON DATABASE %I FROM uts_rls_context_owner/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app_private\.rls_context_keys/i);
  assert.match(migration, /REVOKE ALL ON TABLE app_private\.rls_context_keys FROM PUBLIC, uts_assistant_reader, uts_assistant_writer/i);
});

test('key-admin SET ROLE authorization is version-aware, fail-closed, and preserves existing membership', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'infra/postgres/migrations/004-signed-tenant-rls.sql'), 'utf8');
  const block = migration.match(/DO \$grant_key_admin\$([\s\S]*?)\$grant_key_admin\$;/i)?.[1] ?? '';
  assert.match(block, /IF NOT pg_has_role\(current_user, 'uts_rls_key_admin', 'MEMBER'\) THEN[\s\S]*?GRANT uts_rls_key_admin TO CURRENT_USER/i);
  assert.match(block, /v_pg_version := current_setting\('server_version_num'\)::integer/i);
  assert.match(block, /IF v_pg_version >= 160000 THEN[\s\S]*?pg_has_role\(current_user, 'uts_rls_key_admin', 'SET'\)[\s\S]*?ELSE[\s\S]*?pg_has_role\(current_user, 'uts_rls_key_admin', 'MEMBER'\)/i);
  assert.match(block, /IF NOT v_operator_can_set_key_admin THEN[\s\S]*?cannot SET ROLE to uts_rls_key_admin/i);
  assert.match(block, /Existing membership options were not changed/i);

  function authorizeKeyAdmin(input: {
    pgVersion: 140000 | 150000 | 160000;
    member: boolean;
    set: boolean;
    grantAllowed: boolean;
    membershipOptions?: { admin: boolean; set: boolean; inherit: boolean };
  }) {
    const events: string[] = [];
    let member = input.member;
    const membershipOptions = input.membershipOptions && { ...input.membershipOptions };
    if (!member) {
      events.push('GRANT attempt');
      if (input.grantAllowed) member = true;
    }
    if (input.pgVersion >= 160000) {
      events.push('SET check');
      if (!input.set) throw new Error('cannot SET ROLE to uts_rls_key_admin');
    } else {
      events.push('MEMBER check');
      if (!member) throw new Error('cannot SET ROLE to uts_rls_key_admin');
    }
    return { events, membershipOptions };
  }

  // PG 16: membership alone is insufficient; do not try to modify its options.
  const pg16MemberWithoutSet = { admin: false, set: false, inherit: false };
  assert.throws(() => authorizeKeyAdmin({
    pgVersion: 160000, member: true, set: false, grantAllowed: true,
    membershipOptions: pg16MemberWithoutSet,
  }), /cannot SET ROLE to uts_rls_key_admin/);
  assert.deepEqual(pg16MemberWithoutSet, { admin: false, set: false, inherit: false });

  // PG 16: SET=true succeeds without granting or rewriting membership.
  const pg16Valid = { admin: false, set: true, inherit: false };
  const pg16Result = authorizeKeyAdmin({ pgVersion: 160000, member: true, set: true, grantAllowed: true, membershipOptions: pg16Valid });
  assert.deepEqual(pg16Result.events, ['SET check']);
  assert.deepEqual(pg16Result.membershipOptions, pg16Valid);

  // PG 14–15 use MEMBER only; the PostgreSQL 16 SET check is not executed.
  for (const pgVersion of [140000, 150000] as const) {
    const result = authorizeKeyAdmin({ pgVersion, member: true, set: false, grantAllowed: true });
    assert.deepEqual(result.events, ['MEMBER check']);
  }

  // If no membership exists and the operator cannot establish one, fail closed.
  assert.throws(() => authorizeKeyAdmin({
    pgVersion: 160000, member: false, set: false, grantAllowed: false,
  }), /cannot SET ROLE to uts_rls_key_admin/);
  assert.deepEqual(authorizeKeyAdmin({
    pgVersion: 150000, member: false, set: false, grantAllowed: true,
  }).events, ['GRANT attempt', 'MEMBER check']);
});

test('Supabase auth migration enforces server-controlled roles, forced RLS, and custom access token hook', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'infra/postgres/migrations/005-supabase-auth-roles-and-hook.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.user_roles/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/i);
  assert.match(migration, /CHECK \(role IN \('super_admin', 'admin', 'support_agent', 'knowledge_manager', 'user'\)\)/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.custom_access_token_hook/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.assign_user_role/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.handle_new_user_role/i);
  assert.match(migration, /VALUES \(NEW\.id, 'user', NULL\)/i);
  assert.match(migration, /user_id = auth\.uid\(\)/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.custom_access_token_hook/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.custom_access_token_hook\(jsonb\) TO supabase_auth_admin/i);
});

test('tenant settings are transaction-local and cannot be set before secure migration/key readiness', async () => {
  const priorKeyId = process.env.RLS_CONTEXT_KEY_ID;
  const priorKey = process.env.RLS_CONTEXT_HMAC_KEY;
  process.env.RLS_CONTEXT_KEY_ID = 'unit-test-key';
  process.env.RLS_CONTEXT_HMAC_KEY = Buffer.alloc(32, 4).toString('base64url');
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let ready = true;
  const fakeClient = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: sql.includes('rls_context_ready') ? [{ ready }] : [] };
    },
  } as unknown as Pick<PoolClient, 'query'>;
  try {
    await setSignedRlsContext(fakeClient, 'tenant-a', false, 'uts_assistant_writer');
    assert.match(calls[0].sql, /app_private\.rls_context_ready/);
    assert.deepEqual(calls[0].values, ['unit-test-key', 'uts_assistant_writer']);
    assert.match(calls[1].sql, /set_config\('app\.tenant_id',[\s\S]*true\)/);
    assert.match(calls[1].sql, /app\.rls_signature/);
    assert.equal(calls[1].values?.[0], 'tenant-a');
    assert.equal(calls[1].values?.[1], 'false');
    assert.match(String(calls[1].values?.[5]), /^[0-9a-f]{64}$/);

    calls.length = 0;
    ready = false;
    await assert.rejects(() => setSignedRlsContext(fakeClient, 'tenant-a', false, 'uts_assistant_writer'), /SECURE_RLS_RUNTIME_ROLE_OR_CONTEXT_NOT_READY/);
    assert.equal(calls.length, 1);

    calls.length = 0;
    const missingMigrationClient = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, values });
        throw new Error('function app_private.rls_context_ready does not exist');
      },
    } as unknown as Pick<PoolClient, 'query'>;
    await assert.rejects(() => setSignedRlsContext(missingMigrationClient, 'tenant-a', false, 'uts_assistant_writer'), /SECURE_RLS_MIGRATION_REQUIRED/);
    assert.equal(calls.length, 1);
  } finally {
    if (priorKeyId === undefined) delete process.env.RLS_CONTEXT_KEY_ID;
    else process.env.RLS_CONTEXT_KEY_ID = priorKeyId;
    if (priorKey === undefined) delete process.env.RLS_CONTEXT_HMAC_KEY;
    else process.env.RLS_CONTEXT_HMAC_KEY = priorKey;
  }
});

test('local PostgreSQL maintenance helpers refuse non-local targets before connecting', async () => {
  await assert.rejects(() => migrateLocalPostgres({ APP_ENV: 'staging', DATABASE_MIGRATION_URL: 'postgresql://user:password@127.0.0.1/db_integration' }), /LOCAL_INTEGRATION_ONLY/);
  await assert.rejects(() => provisionLocalRlsKey({ APP_ENV: 'staging' }), /LOCAL_INTEGRATION_ONLY/);
  await assert.rejects(() => migrateLocalPostgres({ APP_ENV: 'local-integration', DATABASE_MIGRATION_URL: 'postgresql://user:password@example.invalid/db_integration' }), /LOOPBACK_POSTGRES_REQUIRED/);
  await assert.rejects(() => migrateLocalPostgres({ APP_ENV: 'local-integration', DATABASE_MIGRATION_URL: 'postgresql://user:password@127.0.0.1/production' }), /DISPOSABLE_INTEGRATION_DATABASE_REQUIRED/);
  await assert.rejects(() => provisionLocalRlsKey({
    APP_ENV: 'local-integration',
    DATABASE_MIGRATION_URL: 'postgresql://operator:password@127.0.0.1/db_integration',
    RLS_CONTEXT_KEY_ID: 'local-test',
    RLS_CONTEXT_HMAC_KEY: Buffer.alloc(32, 1).toString('base64url'),
  }), /DATABASE_URL_READER_REQUIRED/);
});

test('migration 004 schema creation verifies operator and target privileges separately with actionable errors', async () => {
  const migration = await readFile(path.resolve(process.cwd(), 'infra/postgres/migrations/004-signed-tenant-rls.sql'), 'utf8');
  const schemaBlock = migration.match(/DO \$schema\$([\s\S]*?)\$schema\$;/i)?.[1] ?? '';

  // 1a. Separate privilege checks: operator (current_user), database owner (v_database_owner_name), target (uts_rls_context_owner)
  assert.match(schemaBlock, /has_database_privilege\(current_user,\s*current_database\(\),\s*'CREATE'\)/i);
  assert.match(schemaBlock, /has_database_privilege\('uts_rls_context_owner',\s*current_database\(\),\s*'CREATE'\)/i);
  assert.match(schemaBlock, /has_database_privilege\(v_database_owner_name,\s*current_database\(\),\s*'CREATE'\)/i);

  // 1b. Version detection: server_version_num must be used for PG 14/15/16 branching
  assert.match(schemaBlock, /current_setting\('server_version_num'\)::integer/i);
  // PG 16+ branch uses 'SET' privilege; PG 14/15 branch uses 'MEMBER'
  assert.match(schemaBlock, /pg_has_role\(current_user,\s*'uts_rls_context_owner',\s*'SET'\)/i);
  assert.match(schemaBlock, /pg_has_role\(current_user,\s*'uts_rls_context_owner',\s*'MEMBER'\)/i);
  // Version threshold
  assert.match(schemaBlock, /160000/);

  // 2. Actionable error when operator lacks CREATE
  assert.match(schemaBlock, /Migration operator % lacks CREATE privilege on database %/i);
  assert.match(schemaBlock, /The database owner \(currently %\) must grant CREATE ON DATABASE % TO %/i);

  // 3. SET ROLE check: actionable error naming what the operator must do on PG 16+
  assert.match(schemaBlock, /Migration operator % cannot SET ROLE to uts_rls_context_owner/i);
  assert.match(schemaBlock, /SET privilege/i);

  // 4. Temporary grant: only actual DB owner or superuser may issue it
  assert.match(schemaBlock, /GRANT CREATE ON DATABASE %I TO uts_rls_context_owner/i);
  assert.match(schemaBlock, /REVOKE CREATE ON DATABASE %I FROM uts_rls_context_owner/i);
  assert.match(schemaBlock, /v_temp_granted_context_owner_create boolean := false/i);
  // The guard must require actual owner or superuser, NOT mere effective/inherited DB owner
  assert.match(schemaBlock, /v_operator_is_actual_db_owner/i);

  // 5. Schema ownership transfer: must use pg_has_role(...,'USAGE') not bare MEMBER for INHERIT check
  assert.match(schemaBlock, /pg_has_role\(current_user,\s*v_app_private_owner_oid,\s*'USAGE'\)/i);
  // Must NOT use v_operator_is_database_owner (old defect A shortcut) for schema transfer decision
  assert.doesNotMatch(schemaBlock, /COALESCE\(v_operator_is_database_owner/i);
  // Actionable error for schema transfer failure
  assert.match(schemaBlock, /Cannot transfer app_private to uts_rls_context_owner: migration role % does not own schema app_private/i);
  assert.match(schemaBlock, /Database ownership alone is not sufficient/i);
  assert.match(schemaBlock, /ALTER SCHEMA app_private OWNER TO uts_rls_context_owner/i);
});

test('migration 004 schema block state machine correctly handles all 12 privilege scenarios', () => {
  /**
   * Simulation of migration 004 $schema$ block privilege-check state machine.
   *
   * Models:
   *   - v_pg_version: 14x000, 15x000, or 16x000 (controls SET vs MEMBER for SET ROLE check)
   *   - v_operator_is_actual_db_owner: current_user === databaseOwner (exact match, not inherited)
   *   - v_operator_is_effective_db_owner: actual owner | superuser | inherited USAGE membership
   *   - Temp DB CREATE grant requires actual owner or superuser (NOT just effective owner)
   *   - Schema ownership transfer requires: schema owner | superuser | inherited USAGE of schema owner
   *     DATABASE OWNERSHIP ALONE does NOT authorize schema ownership transfer.
   *   - SET ROLE check is version-aware:
   *     PG 14/15: operatorRoleMemberships.includes('uts_rls_context_owner') (simulates MEMBER)
   *     PG 16+:   operatorHasSetPrivilege (simulates pg_has_role(...,'SET'))
   *
   * NOTE: This is a TypeScript simulation only. No live PostgreSQL instance is available.
   * Tests verify the decision logic, not actual SQL execution.
   */
  function simulateSchemaMigration(state: {
    pgVersion: 140000 | 150000 | 160000;
    currentUser: string;
    currentDatabase?: string;
    databaseOwner: string;
    isSuperuser?: boolean;
    operatorHasDbCreate: boolean;
    // simulates pg_has_role(currentUser, 'uts_rls_context_owner', 'MEMBER')
    operatorRoleMemberships: string[];
    // simulates pg_has_role(currentUser, 'uts_rls_context_owner', 'SET') — PG 16+ only
    operatorHasSetPrivilege?: boolean;
    contextOwnerHasDbCreate: boolean;
    existingAppPrivateOwner?: string;
    // simulates pg_has_role(currentUser, schemaOwnerOid, 'USAGE') — inherited owner membership
    operatorInheritsSchemaOwner?: boolean;
  }) {
    const currentDatabase = state.currentDatabase ?? 'uts_integration';
    const currentUser = state.currentUser;
    const isSuperuser = Boolean(state.isSuperuser);
    const pgVersion = state.pgVersion;

    // DB owner identification (mirrors SQL: actual vs effective)
    const operatorIsActualDbOwner = state.databaseOwner === currentUser;
    const operatorIsEffectiveDbOwner = operatorIsActualDbOwner
      || isSuperuser
      || state.operatorRoleMemberships.includes(state.databaseOwner); // simplification of USAGE check

    let contextOwnerHasDbCreate = state.contextOwnerHasDbCreate;
    let tempGrantedContextOwnerCreate = false;
    const executedSql: string[] = [];

    // Step 2: Operator must have CREATE on the database
    const operatorHasDbCreate = isSuperuser || state.operatorHasDbCreate;
    if (!operatorHasDbCreate) {
      throw new Error(
        `Migration operator ${currentUser} lacks CREATE privilege on database ${currentDatabase}. The database owner (currently ${state.databaseOwner}) must grant CREATE ON DATABASE ${currentDatabase} TO ${currentUser} or the migration must run as an appropriately authorized database owner.`
      );
    }

    // Step 3: Version-aware SET ROLE check
    // PG 14/15: use MEMBER; PG 16+: use SET privilege
    let operatorCanSetContextOwner: boolean;
    if (pgVersion >= 160000) {
      operatorCanSetContextOwner = isSuperuser || Boolean(state.operatorHasSetPrivilege);
    } else {
      operatorCanSetContextOwner = isSuperuser || state.operatorRoleMemberships.includes('uts_rls_context_owner');
    }
    if (!operatorCanSetContextOwner) {
      throw new Error(
        `Migration operator ${currentUser} cannot SET ROLE to uts_rls_context_owner on PostgreSQL ${pgVersion}. On PostgreSQL 16+, MEMBER alone does not grant SET ROLE; the grant must include SET privilege. Ensure ${currentUser} holds the required SET privilege or run as a superuser.`
      );
    }

    // Step 4: Temp DB CREATE — only actual DB owner or superuser may grant
    if (!contextOwnerHasDbCreate) {
      if (!(operatorIsActualDbOwner || isSuperuser)) {
        throw new Error(
          `Cannot grant temporary CREATE on database ${currentDatabase} to uts_rls_context_owner: migration role ${currentUser} is not the actual owner of database ${currentDatabase} and is not a superuser. The database owner (currently ${state.databaseOwner}) must pre-grant CREATE to uts_rls_context_owner, or run this migration as the database owner.`
        );
      }
      executedSql.push(`GRANT CREATE ON DATABASE ${currentDatabase} TO uts_rls_context_owner`);
      tempGrantedContextOwnerCreate = true;
      contextOwnerHasDbCreate = true;
    }

    // Step 5: Create schema or alter owner
    if (state.existingAppPrivateOwner === undefined) {
      executedSql.push('CREATE SCHEMA app_private AUTHORIZATION uts_rls_context_owner');
    } else {
      const currentOwner = state.existingAppPrivateOwner;
      if (currentOwner !== 'uts_rls_context_owner') {
        // Schema ownership transfer:
        //   - operator IS the schema owner, OR
        //   - operator is superuser, OR
        //   - operator inherits schema owner privileges (pg_has_role(...,'USAGE'))
        // DATABASE OWNERSHIP ALONE does NOT authorize schema ownership transfer.
        const operatorIsSchemaOwner = currentUser === currentOwner;
        const operatorInheritsSchemaOwner = Boolean(state.operatorInheritsSchemaOwner);
        const canAlterOwner = isSuperuser || operatorIsSchemaOwner || operatorInheritsSchemaOwner;
        if (!canAlterOwner) {
          throw new Error(
            `Cannot transfer app_private to uts_rls_context_owner: migration role ${currentUser} does not own schema app_private (currently owned by ${currentOwner}) and does not inherit its owner role privileges. Database ownership alone is not sufficient. Run the migration as ${currentOwner}, as a role that inherits ${currentOwner}'s privileges with USAGE, or as a superuser.`
          );
        }
        executedSql.push('ALTER SCHEMA app_private OWNER TO uts_rls_context_owner');
      }
    }

    // Step 6: Cleanup temporary grant (preserves pre-existing privileges)
    if (tempGrantedContextOwnerCreate) {
      executedSql.push(`REVOKE CREATE ON DATABASE ${currentDatabase} FROM uts_rls_context_owner`);
    }

    return { executedSql };
  }

  // ── SCENARIO 1: database owner, no existing schema, temp grant + revoke ──────────────────────
  const res1 = simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'uts_admin',
    databaseOwner: 'uts_admin',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner'],
    contextOwnerHasDbCreate: false,
  });
  assert.deepEqual(res1.executedSql, [
    'GRANT CREATE ON DATABASE uts_integration TO uts_rls_context_owner',
    'CREATE SCHEMA app_private AUTHORIZATION uts_rls_context_owner',
    'REVOKE CREATE ON DATABASE uts_integration FROM uts_rls_context_owner',
  ]);

  // ── SCENARIO 1b: DB owner, target already has CREATE (pre-existing privilege preserved, no revoke) ──
  const res1b = simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'uts_admin',
    databaseOwner: 'uts_admin',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner'],
    contextOwnerHasDbCreate: true,
  });
  assert.deepEqual(res1b.executedSql, [
    'CREATE SCHEMA app_private AUTHORIZATION uts_rls_context_owner',
  ]);

  // ── SCENARIO 2: non-owner operator with DB CREATE, target pre-granted CREATE ───────────────────
  const res2 = simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'deployer',
    databaseOwner: 'postgres',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner'],
    contextOwnerHasDbCreate: true,
  });
  assert.deepEqual(res2.executedSql, [
    'CREATE SCHEMA app_private AUTHORIZATION uts_rls_context_owner',
  ]);

  // ── SCENARIO 3: non-owner operator lacks DB CREATE ───────────────────────────────────────────
  assert.throws(() => simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'readonly_deployer',
    databaseOwner: 'postgres',
    operatorHasDbCreate: false,
    operatorRoleMemberships: ['uts_rls_context_owner'],
    contextOwnerHasDbCreate: true,
  }), /Migration operator readonly_deployer lacks CREATE privilege on database/);

  // ── SCENARIO 4: target owner lacks CREATE, operator is non-actual-owner → cannot grant ────────
  // Even if operator is "effective" DB owner via inherited membership, temp GRANT requires actual ownership.
  assert.throws(() => simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'deployer',
    databaseOwner: 'postgres',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner', 'postgres'], // effective DB owner via membership
    contextOwnerHasDbCreate: false,
  }), /Cannot grant temporary CREATE on database uts_integration to uts_rls_context_owner: migration role deployer is not the actual owner/);

  // ── SCENARIO 5: missing SET ROLE capability (PG 15) ─────────────────────────────────────────
  assert.throws(() => simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'deployer',
    databaseOwner: 'postgres',
    operatorHasDbCreate: true,
    operatorRoleMemberships: [], // no MEMBER in uts_rls_context_owner
    contextOwnerHasDbCreate: true,
  }), /Migration operator deployer cannot SET ROLE to uts_rls_context_owner/);

  // ── SCENARIO 6: PG 16 — MEMBER=true but SET=false → must fail SET ROLE check ─────────────────
  assert.throws(() => simulateSchemaMigration({
    pgVersion: 160000,
    currentUser: 'deployer',
    databaseOwner: 'postgres',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner'], // MEMBER present, but SET not granted
    operatorHasSetPrivilege: false,
    contextOwnerHasDbCreate: true,
  }), /Migration operator deployer cannot SET ROLE to uts_rls_context_owner on PostgreSQL 160000/);

  // ── SCENARIO 7: PG 16 — SET=true → passes SET ROLE check ───────────────────────────────────
  const res7 = simulateSchemaMigration({
    pgVersion: 160000,
    currentUser: 'deployer',
    databaseOwner: 'postgres',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner'],
    operatorHasSetPrivilege: true,
    contextOwnerHasDbCreate: true,
  });
  assert.deepEqual(res7.executedSql, [
    'CREATE SCHEMA app_private AUTHORIZATION uts_rls_context_owner',
  ]);

  // ── SCENARIO 8: PG 14 — MEMBER=true → passes SET ROLE check (no SET keyword used) ───────────
  const res8 = simulateSchemaMigration({
    pgVersion: 140000,
    currentUser: 'deployer',
    databaseOwner: 'postgres',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner'],
    // operatorHasSetPrivilege is irrelevant on PG 14 (not checked)
    contextOwnerHasDbCreate: true,
  });
  assert.deepEqual(res8.executedSql, [
    'CREATE SCHEMA app_private AUTHORIZATION uts_rls_context_owner',
  ]);

  // ── SCENARIO 9: DB owner membership WITHOUT inherited privileges → must NOT authorize temp GRANT ─
  // (operator has MEMBER of DB owner role but is not the actual datdba → cannot issue GRANT ON DB)
  assert.throws(() => simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'ci_runner',
    databaseOwner: 'postgres',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner'], // NOT a member of postgres
    contextOwnerHasDbCreate: false,
  }), /Cannot grant temporary CREATE on database/);

  // ── SCENARIO 10: existing app_private already owned by uts_rls_context_owner → idempotent no-op ─
  const res10 = simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'uts_admin',
    databaseOwner: 'uts_admin',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner'],
    contextOwnerHasDbCreate: true,
    existingAppPrivateOwner: 'uts_rls_context_owner',
  });
  assert.deepEqual(res10.executedSql, []);

  // ── SCENARIO 11: existing app_private, operator IS the schema owner → may transfer ────────────
  const res11 = simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'legacy_admin',
    databaseOwner: 'postgres',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner'],
    contextOwnerHasDbCreate: true,
    existingAppPrivateOwner: 'legacy_admin', // operator IS the schema owner
    operatorInheritsSchemaOwner: false,
  });
  assert.deepEqual(res11.executedSql, [
    'ALTER SCHEMA app_private OWNER TO uts_rls_context_owner',
  ]);

  // ── SCENARIO 12: existing app_private, operator inherits schema owner via USAGE → may transfer ─
  const res12 = simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'deployer',
    databaseOwner: 'postgres',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner'],
    contextOwnerHasDbCreate: true,
    existingAppPrivateOwner: 'legacy_admin',
    operatorInheritsSchemaOwner: true, // pg_has_role(...,'USAGE') is true
  });
  assert.deepEqual(res12.executedSql, [
    'ALTER SCHEMA app_private OWNER TO uts_rls_context_owner',
  ]);

  // ── SCENARIO 12b: existing app_private, operator is DB owner only (no schema inheritance) → FAILS ─
  // DATABASE OWNERSHIP ALONE must not authorize schema ownership transfer.
  assert.throws(() => simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'db_owner',
    databaseOwner: 'db_owner',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner'],
    contextOwnerHasDbCreate: true,
    existingAppPrivateOwner: 'legacy_admin',
    operatorInheritsSchemaOwner: false, // DB owner but NOT schema owner / inheritor
  }), /Database ownership alone is not sufficient/);

  // ── SCENARIO 12c: bare MEMBER in schema owner role (NOINHERIT) → must NOT authorize transfer ──
  // Bare membership without inherited privileges (simulated by operatorInheritsSchemaOwner=false)
  assert.throws(() => simulateSchemaMigration({
    pgVersion: 150000,
    currentUser: 'deployer',
    databaseOwner: 'postgres',
    operatorHasDbCreate: true,
    operatorRoleMemberships: ['uts_rls_context_owner', 'legacy_admin'], // MEMBER but NOINHERIT
    contextOwnerHasDbCreate: true,
    existingAppPrivateOwner: 'legacy_admin',
    operatorInheritsSchemaOwner: false, // NOINHERIT: MEMBER present but USAGE is false
  }), /does not own schema app_private .* does not inherit its owner role privileges/);
});
