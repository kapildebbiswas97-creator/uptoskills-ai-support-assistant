import { Pool } from 'pg';
import { createSignedRlsContext } from '../server/rls-context';

export async function provisionLocalRlsKey(environment: NodeJS.ProcessEnv = process.env): Promise<{ database: string; keyId: string; ready: boolean }> {
  if (environment.APP_ENV !== 'local-integration') throw new Error('LOCAL_INTEGRATION_ONLY');
  const databaseUrl = environment.DATABASE_MIGRATION_URL;
  if (!databaseUrl) throw new Error('DATABASE_MIGRATION_URL_REQUIRED');
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('LOOPBACK_POSTGRES_REQUIRED');
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+_integration$/.test(database)) throw new Error('DISPOSABLE_INTEGRATION_DATABASE_REQUIRED');
  const readerUrl = environment.DATABASE_URL;
  if (!readerUrl) throw new Error('DATABASE_URL_READER_REQUIRED');
  const readerTarget = new URL(readerUrl);
  if (!['postgres:', 'postgresql:'].includes(readerTarget.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(readerTarget.hostname) ||
      decodeURIComponent(readerTarget.pathname.slice(1)) !== database || decodeURIComponent(readerTarget.username) !== 'uts_assistant_reader') {
    throw new Error('LOOPBACK_READER_FOR_SAME_INTEGRATION_DATABASE_REQUIRED');
  }
  const context = createSignedRlsContext('local-integration-preflight', false, environment);
  const secret = Buffer.from(environment.RLS_CONTEXT_HMAC_KEY!.trim(), 'base64url');
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 3000, query_timeout: 8000 });
  const readerPool = new Pool({ connectionString: readerUrl, max: 1, connectionTimeoutMillis: 3000, query_timeout: 8000 });

  try {
    const client = await pool.connect();
    try {
      const identity = await client.query<{ database: string }>('SELECT current_database() AS database');
      if (identity.rows[0]?.database !== database) throw new Error('DATABASE_IDENTITY_MISMATCH');
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE uts_rls_key_admin');
        const provisioned = await client.query(
          `INSERT INTO app_private.rls_context_keys (key_id, secret, enabled)
           VALUES ($1, $2, true)
           ON CONFLICT (key_id) DO UPDATE
             SET enabled = true
             WHERE app_private.rls_context_keys.secret = EXCLUDED.secret
           RETURNING key_id`,
          [context.keyId, secret]
        );
        if (provisioned.rowCount !== 1) throw new Error('KEY_ID_COLLISION_CHOOSE_A_NEW_ID');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
    const readiness = await readerPool.query<{ ready: boolean }>(
      "SELECT app_private.rls_context_ready($1, 'uts_assistant_reader') AS ready", [context.keyId]
    );
    if (readiness.rows[0]?.ready !== true) throw new Error('SECURE_RLS_MIGRATION_OR_ROLE_CONFIGURATION_REQUIRED');
    return { database, keyId: context.keyId, ready: true };
  } finally {
    await Promise.all([pool.end(), readerPool.end()]);
  }
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/provision-local-rls-key.ts')) {
  void provisionLocalRlsKey().then((result) => {
    process.stdout.write(`Local RLS key is ready for database ${result.database} (key ID ${result.keyId}).\n`);
  }).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    process.stderr.write(`Local RLS key provisioning failed: ${reason}\n`);
    process.exitCode = 1;
  });
}
