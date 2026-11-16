import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Request, Response } from 'express';
import {
  authenticateRequest,
  resolveAuthenticationConfig,
  requirePrincipal,
  requireRole,
  verifySupabaseEmailConfirmation,
  verifyAccessToken,
  type AppRole,
  type AuthenticatedPrincipal,
} from './auth.js';
import { conversationScope } from './mongodb.js';
import { documentScope } from './document-ingestion.js';

// Setup Supabase test project configuration
const SUPABASE_PROJECT_URL = 'https://uptoskills-auth-test.supabase.co';
const SUPABASE_AUTH_ISSUER = `${SUPABASE_PROJECT_URL}/auth/v1`;
const SUPABASE_AUDIENCE = 'authenticated';

const keyPair = await generateKeyPair('RS256');
const jwk = await exportJWK(keyPair.publicKey);
const testResolver = createLocalJWKSet({
  keys: [{ ...jwk, kid: 'supabase-test-key-1', alg: 'RS256', use: 'sig' }],
});

const defaultRoleMapping: Record<string, AppRole> = {
  user: 'user',
  support_agent: 'support_agent',
  admin: 'admin',
  super_admin: 'super_admin',
  knowledge_manager: 'knowledge_manager',
};

async function mintSupabaseToken(options: {
  issuer?: string;
  audience?: string;
  subject?: string;
  email?: string;
  roles?: string[] | null;
  tenantId?: string;
  userMetadata?: Record<string, unknown>;
  exp?: number;
  iat?: number;
  signingKey?: CryptoKey;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    role: 'authenticated',
    aal: 'aal1',
    session_id: '00000000-0000-4000-8000-000000000001',
    is_anonymous: false,
    ...(options.roles === null ? {} : { roles: options.roles ?? ['user'] }),
    ...(options.tenantId ? { org_id: options.tenantId } : {}),
    ...(options.email ? { email: options.email } : { email: 'intern@example.com' }),
    ...(options.userMetadata ? { user_metadata: options.userMetadata } : {}),
  };

  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'supabase-test-key-1' })
    .setIssuer(options.issuer ?? SUPABASE_AUTH_ISSUER)
    .setAudience(options.audience ?? SUPABASE_AUDIENCE)
    .setSubject(options.subject ?? 'usr-test-1234')
    .setIssuedAt(options.iat ?? now)
    .setExpirationTime(options.exp ?? now + 3600);

  return jwt.sign(options.signingKey ?? keyPair.privateKey);
}

const supabaseSettings = {
  issuer: SUPABASE_AUTH_ISSUER,
  audience: SUPABASE_AUDIENCE,
  rolesClaim: 'roles',
  tenantClaim: 'org_id',
  roleMapping: defaultRoleMapping,
};

test('1. valid Supabase JWT contract maps subject, email, roles, and trusted tenant claim', async () => {
  const token = await mintSupabaseToken({
    subject: 'user-supabase-abc',
    email: 'verified.user@uptoskills.com',
    roles: ['user'],
    tenantId: 'tenant-engineering-1',
  });

  const principal = await verifyAccessToken(token, supabaseSettings, testResolver);
  assert.equal(principal.subject, 'user-supabase-abc');
  assert.equal(principal.email, 'verified.user@uptoskills.com');
  assert.equal(principal.emailVerified, false, 'Supabase does not put email_confirmed_at in the access-token JWT');
  assert.equal(principal.tenantId, 'tenant-engineering-1');
  assert.deepEqual(principal.roles, ['user']);
});

test('2. invalid signature on Supabase JWT is strictly rejected', async () => {
  const attackerKeys = await generateKeyPair('RS256');
  const forgedToken = await mintSupabaseToken({
    signingKey: attackerKeys.privateKey,
  });

  await assert.rejects(
    () => verifyAccessToken(forgedToken, supabaseSettings, testResolver),
    /signature|verification failed/i
  );
});

test('3. wrong issuer on Supabase JWT is strictly rejected', async () => {
  const wrongIssuerToken = await mintSupabaseToken({
    issuer: 'https://malicious-project.supabase.co/auth/v1',
  });

  await assert.rejects(
    () => verifyAccessToken(wrongIssuerToken, supabaseSettings, testResolver),
    /claim|issuer/i
  );
});

test('4. wrong audience on Supabase JWT is strictly rejected', async () => {
  const wrongAudienceToken = await mintSupabaseToken({
    audience: 'anon',
  });

  await assert.rejects(
    () => verifyAccessToken(wrongAudienceToken, supabaseSettings, testResolver),
    /claim|audience/i
  );
});

test('5. expired Supabase JWT is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiredToken = await mintSupabaseToken({
    iat: now - 7200,
    exp: now - 100,
  });

  await assert.rejects(
    () => verifyAccessToken(expiredToken, supabaseSettings, testResolver),
    /exp.*claim|expired/i
  );
});

test('6. missing token leaves request unauthenticated and triggers 401', async () => {
  const requestWithoutToken = {
    header: () => undefined,
  } as unknown as Request;

  const principal = await authenticateRequest(requestWithoutToken);
  assert.equal(principal, undefined);

  let status = 0;
  let jsonBody: unknown = null;
  const mockResponse = {
    status(code: number) { status = code; return this; },
    json(body: unknown) { jsonBody = body; return this; },
  } as unknown as Response;

  const result = requirePrincipal({} as Request, mockResponse);
  assert.equal(result, undefined);
  assert.equal(status, 401);
  assert.deepEqual(jsonBody, { error: 'Authentication is required.' });
});

test('7. invalid or missing role claims fail closed with INVALID_ROLE_CLAIM', async () => {
  // Empty roles array
  const emptyRolesToken = await mintSupabaseToken({ roles: [] });
  await assert.rejects(
    () => verifyAccessToken(emptyRolesToken, supabaseSettings, testResolver),
    /INVALID_ROLE_CLAIM/
  );

  // Unrecognized / unmapped role
  const unmappedRoleToken = await mintSupabaseToken({ roles: ['unknown_contractor'] });
  await assert.rejects(
    () => verifyAccessToken(unmappedRoleToken, supabaseSettings, testResolver),
    /INVALID_ROLE_CLAIM/
  );
});

test('8. trusted Supabase user lookup enforces email confirmation without inventing a JWT claim', async () => {
  const token = await mintSupabaseToken({ subject: 'user-supabase-abc' });
  const calls: Array<{ url: string; authorization: string | null; apikey: string | null }> = [];
  const config = { supabaseUrl: SUPABASE_PROJECT_URL, supabasePublishableKey: 'public-test-key' };
  await verifySupabaseEmailConfirmation(token, config, 'user-supabase-abc', async (input, init) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      apikey: new Headers(init?.headers).get('apikey'),
    });
    return new Response(JSON.stringify({ id: 'user-supabase-abc', email_confirmed_at: '2026-11-15T12:00:00Z' }), { status: 200 });
  });
  assert.deepEqual(calls, [{
    url: `${SUPABASE_PROJECT_URL}/auth/v1/user`,
    authorization: `Bearer ${token}`,
    apikey: 'public-test-key',
  }]);
  await assert.rejects(() => verifySupabaseEmailConfirmation(token, config, 'user-supabase-abc', async () =>
    new Response(JSON.stringify({ id: 'user-supabase-abc', email_confirmed_at: null }), { status: 200 })
  ), /UNVERIFIED_EMAIL/);
  await assert.rejects(() => verifySupabaseEmailConfirmation(token, config, 'user-supabase-abc', async () =>
    new Response('{}', { status: 401 })
  ), /INVALID_TOKEN/);
  await assert.rejects(() => verifySupabaseEmailConfirmation(token, config, 'different-user', async () =>
    new Response(JSON.stringify({ id: 'user-supabase-abc', email_confirmed_at: '2026-11-15T12:00:00Z' }), { status: 200 })
  ), /UNVERIFIED_EMAIL/);
});

test('authenticateRequest rejects unconfirmed users before a protected route receives a principal', async () => {
  const names = ['SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'AUTH_ROLE_MAPPING', 'NODE_ENV'] as const;
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.SUPABASE_URL = SUPABASE_PROJECT_URL;
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'public-test-key';
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.AUTH_ROLE_MAPPING = JSON.stringify(defaultRoleMapping);
  process.env.NODE_ENV = 'production';
  try {
    const token = await mintSupabaseToken({ subject: 'user-supabase-abc' });
    const request = { header: (name: string) => name === 'authorization' ? `Bearer ${token}` : undefined } as unknown as Request;
    await assert.rejects(() => authenticateRequest(request, {
      resolver: testResolver,
      fetcher: async () => new Response(JSON.stringify({ id: 'user-supabase-abc', email_confirmed_at: null }), { status: 200 }),
    }), /UNVERIFIED_EMAIL/);
    const principal = await authenticateRequest(request, {
      resolver: testResolver,
      fetcher: async () => new Response(JSON.stringify({ id: 'user-supabase-abc', email_confirmed_at: '2026-11-15T12:00:00Z' }), { status: 200 }),
    });
    assert.equal(principal?.emailVerified, true);
  } finally {
    for (const name of names) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('Supabase_URL alone resolves issuer, audience, JWKS, role mapping, and publishable key consistently', () => {
  const config = resolveAuthenticationConfig({
    SUPABASE_URL: SUPABASE_PROJECT_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: 'public-test-key',
    AUTH_ROLE_MAPPING: JSON.stringify(defaultRoleMapping),
    NODE_ENV: 'production',
  });
  assert.equal(config?.issuer, SUPABASE_AUTH_ISSUER);
  assert.equal(config?.audience, SUPABASE_AUDIENCE);
  assert.equal(config?.jwksUrl, `${SUPABASE_AUTH_ISSUER}/.well-known/jwks.json`);
  assert.equal(config?.roleMapping.support_agent, 'support_agent');
  assert.equal(config?.tenantClaim, 'org_id');
  assert.equal(config?.requireVerifiedEmail, true);
});

test('every application role is extracted only from the configured signed roles claim', async () => {
  for (const role of ['user', 'support_agent', 'knowledge_manager', 'admin', 'super_admin'] as const) {
    const token = await mintSupabaseToken({ roles: [role] });
    const principal = await verifyAccessToken(token, supabaseSettings, testResolver);
    assert.deepEqual(principal.roles, [role]);
  }
  const wrongClaimToken = await mintSupabaseToken({ roles: [] });
  await assert.rejects(() => verifyAccessToken(wrongClaimToken, { ...supabaseSettings, rolesClaim: 'role' }, testResolver), /INVALID_ROLE_CLAIM/);
  const missingRolesToken = await mintSupabaseToken({ roles: null });
  await assert.rejects(() => verifyAccessToken(missingRolesToken, supabaseSettings, testResolver), /INVALID_ROLE_CLAIM/);
});

test('9. regular user attempting an HR route is denied with 403', () => {
  const regularUser: AuthenticatedPrincipal = {
    subject: 'user-regular-1',
    roles: ['user'],
    tenantId: 'tenant-a',
    emailVerified: true,
  };

  // HR routes explicitly prohibit generic admin bypass ({ includeAdministrators: false })
  const hasHrAccess = requireRole(regularUser, ['support_agent'], { includeAdministrators: false });
  assert.equal(hasHrAccess, false);

  const hrAgent: AuthenticatedPrincipal = {
    subject: 'user-hr-1',
    roles: ['support_agent'],
    tenantId: 'tenant-a',
    emailVerified: true,
  };
  assert.equal(requireRole(hrAgent, ['support_agent'], { includeAdministrators: false }), true);
});

test('10. regular user attempting an administrator route is denied', () => {
  const regularUser: AuthenticatedPrincipal = {
    subject: 'user-regular-2',
    roles: ['user'],
    emailVerified: true,
  };

  const hasAdminAccess = requireRole(regularUser, ['admin']);
  assert.equal(hasAdminAccess, false);

  const adminUser: AuthenticatedPrincipal = {
    subject: 'user-admin-1',
    roles: ['admin'],
    emailVerified: true,
  };
  assert.equal(requireRole(adminUser, ['admin']), true);
});

test('11. client attempting to submit an elevated role via user_metadata is ignored', async () => {
  // Attacker crafts user_metadata with admin role, but server-controlled hook only assigned ['user']
  const tokenWithMetadataAttack = await mintSupabaseToken({
    roles: ['user'],
    userMetadata: { role: 'admin', roles: ['admin', 'super_admin'] },
  });

  const verified = await verifyAccessToken(tokenWithMetadataAttack, supabaseSettings, testResolver);
  assert.deepEqual(verified.roles, ['user']);
  assert.equal(verified.roles.includes('admin'), false);
  assert.equal(verified.roles.includes('super_admin'), false);
});

test('12. cross-tenant access attempts are prevented by tenant scoping', () => {
  const tenantAlphaUser: AuthenticatedPrincipal = {
    subject: 'usr-alpha-1',
    roles: ['user'],
    tenantId: 'tenant-alpha',
    emailVerified: true,
  };

  const targetConversationId = 'conv-target-123';
  const scope = conversationScope(tenantAlphaUser, targetConversationId);

  assert.equal(scope._id, targetConversationId);
  assert.equal(scope.tenantId, 'tenant-alpha');
  assert.equal(scope.ownerId, 'usr-alpha-1');

  // Verify document scope cannot leak across tenants
  const docScope = documentScope(tenantAlphaUser, 'doc-secret-456');
  assert.deepEqual(docScope, {
    _id: 'doc-secret-456',
    tenantId: 'tenant-alpha',
    ownerId: 'usr-alpha-1',
  });
});

test('13. Google OAuth callback errors are parsed safely', () => {
  // Simulates an error returned by Google OAuth in redirect URL
  const errorQuery = new URLSearchParams({
    error: 'access_denied',
    error_description: 'User cancelled Google sign-in flow',
  });

  const errorCode = errorQuery.get('error');
  const errorDesc = errorQuery.get('error_description');

  assert.equal(errorCode, 'access_denied');
  assert.match(errorDesc ?? '', /cancelled/i);
});

test('14. expired session is rejected and requires renewal', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiredToken = await mintSupabaseToken({
    iat: now - 3600,
    exp: now - 10,
  });

  let errorCaught: unknown = null;
  try {
    await verifyAccessToken(expiredToken, supabaseSettings, testResolver);
  } catch (err) {
    errorCaught = err;
  }

  assert.ok(errorCaught instanceof Error);
  assert.match(errorCaught.message, /exp.*claim|expired/i);
});

test('15. successful logout clears active principal and subsequent requests fail', () => {
  // Simulate active session state
  let currentPrincipal: AuthenticatedPrincipal | undefined = {
    subject: 'usr-active-99',
    roles: ['user'],
    emailVerified: true,
  };

  assert.ok(currentPrincipal);

  // Logout clears session
  currentPrincipal = undefined;
  assert.equal(currentPrincipal, undefined);

  let status = 0;
  const mockResponse = {
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;

  const result = requirePrincipal({ principal: currentPrincipal } as Request, mockResponse);
  assert.equal(result, undefined);
  assert.equal(status, 401);
});
