import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { logEvent } from './observability.js';

export type AppRole = 'super_admin' | 'admin' | 'support_agent' | 'knowledge_manager' | 'user';

export interface AuthenticatedPrincipal {
  subject: string;
  roles: AppRole[];
  tenantId?: string;
  email?: string;
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

function authSettings() {
  const issuer = process.env.AUTH_ISSUER;
  const audience = process.env.AUTH_AUDIENCE;
  const configuredJwksUrl = process.env.AUTH_JWKS_URL || (issuer ? `${issuer.replace(/\/$/, '')}/.well-known/jwks.json` : undefined);
  return { issuer, audience, configuredJwksUrl };
}

export interface TokenVerificationSettings {
  issuer: string;
  audience: string;
  rolesClaim?: string;
  tenantClaim?: string;
  roleMapping?: Record<string, AppRole>;
}

function isSafeKeyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && loopback && url.protocol === 'http:');
  } catch {
    return false;
  }
}

export function isAuthenticationConfigured(): boolean {
  const { issuer, audience, configuredJwksUrl } = authSettings();
  return Boolean(issuer && audience && configuredJwksUrl && isSafeKeyUrl(issuer) && isSafeKeyUrl(configuredJwksUrl) && Object.keys(getRoleMapping()).length);
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

export async function authenticateRequest(request: Request): Promise<AuthenticatedPrincipal | undefined> {
  const authorization = request.header('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const { issuer, audience, configuredJwksUrl } = authSettings();
  if (!issuer || !audience || !configuredJwksUrl || !isSafeKeyUrl(issuer) || !isSafeKeyUrl(configuredJwksUrl) || !Object.keys(getRoleMapping()).length) throw new Error('AUTH_NOT_CONFIGURED');
  const token = authorization.slice(7).trim();
  if (!token || token.length > 16_384) throw new Error('INVALID_TOKEN');
  return verifyAccessToken(token, { issuer, audience, roleMapping: getRoleMapping() }, keySet(configuredJwksUrl));
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
  const tenantClaim = settings.tenantClaim || process.env.AUTH_TENANT_CLAIM || 'org_id';
  const tenantId = payload[tenantClaim];
  return {
    subject: payload.sub,
    roles: getRoles(payload, settings.rolesClaim, settings.roleMapping ?? getRoleMapping()),
    ...(typeof tenantId === 'string' && tenantId.length > 0 && tenantId.length <= 200 && !/[\x00-\x1f]/.test(tenantId) ? { tenantId } : {}),
    ...(typeof payload.email === 'string' && payload.email.length <= 320 ? { email: payload.email } : {}),
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
    const keySetUnavailable = isTemporaryJwksFailure(error);
    const unavailable = configurationError || keySetUnavailable;
    logEvent('security.authentication_failure', { requestId: request.requestId, method: request.method, reason: configurationError ? 'configuration' : keySetUnavailable ? 'jwks_unavailable' : 'invalid_token' }, unavailable ? 'error' : 'warn');
    response.status(unavailable ? 503 : 401).json({ error: configurationError ? 'Authentication is not configured.' : keySetUnavailable ? 'Authentication verification is temporarily unavailable.' : 'Invalid or expired access token.' });
  });
}
