import { createHmac, randomUUID } from 'node:crypto';

export interface SignedRlsContext {
  tenantId: string | null;
  allowAllTenants: boolean;
  keyId: string;
  issuedAt: number;
  nonce: string;
  signature: string;
}

export function signedRlsContextPayload(context: Omit<SignedRlsContext, 'signature'>): string {
  const tenantHex = Buffer.from(context.tenantId ?? '', 'utf8').toString('hex');
  return [
    'v1',
    context.keyId,
    tenantHex,
    context.allowAllTenants ? 'true' : 'false',
    String(context.issuedAt),
    context.nonce,
  ].join('|');
}

export function createSignedRlsContext(
  tenantId: string | null,
  allowAllTenants: boolean,
  environment: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  nonce = randomUUID()
): SignedRlsContext {
  const keyId = environment.RLS_CONTEXT_KEY_ID?.trim();
  const encodedKey = environment.RLS_CONTEXT_HMAC_KEY?.trim();
  if (!keyId || !/^[A-Za-z0-9_-]{1,40}$/.test(keyId) || !encodedKey) {
    throw new Error('RLS_CONTEXT_NOT_CONFIGURED');
  }
  if (tenantId !== null && (!tenantId || tenantId.length > 200 || /[\x00-\x1f]/.test(tenantId))) {
    throw new Error('INVALID_RLS_TENANT');
  }
  if (!Number.isFinite(now) || !Number.isInteger(now) || now < 0 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) {
    throw new Error('INVALID_RLS_CONTEXT');
  }

  const key = Buffer.from(encodedKey, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encodedKey) {
    throw new Error('INVALID_RLS_CONTEXT_KEY');
  }
  const context = { tenantId, allowAllTenants, keyId, issuedAt: Math.floor(now / 1000), nonce };
  const signature = createHmac('sha256', key).update(signedRlsContextPayload(context), 'utf8').digest('hex');
  return { ...context, signature };
}
