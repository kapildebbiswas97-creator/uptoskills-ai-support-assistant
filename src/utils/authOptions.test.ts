import assert from 'node:assert/strict';
import test from 'node:test';
import { isGoogleOAuthEnabled } from './authOptions';

test('Google OAuth is shown only when Supabase is configured and the provider is explicitly enabled', () => {
  assert.equal(isGoogleOAuthEnabled(false, 'true'), false);
  assert.equal(isGoogleOAuthEnabled(true, undefined), false);
  assert.equal(isGoogleOAuthEnabled(true, 'false'), false);
  assert.equal(isGoogleOAuthEnabled(true, ' TRUE '), true);
});
