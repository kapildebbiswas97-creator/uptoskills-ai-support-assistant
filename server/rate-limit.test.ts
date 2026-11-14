import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestRateLimiter } from './rate-limit';

test('uses a local per-address fallback with a fixed request window', async () => {
  const limiter = await createRequestRateLimiter();
  assert.equal(limiter.backend, 'memory');

  for (let index = 0; index < 40; index += 1) {
    assert.equal(await limiter.allow('127.0.0.1'), true);
  }
  assert.equal(await limiter.allow('127.0.0.1'), false);
  assert.equal(await limiter.allow('127.0.0.2'), true);
  await limiter.close();
});
