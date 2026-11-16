import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { logEvent } from './observability.js';

export type AppRole = 'super_admin' | 'admin' | 'support_agent' | 'knowledge_manager' | 'user';

export interface AuthenticatedPrincipal {
  subject: string;
  roles: AppRole[];
  tenantId?: string;
  email?: string;
  emailVerified?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      principal?: AuthenticatedPrincipal;
    }
  }
}

const APP_ROLES = new Set<AppRole>(['super_admin', 'admin', 'support_agent', 'knowledge_manager', 'user']);
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksUrl: string | undefined;

export interface ResolvedAuthenticationConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  roleMapping: Record<string, AppRole>;
  rolesClaim: string;
  tenantClaim: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  requireVerifiedEmail: boolean;
}

export function resolveAuthenticationConfig(environment: NodeJS.ProcessEnv = process.env): ResolvedAuthenticationConfig | undefined {
  const supabaseUrl = environment.SUPABASE_URL?.trim();
  let supabaseAuthUrl: string | undefined;
  if (supabaseUrl) {
    try {
      const parsed = new URL(supabaseUrl);
      if (parsed.pathname === '/' && !parsed.search && !parsed.hash) supabaseAuthUrl = `${parsed.origin}/auth/v1`;
    } catch {
      // Configuration validation reports an invalid Supabase project URL.
    }
  }
  const issuer = environment.AUTH_ISSUER?.trim() || supabaseAuthUrl;
  const audience = environment.AUTH_AUDIENCE?.trim() || (supabaseAuthUrl ? 'authenticated' : undefined);
  const configuredJwksUrl = environment.AUTH_JWKS_URL?.trim() || (supabaseAuthUrl
    ? `${supabaseAuthUrl}/.well-known/jwks.json`
    : issuer ? `${issuer.replace(/\/$/, '')}/.well-known/jwks.json` : undefined);
  const roleMapping = getRoleMapping(environment);
  const requireVerifiedEmail = Boolean(supabaseUrl);
  const supabasePublishableKey = environment.SUPABASE_PUBLISHABLE_KEY?.trim() || environment.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!issuer || !audience || !configuredJwksUrl || !Object.keys(roleMapping).length ||
      !isSafeKeyUrl(issuer, environment.NODE_ENV) || !isSafeKeyUrl(configuredJwksUrl, environment.NODE_ENV) ||
      (requireVerifiedEmail && !supabasePublishableKey)) return undefined;
  return {
    issuer,
    audience,
    jwksUrl: configuredJwksUrl,
    roleMapping,
    rolesClaim: environment.AUTH_ROLES_CLAIM?.trim() || 'roles',
    tenantClaim: environment.AUTH_TENANT_CLAIM?.trim() || 'org_id',
    ...(supabaseUrl ? { supabaseUrl: supabaseUrl.replace(/\/$/, '') } : {}),
    ...(supabasePublishableKey ? { supabasePublishableKey } : {}),
    requireVerifiedEmail,
  };
}

export interface TokenVerificationSettings {
  issuer: string;
  audience: string;
  rolesClaim?: string;
  tenantClaim?: string;
  roleMapping?: Record<string, AppRole>;
  requireVerifiedEmail?: boolean;
}

function isSafeKeyUrl(value: string, nodeEnv = process.env.NODE_ENV): boolean {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (nodeEnv !== 'production' && loopback && url.protocol === 'http:');
  } catch {
    return false;
  }
}

export function isAuthenticationConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(resolveAuthenticationConfig(environment));
}

function keySet(url: string) {
  if (!jwks || jwksUrl !== url) {
    jwksUrl = url;
    jwks = createRemoteJWKSet(new URL(url), { timeoutDuration: 5000, cooldownDuration: 30000 });
  }
  return jwks;
}

function getRoleMapping(environment: NodeJS.ProcessEnv = process.env): Record<string, AppRole> {
  const configured = environment.AUTH_ROLE_MAPPING;
  if (!configured) return {};
  try {
    const parsed: unknown = JSON.parse(configured);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, AppRole] =>
      typeof entry[1] === 'string' && APP_ROLES.has(entry[1] as AppRole)
    ));
  } catch {
    return {};
  }
}

function getRoles(payload: JWTPayload, configuredClaim?: string, mapping = getRoleMapping()): AppRole[] {
  const claimName = configuredClaim || process.env.AUTH_ROLES_CLAIM || 'roles';
  const value = payload[claimName];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((role) => typeof role === 'string' && mapping[role] ? [mapping[role]] : []))];
}

export interface AuthenticationDependencies {
  resolver?: JWTVerifyGetKey;
  fetcher?: typeof fetch;
}

export async function authenticateRequest(request: Request, dependencies: AuthenticationDependencies = {}): Promise<AuthenticatedPrincipal | undefined> {
  const authorization = request.header('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const config = resolveAuthenticationConfig();
  if (!config) throw new Error('AUTH_NOT_CONFIGURED');
  const token = authorization.slice(7).trim();
  if (!token || token.length > 16_384) throw new Error('INVALID_TOKEN');
  const principal = await verifyAccessToken(token, {
    issuer: config.issuer,
    audience: config.audience,
    rolesClaim: config.rolesClaim,
    tenantClaim: config.tenantClaim,
    roleMapping: config.roleMapping,
  }, dependencies.resolver ?? keySet(config.jwksUrl));
  if (config.requireVerifiedEmail) {
    await verifySupabaseEmailConfirmation(token, config, principal.subject, dependencies.fetcher);
    principal.emailVerified = true;
  }
  return principal;
}

export async function verifySupabaseEmailConfirmation(
  token: string,
  config: Pick<ResolvedAuthenticationConfig, 'supabaseUrl' | 'supabasePublishableKey'>,
  expectedSubject: string,
  fetcher: typeof fetch = fetch
): Promise<void> {
  if (!config.supabaseUrl || !config.supabasePublishableKey) throw new Error('AUTH_NOT_CONFIGURED');
  let authResponse: globalThis.Response;
  try {
    authResponse = await fetcher(`${config.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: config.supabasePublishableKey, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error('AUTH_UPSTREAM_UNAVAILABLE');
  }
  if (authResponse.status === 401 || authResponse.status === 403) throw new Error('INVALID_TOKEN');
  if (!authResponse.ok) throw new Error('AUTH_UPSTREAM_UNAVAILABLE');
  let user: unknown;
  try { user = await authResponse.json(); } catch { throw new Error('AUTH_UPSTREAM_UNAVAILABLE'); }
  if (typeof user !== 'object' || user === null || !('id' in user) || user.id !== expectedSubject ||
      !('email_confirmed_at' in user) ||
      typeof user.email_confirmed_at !== 'string' || user.email_confirmed_at.length === 0) {
    throw new Error('UNVERIFIED_EMAIL');
  }
}

export async function verifyAccessToken(token: string, settings: TokenVerificationSettings, resolver: JWTVerifyGetKey): Promise<AuthenticatedPrincipal> {
  const { payload } = await jwtVerify(token, resolver, {
    issuer: settings.issuer,
    audience: settings.audience,
    algorithms: ['RS256', 'ES256'],
    requiredClaims: ['sub', 'exp', 'iat'],
    maxTokenAge: '12h',
  });
  if (!payload.sub || payload.sub.length > 200 || /[\x00-\x1f]/.test(payload.sub)) throw new Error('INVALID_TOKEN');
  // Supabase's access-token JWT does not include email_confirmed_at. Supabase-backed
  // requests verify confirmation against /auth/v1/user after signature validation.
  const emailVerified = payload.email_verified === true;
  const tenantClaim = settings.tenantClaim || process.env.AUTH_TENANT_CLAIM || 'org_id';
  const tenantId = payload[tenantClaim];
  const roles = getRoles(payload, settings.rolesClaim, settings.roleMapping ?? getRoleMapping());
  if (roles.length === 0) throw new Error('INVALID_ROLE_CLAIM');
  return {
    subject: payload.sub,
    roles,
    ...(typeof tenantId === 'string' && tenantId.length > 0 && tenantId.length <= 200 && !/[\x00-\x1f]/.test(tenantId) ? { tenantId } : {}),
    ...(typeof payload.email === 'string' && payload.email.length <= 320 ? { email: payload.email } : {}),
    emailVerified,
  };
}

export function requirePrincipal(request: Request, response: Response): AuthenticatedPrincipal | undefined {
  if (request.principal) return request.principal;
  logEvent('security.authentication_missing', { requestId: request.requestId, method: request.method }, 'warn');
  response.status(401).json({ error: 'Authentication is required.' });
  return undefined;
}

export function requireRole(
  principal: AuthenticatedPrincipal,
  roles: AppRole[],
  options: { includeAdministrators?: boolean } = {}
): boolean {
  const includeAdministrators = options.includeAdministrators ?? true;
  return (includeAdministrators && (principal.roles.includes('super_admin') || principal.roles.includes('admin'))) ||
    roles.some((role) => principal.roles.includes(role));
}

export function isTemporaryJwksFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC'].includes(String((error as { code?: unknown }).code));
}

export function authenticationMiddleware(request: Request, response: Response, next: NextFunction): void {
  const authorization = request.header('authorization');
  if (!authorization) return next();
  void authenticateRequest(request).then((principal) => {
    request.principal = principal;
    next();
  }).catch((error: unknown) => {
    const configurationError = error instanceof Error && error.message === 'AUTH_NOT_CONFIGURED';
    const keySetUnavailable = isTemporaryJwksFailure(error) || (error instanceof Error && error.message === 'AUTH_UPSTREAM_UNAVAILABLE');
    const unavailable = configurationError || keySetUnavailable;
    logEvent('security.authentication_failure', { requestId: request.requestId, method: request.method, reason: configurationError ? 'configuration' : keySetUnavailable ? 'jwks_unavailable' : 'invalid_token' }, unavailable ? 'error' : 'warn');
    response.status(unavailable ? 503 : 401).json({ error: configurationError ? 'Authentication is not configured.' : keySetUnavailable ? 'Authentication verification is temporarily unavailable.' : 'Invalid or expired access token.' });
  });
}
