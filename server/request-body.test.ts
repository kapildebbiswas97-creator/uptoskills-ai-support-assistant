import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response, NextFunction } from 'express';
import { createRequestBodyParser } from './request-body.js';

function middlewareRequest(overrides: Record<string, unknown> = {}) {
  return {
    body: { message: 'hello' },
    readableEnded: true,
    url: '/api/chat/stream',
    get: () => undefined,
    ...overrides,
  } as unknown as Request;
}

function middlewareResponse() {
  const result: { status?: number; body?: unknown } = {};
  const response = {
    status(status: number) { result.status = status; return this; },
    json(body: unknown) { result.body = body; return this; },
  } as unknown as Response;
  return { response, result };
}

test('keeps a body already parsed by the serverless adapter without rereading its consumed stream', async () => {
  const middleware = createRequestBodyParser();
  const request = middlewareRequest();
  const { response, result } = middlewareResponse();
  let continued = false;
  middleware(request, response, (() => { continued = true; }) as NextFunction);
  assert.equal(continued, true);
  assert.equal(result.status, undefined);
  assert.deepEqual(request.body, { message: 'hello' });
});

test('does not invoke a stream parser when the serverless adapter consumed the request body', () => {
  const middleware = createRequestBodyParser();
  const request = middlewareRequest({ body: undefined, readable: false, readableEnded: false });
  const { response, result } = middlewareResponse();
  let continued = false;
  middleware(request, response, (() => { continued = true; }) as NextFunction);
  assert.equal(continued, true);
  assert.equal(result.status, undefined);
});

test('returns a controlled 400 when the serverless body getter rejects malformed JSON', () => {
  const middleware = createRequestBodyParser();
  const request = middlewareRequest({ readable: false, readableEnded: false });
  Object.defineProperty(request, 'body', { configurable: true, get() { throw new SyntaxError('malformed JSON'); } });
  const { response, result } = middlewareResponse();
  let continued = false;
  middleware(request, response, (() => { continued = true; }) as NextFunction);
  assert.equal(continued, false);
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: 'Invalid request body' });
});

test('enforces the smaller workflow limit for a serverless pre-parsed request', () => {
  const middleware = createRequestBodyParser();
  const request = middlewareRequest({ url: '/api/meeting-requests?source=web', get: () => String(17 * 1024) });
  const { response, result } = middlewareResponse();
  let continued = false;
  middleware(request, response, (() => { continued = true; }) as NextFunction);
  assert.equal(continued, false);
  assert.equal(result.status, 413);
  assert.deepEqual(result.body, { error: 'Request body is too large' });
});
