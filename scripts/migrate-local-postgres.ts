import { runPostgresMigrations } from '../server/database';

export async function migrateLocalPostgres(environment: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  if (environment.APP_ENV !== 'local-integration') throw new Error('LOCAL_INTEGRATION_ONLY');
  const databaseUrl = environment.DATABASE_MIGRATION_URL;
  if (!databaseUrl) throw new Error('DATABASE_MIGRATION_URL_REQUIRED');
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('LOOPBACK_POSTGRES_REQUIRED');
  }
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+_integration$/.test(databaseName)) throw new Error('DISPOSABLE_INTEGRATION_DATABASE_REQUIRED');
  return runPostgresMigrations(databaseUrl);
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/migrate-local-postgres.ts')) {
  void migrateLocalPostgres().then((applied) => {
    process.stdout.write(`Local PostgreSQL migrations applied: ${applied.length ? applied.join(', ') : 'none'}.\n`);
  }).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    process.stderr.write(`Local PostgreSQL migration failed: ${reason}\n`);
    process.exitCode = 1;
  });
}
