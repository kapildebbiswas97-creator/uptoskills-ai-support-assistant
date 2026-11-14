import test from 'node:test';
import assert from 'node:assert/strict';
import { streamOpenAICompatible } from './ai-provider';

test('OpenRouter uses OPENROUTER_API_KEY and routes to openrouter endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let sentOpenRouter: { url: string; auth: string; model: string } | undefined;

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const sUrl = String(url);
    if (sUrl.includes('openrouter.ai')) {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body));
      sentOpenRouter = { url: sUrl, auth: headers.Authorization, model: body.model };
      return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;

  const priorKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key-123';
  try {
    const controller = new AbortController();
    for await (const _ of streamOpenAICompatible(
      'Analyze resume',
      {} as never,
      controller.signal,
      [],
      [],
      undefined,
      'openrouter::google/gemma-4-31b-it:free'
    )) {}

    assert.ok(sentOpenRouter);
    assert.equal(sentOpenRouter.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(sentOpenRouter.auth, 'Bearer test-openrouter-key-123');
    assert.equal(sentOpenRouter.model, 'google/gemma-4-31b-it:free');
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorKey;
  }
});

test('Gemini model selection routes to Google Gemini endpoint with GEMINI_API_KEY', async () => {
  const originalFetch = globalThis.fetch;
  let sentGemini: { url: string; auth: string; model: string } | undefined;

  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const sUrl = String(url);
    if (sUrl.includes('googleapis.com')) {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body));
      sentGemini = { url: sUrl, auth: headers.Authorization, model: body.model };
      return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;

  const priorKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini-key-456';
  try {
    const controller = new AbortController();
    for await (const _ of streamOpenAICompatible(
      'Analyze resume',
      {} as never,
      controller.signal,
      [],
      [],
      undefined,
      'gemini::gemma-2-27b-it'
    )) {}

    assert.ok(sentGemini);
    assert.equal(sentGemini.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    assert.equal(sentGemini.auth, 'Bearer test-gemini-key-456');
    assert.equal(sentGemini.model, 'gemma-2-27b-it');
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = priorKey;
  }
});
