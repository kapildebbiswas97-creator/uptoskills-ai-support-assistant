import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabaseHealthCheck, isApplicationHealthDegraded } from './health.js';
import { isAuthenticationConfigured, resolveAuthenticationConfig } from './auth.js';
import type { Db } from 'mongodb';

test('health check reports configured dependencies and pgvector status without leaking details', async () => {
  const fakeDb = { command: async () => ({ ok: 1 }) } as unknown as Db;
  const check = createDatabaseHealthCheck(
    { MONGODB_URI: 'mongodb://localhost/test', MONGODB_DATABASE: 'test', DATABASE_URL: 'postgres://user:secret@localhost/test' },
    async () => fakeDb,
    async () => ({ healthy: true, pgvector: true })
  );
  const result = await check.check();
  assert.equal(result.mongo, 'up');
  assert.equal(result.postgres, 'up');
  assert.equal(result.pgvector, true);
  assert.ok(result.latencyMs.mongo !== undefined);
  await check.close();
});

test('health check reports missing pgvector and failed Mongo as unhealthy', async () => {
  const check = createDatabaseHealthCheck(
    { MONGODB_URI: 'mongodb://localhost/test', MONGODB_DATABASE: 'test', DATABASE_URL: 'postgres://localhost/test' },
    async () => { throw new Error('secret-bearing database error'); },
    async () => ({ healthy: true, pgvector: false })
  );
  const result = await check.check();
  assert.equal(result.mongo, 'down');
  assert.equal(result.postgres, 'down');
  assert.equal(result.pgvector, false);
  await check.close();
});

test('production and Preview readiness reports missing required integrations as degraded', () => {
  const missing = { mongo: 'not_configured', postgres: 'not_configured', pgvector: null, latencyMs: {} } as const;
  assert.equal(isApplicationHealthDegraded(missing, false, false, { VERCEL_ENV: 'preview' }), true);
  assert.equal(isApplicationHealthDegraded(missing, false, false, { NODE_ENV: 'production' }), true);
  assert.equal(isApplicationHealthDegraded(missing, false, false, { NODE_ENV: 'test' }), false);
  const ready = { mongo: 'up', postgres: 'up', pgvector: true, latencyMs: {} } as const;
  assert.equal(isApplicationHealthDegraded(ready, true, true, { VERCEL_ENV: 'production' }), false);
});

test('authentication readiness and health share derived Supabase settings', () => {
  const environment = {
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://uptoskills-auth-test.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'public-test-key',
    AUTH_ROLE_MAPPING: JSON.stringify({ user: 'user', support_agent: 'support_agent' }),
  };
  const config = resolveAuthenticationConfig(environment);
  assert.equal(config?.issuer, 'https://uptoskills-auth-test.supabase.co/auth/v1');
  assert.equal(config?.audience, 'authenticated');
  assert.equal(config?.jwksUrl, 'https://uptoskills-auth-test.supabase.co/auth/v1/.well-known/jwks.json');
  assert.equal(isAuthenticationConfigured(environment), true);
  assert.equal(isAuthenticationConfigured({ ...environment, AUTH_ROLE_MAPPING: '{' }), false);
});
