import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { createSignedRlsContext, signedRlsContextPayload } from './rls-context';

const key = Buffer.alloc(32, 7).toString('base64url');
const environment = { RLS_CONTEXT_KEY_ID: 'test-key-1', RLS_CONTEXT_HMAC_KEY: key };
const nonce = '123e4567-e89b-42d3-a456-426614174000';

test('signed RLS context binds tenant, global access, key ID, issue time and nonce', () => {
  const context = createSignedRlsContext('tenant-a', false, environment, 1_800_000_000_000, nonce);
  const payload = signedRlsContextPayload(context);
  const expected = createHmac('sha256', Buffer.from(key, 'base64url')).update(payload).digest('hex');
  assert.equal(context.signature, expected);
  assert.equal(context.issuedAt, 1_800_000_000);
  assert.notEqual(payload, signedRlsContextPayload({ ...context, tenantId: 'tenant-b' }));
  assert.notEqual(payload, signedRlsContextPayload({ ...context, allowAllTenants: true }));
  assert.notEqual(payload, signedRlsContextPayload({ ...context, keyId: 'other-key' }));
  assert.notEqual(payload, signedRlsContextPayload({ ...context, issuedAt: context.issuedAt + 1 }));
  assert.notEqual(payload, signedRlsContextPayload({ ...context, nonce: '123e4567-e89b-42d3-a456-426614174001' }));
});

test('signed RLS context accepts null tenant while rejecting malformed tenant IDs and keys', () => {
  const context = createSignedRlsContext(null, false, environment, 1_800_000_000_000, nonce);
  assert.equal(context.tenantId, null);
  assert.throws(() => createSignedRlsContext('tenant\nB', false, environment), /INVALID_RLS_TENANT/);
  assert.throws(() => createSignedRlsContext('tenant-a', false, { RLS_CONTEXT_KEY_ID: 'bad id', RLS_CONTEXT_HMAC_KEY: key }), /RLS_CONTEXT_NOT_CONFIGURED/);
  assert.throws(() => createSignedRlsContext('tenant-a', false, { ...environment, RLS_CONTEXT_HMAC_KEY: 'short' }), /INVALID_RLS_CONTEXT_KEY/);
});
