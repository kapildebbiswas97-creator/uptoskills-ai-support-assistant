import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Request } from 'express';
import { authenticateRequest, isTemporaryJwksFailure, requirePrincipal, requireRole, verifyAccessToken } from './auth';
import { conversationScope } from './mongodb';

const issuer = 'https://identity.example.test/';
const audience = 'uptoskills-support';
const keys = await generateKeyPair('RS256');
const jwk = await exportJWK(keys.publicKey);
const resolver = createLocalJWKSet({ keys: [{ ...jwk, kid: 'local-test-key', alg: 'RS256', use: 'sig' }] });

async function token(options: { issuer?: string; audience?: string; iat?: number; exp?: number; nbf?: number; roles?: string[]; tenant?: string; signingKey?: CryptoKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ roles: options.roles ?? ['user'], org_id: options.tenant ?? 'tenant-a' })
    .setProtectedHeader({ alg: 'RS256', kid: 'local-test-key' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setSubject('subject-1')
    .setIssuedAt(options.iat ?? now)
    .setExpirationTime(options.exp ?? now + 3600);
  if (options.nbf !== undefined) jwt.setNotBefore(options.nbf);
  return jwt.sign(options.signingKey ?? keys.privateKey);
}

const settings = { issuer, audience, rolesClaim: 'roles', tenantClaim: 'org_id', roleMapping: { user: 'user', admin: 'admin', knowledge_manager: 'knowledge_manager' } as const };

test('missing bearer token is anonymous and has no inferred principal', async () => {
  const request = { header: () => undefined } as unknown as Request;
  assert.equal(await authenticateRequest(request), undefined);
});

test('protected operations reject missing authentication when OIDC is configured', () => {
  const keys = ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL', 'AUTH_ROLE_MAPPING'] as const;
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.AUTH_ISSUER = issuer;
  process.env.AUTH_AUDIENCE = audience;
  process.env.AUTH_JWKS_URL = 'https://identity.example.test/keys';
  process.env.AUTH_ROLE_MAPPING = '{"user":"user"}';
  let status = 0;
  const response = {
    status(value: number) { status = value; return this; },
    json() { return this; },
  } as never;
  try {
    assert.equal(requirePrincipal({} as never, response), undefined);
    assert.equal(status, 401);
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
});

test('protected operations return 401 for missing authentication when OIDC is not configured', () => {
  const keys = ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL', 'AUTH_ROLE_MAPPING'] as const;
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  let status = 0;
  const response = {
    status(value: number) { status = value; return this; },
    json() { return this; },
  } as never;
  try {
    assert.equal(requirePrincipal({} as never, response), undefined);
    assert.equal(status, 401);
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
});

test('valid signed token maps only recognized roles and trusted tenant claims', async () => {
  const claims = await verifyAccessToken(await token({ roles: ['knowledge_manager', 'root', 'user'] }), settings, resolver);
  assert.deepEqual(claims, { subject: 'subject-1', roles: ['knowledge_manager', 'user'], tenantId: 'tenant-a', emailVerified: false });
});

test('expired, not-yet-valid, wrong-audience, wrong-issuer, invalid-signature, and malformed tokens are rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const alternateKeys = await generateKeyPair('RS256');
  await assert.rejects(() => verifyAccessToken('not-a-jwt', settings, resolver));
  await assert.rejects(async () => verifyAccessToken(await token({ iat: now - 7200, exp: now - 1 }), settings, resolver));
  await assert.rejects(async () => verifyAccessToken(await token({ nbf: now + 60 }), settings, resolver));
  await assert.rejects(async () => verifyAccessToken(await token({ audience: 'other-app' }), settings, resolver));
  await assert.rejects(async () => verifyAccessToken(await token({ issuer: 'https://attacker.example/' }), settings, resolver));
  await assert.rejects(async () => verifyAccessToken(await token({ signingKey: alternateKeys.privateKey }), settings, resolver));
});

test('external role names map only through the configured trusted role mapping', async () => {
  const mapped = await verifyAccessToken(await token({ roles: ['corp_knowledge', 'corp_root'] }), {
    ...settings,
    roleMapping: { corp_knowledge: 'knowledge_manager' },
  }, resolver);
  assert.deepEqual(mapped.roles, ['knowledge_manager']);
});

test('JWKS timeouts and fetch failures are distinguishable from invalid-token errors', () => {
  assert.equal(isTemporaryJwksFailure(Object.assign(new Error('timeout'), { code: 'ERR_JWKS_TIMEOUT' })), true);
  assert.equal(isTemporaryJwksFailure(Object.assign(new Error('bad JWKS response'), { code: 'ERR_JOSE_GENERIC' })), true);
  assert.equal(isTemporaryJwksFailure(Object.assign(new Error('bad signature'), { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' })), false);
});

test('role enforcement grants only the requested role or administrator roles', () => {
  const base = { subject: 'subject-1', tenantId: 'tenant-a' };
  assert.equal(requireRole({ ...base, roles: ['knowledge_manager'] }, ['knowledge_manager']), true);
  assert.equal(requireRole({ ...base, roles: ['admin'] }, ['knowledge_manager']), true);
  assert.equal(requireRole({ ...base, roles: ['user'] }, ['knowledge_manager']), false);
});

test('conversation queries remain scoped to the authenticated owner and tenant, including for admins', () => {
  const one = conversationScope({ subject: 'u1', tenantId: 'tenant-a', roles: ['admin'] }, 'c1');
  const other = conversationScope({ subject: 'u2', tenantId: 'tenant-a', roles: ['admin'] }, 'c1');
  const otherTenant = conversationScope({ subject: 'u1', tenantId: 'tenant-b', roles: ['super_admin'] }, 'c1');
  assert.deepEqual(one, { _id: 'c1', ownerId: 'u1', tenantId: 'tenant-a' });
  assert.notDeepEqual(one, other);
  assert.notDeepEqual(one, otherTenant);
});
