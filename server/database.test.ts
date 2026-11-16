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
