import { Pool } from 'pg';
import { getMongoDatabase, mongoConfigured } from './mongodb.js';
import { recordMetric } from './observability.js';

export type DependencyStatus = 'up' | 'down' | 'not_configured';

export interface DatabaseHealth {
  mongo: DependencyStatus;
  postgres: DependencyStatus;
  pgvector: boolean | null;
  latencyMs: { mongo?: number; postgres?: number };
}

export interface DatabaseHealthCheck {
  check(): Promise<DatabaseHealth>;
  close(): Promise<void>;
}

export type PostgresHealthProbe = () => Promise<{ healthy: boolean; pgvector: boolean }>;

export function deploymentRequiresReadiness(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NODE_ENV?.toLowerCase() === 'production' ||
    ['preview', 'production'].includes(environment.VERCEL_ENV?.toLowerCase() ?? '');
}

export function isApplicationHealthDegraded(
  databases: DatabaseHealth | undefined,
  modelAvailable: boolean,
  authenticationConfigured: boolean,
  environment: NodeJS.ProcessEnv = process.env,
  rateLimitBackend: 'redis' | 'memory' | 'none' = 'none'
): boolean {
  if (databases?.mongo === 'down' || databases?.postgres === 'down') return true;
  if (!deploymentRequiresReadiness(environment)) return false;
  return !databases || databases.mongo !== 'up' || databases.postgres !== 'up' ||
    !modelAvailable || !authenticationConfigured || rateLimitBackend !== 'redis';
}

export function createDatabaseHealthCheck(
  environment: NodeJS.ProcessEnv = process.env,
  mongoLoader: typeof getMongoDatabase = getMongoDatabase,
  postgresProbe?: PostgresHealthProbe
): DatabaseHealthCheck {
  const url = environment.DATABASE_URL;
  let pool: Pool | undefined;
  if (url && !postgresProbe) {
    try { pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2500, query_timeout: 3000, statement_timeout: 3000, application_name: 'uptoskills-health-check' }); } catch { /* Report unhealthy without failing application initialization. */ }
  }
  pool?.on('error', () => undefined);
  return {
    async check() {
      const result: DatabaseHealth = {
        mongo: mongoConfigured(environment) ? 'down' : 'not_configured',
        postgres: url ? 'down' : 'not_configured',
        pgvector: url ? false : null,
        latencyMs: {},
      };
      if (mongoConfigured(environment)) {
        const started = performance.now();
        try {
          await (await mongoLoader()).command({ ping: 1 }, { timeoutMS: 2500 });
          result.mongo = 'up';
        } catch {
          result.mongo = 'down';
        }
        result.latencyMs.mongo = Math.round(performance.now() - started);
        recordMetric('database_probe_duration_ms', result.latencyMs.mongo, { database: 'mongodb' }, 'histogram');
        recordMetric('database_probe_status_total', 1, { database: 'mongodb', status: result.mongo }, 'counter');
      }
      if (url && postgresProbe) {
        const started = performance.now();
        try {
          const probe = await postgresProbe();
          result.pgvector = probe.pgvector;
          result.postgres = probe.healthy && probe.pgvector ? 'up' : 'down';
        } catch {
          result.postgres = 'down';
          result.pgvector = false;
        }
        result.latencyMs.postgres = Math.round(performance.now() - started);
        recordMetric('database_probe_duration_ms', result.latencyMs.postgres, { database: 'postgresql', status: result.postgres }, 'histogram');
        recordMetric('database_probe_status_total', 1, { database: 'postgresql', status: result.postgres }, 'counter');
      } else if (pool) {
        const started = performance.now();
        try {
          const query = await pool.query<{ enabled: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS enabled");
          result.pgvector = query.rows[0]?.enabled === true;
          result.postgres = result.pgvector ? 'up' : 'down';
        } catch {
          result.postgres = 'down';
          result.pgvector = false;
        }
        result.latencyMs.postgres = Math.round(performance.now() - started);
        recordMetric('database_probe_duration_ms', result.latencyMs.postgres, { database: 'postgresql', status: result.postgres }, 'histogram');
        recordMetric('database_probe_status_total', 1, { database: 'postgresql', status: result.postgres }, 'counter');
      }
      return result;
    },
    close: async () => { if (pool) await pool.end(); },
  };
}
