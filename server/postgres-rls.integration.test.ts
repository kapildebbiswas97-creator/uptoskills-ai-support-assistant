import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { setSignedRlsContext } from './database';
import { createSignedRlsContext } from './rls-context';

interface LocalPostgresTargets {
  reader: string;
  writer: string;
  migration: string;
  database: string;
}

function localTargets(): LocalPostgresTargets | undefined {
  if (process.env.RUN_LOCAL_POSTGRES_RLS_TESTS !== 'true' || process.env.APP_ENV !== 'local-integration') return undefined;
  const reader = process.env.DATABASE_URL;
  const writer = process.env.DATABASE_INGEST_URL;
  const migration = process.env.DATABASE_MIGRATION_URL;
  if (!reader || !writer || !migration) throw new Error('Local RLS tests require separate reader, writer, and migration URLs.');
  const urls = [reader, writer, migration].map((value) => new URL(value));
  const hostIsLocal = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  if (urls.some((url) => !['postgres:', 'postgresql:'].includes(url.protocol) || !hostIsLocal(url.hostname))) {
    throw new Error('Local RLS tests only accept loopback PostgreSQL URLs.');
  }
  const databases = urls.map((url) => decodeURIComponent(url.pathname.slice(1)));
  if (new Set(databases).size !== 1 || !/^[a-z0-9_]+_integration$/.test(databases[0])) {
    throw new Error('Local RLS tests require one database whose name ends with _integration.');
  }
  if (new Set(urls.map((url) => decodeURIComponent(url.username))).size !== 3) {
    throw new Error('Local RLS tests require separate reader, writer, and migration database users.');
  }
  createSignedRlsContext('rls-preflight', false);
  return { reader, writer, migration, database: databases[0] };
}

const targets = localTargets();
const shouldSkip = !targets ? 'Requires explicit APP_ENV=local-integration and loopback *_integration PostgreSQL URLs.' : undefined;

test('local PostgreSQL signed RLS denies tampered and cross-tenant contexts', { skip: shouldSkip }, async (t) => {
  assert.ok(targets);
  const reader = new Pool({ connectionString: targets.reader, max: 1 });
  const writer = new Pool({ connectionString: targets.writer, max: 1 });
  const migration = new Pool({ connectionString: targets.migration, max: 1 });
  const suffix = randomUUID();
  const tenantA = `tenant-a-${suffix}`;
  const tenantB = `tenant-b-${suffix}`;
  const rows = [
    { id: `rls-a-${suffix}`, tenant: tenantA, content: 'tenant A fixture' },
    { id: `rls-b-${suffix}`, tenant: tenantB, content: 'tenant B fixture' },
    { id: `rls-null-${suffix}`, tenant: null, content: 'null tenant fixture' },
  ];
  const embedding = `[${Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0).join(',')}]`;
  const withContext = async <T>(pool: Pool, role: 'uts_assistant_reader' | 'uts_assistant_writer', tenantId: string | null, allowAll: boolean, run: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await setSignedRlsContext(client, tenantId, allowAll, role);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* Keep the test failure. */ }
      throw error;
    } finally {
      client.release();
    }
  };
  const selectIds = async (client: PoolClient, ids: string[]) => client.query<{ document_id: string }>(
    'SELECT document_id FROM knowledge.document_chunks WHERE document_id = ANY($1::text[]) ORDER BY document_id', [ids]
  );
  const applySignedContext = async (client: PoolClient, context: ReturnType<typeof createSignedRlsContext>) => client.query(
    `SELECT set_config('app.tenant_id', $1, true),
            set_config('app.allow_all_tenants', $2, true),
            set_config('app.rls_key_id', $3, true),
            set_config('app.rls_issued_at', $4, true),
            set_config('app.rls_nonce', $5, true),
            set_config('app.rls_signature', $6, true)`,
    [context.tenantId ?? '', String(context.allowAllTenants), context.keyId,
      String(context.issuedAt), context.nonce, context.signature]
  );
  const insertFixture = async (row: typeof rows[number]) => withContext(writer, 'uts_assistant_writer', row.tenant, false, async (client) => {
    await client.query(
      `INSERT INTO knowledge.document_chunks
       (chunk_id, document_id, tenant_id, owner_id, chunk_index, content, metadata, embedding, embedding_model, embedding_version)
       VALUES ($1, $2, $3, 'local-rls-test', 0, $4, '{}'::jsonb, $5::vector, 'local-test', 1)`,
      [`${row.id}:0`, row.id, row.tenant, row.content, embedding]
    );
  });

  try {
    const ready = await writer.query<{ ready: boolean }>(
      'SELECT app_private.rls_context_ready($1, $2) AS ready',
      [process.env.RLS_CONTEXT_KEY_ID, 'uts_assistant_writer']
    );
    assert.equal(ready.rows[0]?.ready, true, 'signed RLS migration and local key must be provisioned first');
    const wrongRuntimeRole = await reader.query<{ ready: boolean }>(
      "SELECT app_private.rls_context_ready($1, 'uts_assistant_writer') AS ready", [process.env.RLS_CONTEXT_KEY_ID]
    );
    assert.equal(wrongRuntimeRole.rows[0]?.ready, false, 'reader login cannot claim writer identity');
    const migrationRoleReady = await migration.query<{ ready: boolean }>(
      "SELECT app_private.rls_context_ready($1, 'uts_assistant_writer') AS ready", [process.env.RLS_CONTEXT_KEY_ID]
    );
    assert.equal(migrationRoleReady.rows[0]?.ready, false, 'migration login cannot be used as an application runtime role');
    for (const row of rows) await insertFixture(row);
    const ids = rows.map(({ id }) => id);

    await t.test('Tenant A reads its own rows and cannot read Tenant B or null-tenant rows', async () => {
      const visible = await withContext(reader, 'uts_assistant_reader', tenantA, false, (client) => selectIds(client, ids));
      assert.deepEqual(visible.rows.map(({ document_id }) => document_id), [rows[0].id]);
    });

    await t.test('Tenant A cannot write or delete Tenant B rows', async () => {
      await assert.rejects(() => withContext(writer, 'uts_assistant_writer', tenantA, false, async (client) => {
        await client.query(
          `INSERT INTO knowledge.document_chunks
           (chunk_id, document_id, tenant_id, owner_id, chunk_index, content, metadata, embedding, embedding_model, embedding_version)
           VALUES ($1, $2, $3, 'local-rls-test', 0, 'forbidden', '{}'::jsonb, $4::vector, 'local-test', 1)`,
          [`forbidden-${suffix}`, `forbidden-${suffix}`, tenantB, embedding]
        );
      }), (error: unknown) => (error as { code?: string }).code === '42501');
      const updated = await withContext(writer, 'uts_assistant_writer', tenantA, false, (client) => client.query(
        "UPDATE knowledge.document_chunks SET content = 'forbidden update' WHERE document_id = $1 RETURNING document_id", [rows[1].id]
      ));
      assert.equal(updated.rowCount, 0);
      const deleted = await withContext(writer, 'uts_assistant_writer', tenantA, false, (client) => client.query(
        'DELETE FROM knowledge.document_chunks WHERE document_id = $1 RETURNING document_id', [rows[1].id]
      ));
      assert.equal(deleted.rowCount, 0);
      const stillThere = await withContext(reader, 'uts_assistant_reader', tenantB, false, (client) => selectIds(client, [rows[1].id]));
      assert.equal(stillThere.rowCount, 1);
    });

    await t.test('missing and malformed tenant contexts deny reads', async () => {
      const noContextClient = await reader.connect();
      try {
        await noContextClient.query('BEGIN');
        const missing = await selectIds(noContextClient, ids);
        assert.equal(missing.rowCount, 0);
        await noContextClient.query('ROLLBACK');
        await noContextClient.query('BEGIN');
        await noContextClient.query(
          `SELECT set_config('app.tenant_id', $1, true),
                  set_config('app.allow_all_tenants', 'true', true),
                  set_config('app.rls_key_id', $2, true),
                  set_config('app.rls_issued_at', 'malformed', true),
                  set_config('app.rls_nonce', 'bad', true),
                  set_config('app.rls_signature', repeat('0', 64), true)`,
          [tenantB, process.env.RLS_CONTEXT_KEY_ID]
        );
        assert.equal((await selectIds(noContextClient, ids)).rowCount, 0);
        await noContextClient.query('ROLLBACK');
      } finally {
        noContextClient.release();
      }
    });

    await t.test('invalid signatures and expired signed contexts deny reads', async () => {
      const client = await reader.connect();
      try {
        await client.query('BEGIN');
        const invalid = createSignedRlsContext(tenantA, false);
        await applySignedContext(client, { ...invalid, signature: `${invalid.signature.slice(0, -1)}${invalid.signature.endsWith('0') ? '1' : '0'}` });
        assert.equal((await selectIds(client, [rows[0].id])).rowCount, 0, 'altered signature must fail closed');
        await client.query('ROLLBACK');

        await client.query('BEGIN');
        const expired = createSignedRlsContext(tenantA, false, process.env, Date.now() - 10 * 60 * 1000);
        await applySignedContext(client, expired);
        assert.equal((await selectIds(client, [rows[0].id])).rowCount, 0, 'expired signature must fail closed');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    await t.test('a replayed signed context in another session cannot broaden its tenant scope', async () => {
      const replayed = createSignedRlsContext(tenantA, false);
      const client = await reader.connect();
      try {
        await client.query('BEGIN');
        await applySignedContext(client, replayed);
        const visible = await selectIds(client, ids);
        assert.deepEqual(visible.rows.map(({ document_id }) => document_id), [rows[0].id]);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    await t.test('changing tenant or global-access GUCs without a new signature is denied', async () => {
      const client = await reader.connect();
      try {
        await client.query('BEGIN');
        const signed = createSignedRlsContext(tenantA, false);
        await setSignedRlsContext(client, tenantA, false, 'uts_assistant_reader');
        await client.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.allow_all_tenants', 'true', true)", [tenantB]);
        assert.equal((await selectIds(client, [rows[0].id])).rowCount, 0, 'changing both GUCs invalidates the original signature');
        assert.equal((await selectIds(client, [rows[1].id])).rowCount, 0);
        await client.query('ROLLBACK');
        assert.match(signed.signature, /^[0-9a-f]{64}$/);
      } finally {
        client.release();
      }
    });

    await t.test('pooled connections do not retain a prior tenant after commit or rollback', async () => {
      const client = await writer.connect();
      try {
        await client.query('BEGIN');
        await setSignedRlsContext(client, tenantA, false, 'uts_assistant_writer');
        assert.equal((await selectIds(client, [rows[0].id])).rowCount, 1);
        await client.query('COMMIT');
        await client.query('BEGIN');
        assert.equal((await selectIds(client, ids)).rowCount, 0);
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        await setSignedRlsContext(client, tenantB, false, 'uts_assistant_writer');
        assert.equal((await selectIds(client, [rows[1].id])).rowCount, 1);
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        assert.equal((await selectIds(client, ids)).rowCount, 0);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    await t.test('application roles cannot read signing keys, assume the context-owner role, or bypass forced RLS', async () => {
      const result = await reader.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
        'SELECT rolname, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user'
      );
      assert.equal(result.rows[0]?.rolsuper, false);
      assert.equal(result.rows[0]?.rolbypassrls, false);
      assert.equal(result.rows[0]?.rolcreaterole, false);
      const privilegeMembership = await reader.query<{ privileged: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_roles AS role
           WHERE (role.rolsuper OR role.rolbypassrls OR role.rolcreaterole
             OR role.rolname IN ('uts_rls_context_owner', 'uts_rls_key_admin'))
             AND pg_has_role(current_user, role.oid, 'MEMBER')
         ) AS privileged`
      );
      assert.equal(privilegeMembership.rows[0]?.privileged, false);
      await assert.rejects(() => reader.query('SELECT secret FROM app_private.rls_context_keys'), (error: unknown) => (error as { code?: string }).code === '42501');
      await assert.rejects(() => reader.query('SET ROLE uts_rls_context_owner'), (error: unknown) => (error as { code?: string }).code === '42501');
      await assert.rejects(() => reader.query('SET ROLE uts_rls_key_admin'), (error: unknown) => (error as { code?: string }).code === '42501');
      await assert.rejects(() => reader.query("SELECT app_private.hmac('payload'::bytea, 'key'::bytea, 'sha256')"), (error: unknown) => (error as { code?: string }).code === '42501');
      await assert.rejects(() => reader.query(
        `INSERT INTO knowledge.document_chunks
         (chunk_id, document_id, tenant_id, owner_id, chunk_index, content, metadata, embedding, embedding_model, embedding_version)
         VALUES ($1, $2, $3, 'local-rls-test', 0, 'reader cannot write', '{}'::jsonb, $4::vector, 'local-test', 1)`,
        [`reader-write-${suffix}`, `reader-write-${suffix}`, tenantA, embedding]
      ), (error: unknown) => (error as { code?: string }).code === '42501');
      const switched = await reader.connect();
      try {
        await switched.query('BEGIN');
        await switched.query('SET LOCAL row_security = off');
        await assert.rejects(() => selectIds(switched, [rows[1].id]));
        await switched.query('ROLLBACK');
      } finally {
        switched.release();
      }
    });

    await t.test('signed global access is separate from superuser/BYPASSRLS and forced-owner behavior', async () => {
      const allRows = await withContext(reader, 'uts_assistant_reader', null, true, (client) => selectIds(client, ids));
      assert.equal(allRows.rowCount, 3);
      const appUsers = await Promise.all([
        reader.query<{ session_user: string }>('SELECT session_user'),
        writer.query<{ session_user: string }>('SELECT session_user'),
        migration.query<{ session_user: string }>('SELECT session_user'),
      ]);
      const names = appUsers.map(({ rows }) => rows[0]?.session_user);
      assert.notEqual(names[2], names[0]);
      assert.notEqual(names[2], names[1]);
      const table = await migration.query<{ relforcerowsecurity: boolean; owner: string; is_superuser: boolean; bypass_rls: boolean }>(
        `SELECT relation.relforcerowsecurity, pg_get_userbyid(relation.relowner) AS owner,
                role.rolsuper AS is_superuser, role.rolbypassrls AS bypass_rls
         FROM pg_class AS relation
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         JOIN pg_roles AS role ON role.rolname = session_user
         WHERE namespace.nspname = 'knowledge' AND relation.relname = 'document_chunks'`
      );
      assert.equal(table.rows[0]?.relforcerowsecurity, true);
      assert.ok(!names.slice(0, 2).includes(table.rows[0]?.owner));
      let migrationVisible: string[] | undefined;
      try {
        const result = await migration.query<{ document_id: string }>(
          'SELECT document_id FROM knowledge.document_chunks WHERE document_id = ANY($1::text[]) ORDER BY document_id', [ids]
        );
        migrationVisible = result.rows.map(({ document_id }) => document_id);
      } catch (error) {
        assert.equal((error as { code?: string }).code, '42501', 'a non-privileged migration login without SELECT must be denied');
      }
      if (table.rows[0]?.is_superuser || table.rows[0]?.bypass_rls) {
        assert.deepEqual(migrationVisible, [...ids].sort(), 'superuser/BYPASSRLS logins bypass row policies as documented');
      } else if (migrationVisible) {
        assert.deepEqual(migrationVisible, [], 'a non-BYPASSRLS table owner remains subject to forced RLS; migration role has no signed reader claim');
      }
    });
  } finally {
    try {
      await withContext(writer, 'uts_assistant_writer', null, true, async (client) => {
        await client.query('DELETE FROM knowledge.document_chunks WHERE document_id = ANY($1::text[])', [rows.map(({ id }) => id)]);
      });
    } finally {
      await Promise.all([reader.end(), writer.end(), migration.end()]);
    }
  }
});
