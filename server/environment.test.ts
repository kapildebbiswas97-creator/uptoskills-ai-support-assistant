import assert from 'node:assert/strict';
import test from 'node:test';
import { isStagingRuntime, requiresAuthenticatedChat, validateEnvironment } from './environment';

test('anonymous chat defaults off for staging and preview but preserves existing non-staging behavior', () => {
  assert.equal(isStagingRuntime({ APP_ENV: 'staging' }), true);
  assert.equal(isStagingRuntime({ NODE_ENV: 'staging' }), true);
  assert.equal(isStagingRuntime({ VERCEL_ENV: 'preview' }), true);
  assert.equal(requiresAuthenticatedChat({ VERCEL_ENV: 'preview' }), true);
  assert.equal(requiresAuthenticatedChat({ NODE_ENV: 'production', VERCEL_ENV: 'production' }), true);
  assert.equal(requiresAuthenticatedChat({ NODE_ENV: 'production', ALLOW_ANONYMOUS_CHAT: 'true' }), true);
  assert.equal(requiresAuthenticatedChat({ NODE_ENV: 'development' }), false);
  assert.equal(requiresAuthenticatedChat({ VERCEL_ENV: 'preview', ALLOW_ANONYMOUS_CHAT: 'true' }), true);
  assert.equal(requiresAuthenticatedChat({ VERCEL_ENV: 'preview', ALLOW_ANONYMOUS_CHAT: 'true', ANONYMOUS_CHAT_APPROVED: 'true' }), false);
  assert.equal(requiresAuthenticatedChat({ ALLOW_ANONYMOUS_CHAT: 'false' }), true);
});

test('environment validation reports missing staging dependencies without printing values', () => {
  const result = validateEnvironment({ NODE_ENV: 'staging' }, true);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes('MONGODB_URI')));
  assert.ok(result.issues.some((issue) => issue.includes('MALWARE_SCANNER_URL')));
  assert.doesNotMatch(result.issues.join('\n'), /secret|password value/i);
});

test('environment validation accepts isolated staging configuration with explicit role mapping', () => {
  const result = validateEnvironment({
    NODE_ENV: 'staging',
    MONGODB_URI: 'mongodb+srv://test.example/uptoskills',
    MONGODB_DATABASE: 'uptoskills_staging',
    AUTH_ISSUER: 'https://identity.staging.example/',
    AUTH_AUDIENCE: 'uptoskills-staging',
    AUTH_ROLE_MAPPING: '{"group:admins":"admin","group:staff":"support_agent"}',
    DATABASE_URL: 'postgresql://uts_assistant_reader:placeholder@db.example/uptoskills?sslmode=require',
    DATABASE_INGEST_URL: 'postgresql://uts_assistant_writer:placeholder@db.example/uptoskills?sslmode=require',
    RLS_CONTEXT_KEY_ID: 'staging-2026-01',
    RLS_CONTEXT_HMAC_KEY: Buffer.alloc(32, 9).toString('base64url'),
    GEMINI_API_KEY: 'configured-value-not-inspected',
    OPENROUTER_API_KEY: 'configured-value-not-inspected',
    MALWARE_SCANNER_URL: 'https://scan.staging.example/v1/scan',
    MALWARE_SCANNER_TOKEN: 'configured-value-not-inspected',
  }, true);
  assert.deepEqual(result, { valid: true, issues: [] });
});

test('environment validation rejects invalid claim mappings, non-TLS production URLs, and incompatible vector dimensions', () => {
  const result = validateEnvironment({
    NODE_ENV: 'staging',
    AUTH_ISSUER: 'http://identity.example/',
    AUTH_AUDIENCE: 'support',
    AUTH_ROLE_MAPPING: '{"root":"owner"}',
    MALWARE_SCANNER_URL: 'http://scanner.example/scan',
    MALWARE_SCANNER_TOKEN: 'configured-value-not-inspected',
    DATABASE_URL: 'postgresql://reader:placeholder@db.example/app',
    EMBEDDING_DIMENSIONS: '1536',
  });
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.includes('AUTH_ISSUER')));
  assert.ok(result.issues.some((issue) => issue.includes('AUTH_ROLE_MAPPING')));
  assert.ok(result.issues.some((issue) => issue.includes('DATABASE_URL')));
  assert.ok(result.issues.some((issue) => issue.includes('EMBEDDING_DIMENSIONS')));
});

test('staging validation rejects anonymous chat and invalid override values', () => {
  const invalidOverride = validateEnvironment({ ALLOW_ANONYMOUS_CHAT: 'sometimes' });
  assert.ok(invalidOverride.issues.some((issue) => issue.includes('ALLOW_ANONYMOUS_CHAT')));
  const anonymousStaging = validateEnvironment({ ALLOW_ANONYMOUS_CHAT: 'true' }, true);
  assert.ok(anonymousStaging.issues.some((issue) => issue.includes('ANONYMOUS_CHAT_APPROVED')));
});

test('PostgreSQL runtime configuration requires a canonical 32-byte signed RLS context key', () => {
  const missing = validateEnvironment({ DATABASE_URL: 'postgresql://reader:placeholder@db.example/app' });
  assert.ok(missing.issues.some((issue) => issue.includes('RLS_CONTEXT_KEY_ID')));
  assert.ok(missing.issues.some((issue) => issue.includes('RLS_CONTEXT_HMAC_KEY')));
  const invalidKey = validateEnvironment({
    DATABASE_URL: 'postgresql://reader:placeholder@db.example/app',
    RLS_CONTEXT_KEY_ID: 'bad key',
    RLS_CONTEXT_HMAC_KEY: 'not-a-key',
  });
  assert.ok(invalidKey.issues.some((issue) => issue.includes('RLS_CONTEXT_KEY_ID')));
  assert.ok(invalidKey.issues.some((issue) => issue.includes('32 random bytes')));
  const wrongRoles = validateEnvironment({
    DATABASE_URL: 'postgresql://postgres:placeholder@127.0.0.1/app',
    DATABASE_INGEST_URL: 'postgresql://uts_assistant_reader:placeholder@127.0.0.1/app',
  });
  assert.ok(wrongRoles.issues.some((issue) => issue.includes('DATABASE_URL must authenticate as')));
  assert.ok(wrongRoles.issues.some((issue) => issue.includes('DATABASE_INGEST_URL must authenticate as')));
});
