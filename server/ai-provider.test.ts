import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatMessages, getAIProviderConfig, streamOpenAICompatible } from './ai-provider';

test('AI provider configuration supports single-variable model switching', () => {
  const config = getAIProviderConfig({ AI_API_KEY: 'secret', AI_MODEL: 'vendor/model', AI_BASE_URL: 'https://example.test/v1/' } as NodeJS.ProcessEnv);
  assert.equal(config.apiKey, 'secret');
  assert.equal(config.model, 'vendor/model');
  assert.equal(config.baseUrl, 'https://example.test/v1');
  assert.equal(config.provider, 'openrouter');
});

test('provider registry reads separate server-only keys and endpoint defaults', () => {
  const openrouter = getAIProviderConfig({ OPENROUTER_API_KEY: 'or-secret' } as NodeJS.ProcessEnv, 'openrouter');
  const groq = getAIProviderConfig({ GROQ_API_KEY: 'groq-secret' } as NodeJS.ProcessEnv, 'groq');
  const gemini = getAIProviderConfig({ GEMINI_API_KEY: 'gemini-secret' } as NodeJS.ProcessEnv, 'gemini');
  const geminiGoogleFallback = getAIProviderConfig({ GOOGLE_API_KEY: 'google-secret' } as NodeJS.ProcessEnv, 'gemini');
  const cloudflare = getAIProviderConfig({ CLOUDFLARE_API_TOKEN: 'cf-secret', CLOUDFLARE_ACCOUNT_ID: 'account-123' } as NodeJS.ProcessEnv, 'cloudflare');

  assert.equal(openrouter.apiKey, 'or-secret');
  assert.equal(openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(groq.apiKey, 'groq-secret');
  assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(gemini.apiKey, 'gemini-secret');
  assert.equal(gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(geminiGoogleFallback.apiKey, 'google-secret');
  assert.equal(cloudflare.baseUrl, 'https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1');
  assert.equal(cloudflare.apiKey, 'cf-secret');
});

test('missing provider key throws actionable error naming the required environment variable', async () => {
  const controller = new AbortController();
  await assert.rejects(
    async () => {
      for await (const _chunk of streamOpenAICompatible('Hello', {} as never, controller.signal, [], [], undefined, 'openrouter::openrouter/free', {
        provider: 'openrouter', providerLabel: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'openrouter/free', webSearch: false
      })) { /* consume */ }
    },
    /Add OPENROUTER_API_KEY to \.env and restart the server/
  );

  await assert.rejects(
    async () => {
      for await (const _chunk of streamOpenAICompatible('Hello', {} as never, controller.signal, [], [], undefined, 'gemini::gemini-2.5-flash', {
        provider: 'gemini', providerLabel: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '', model: 'gemini-2.5-flash', webSearch: false
      })) { /* consume */ }
    },
    /Add GEMINI_API_KEY or GOOGLE_API_KEY to \.env and restart the server/
  );
});

test('provider request includes retrieved PDFs, conversation history, and streams OpenAI-compatible deltas', async () => {
  const originalFetch = globalThis.fetch;
  let sent: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent = { url: String(input), init };
    return new Response('data: {"choices":[{"delta":{"content":"Grounded "}}]}\n\ndata: {"choices":[{"delta":{"content":"reply."}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
  try {
    const config = { provider: 'openrouter' as const, providerLabel: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'secret', model: 'vendor/model', webSearch: false };
    const controller = new AbortController();
    const messages = buildChatMessages('What does onboarding require?', ['[Source: guide.pdf]\nBring your ID.'], [
      { role: 'user', content: 'I received an offer.' },
    ]);
    assert.match(messages[0].content, /guide\.pdf/);
    assert.equal(messages[1].content, 'I received an offer.');

    const chunks: string[] = [];
    for await (const part of streamOpenAICompatible('What does onboarding require?', {} as never, controller.signal, ['[Source: guide.pdf]\nBring your ID.'], [{ role: 'user', content: 'I received an offer.' }], undefined, undefined, config)) {
      chunks.push(part);
    }
    assert.deepEqual(chunks, ['Grounded ', 'reply.']);
    assert.equal(sent?.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal((sent?.init?.headers as Record<string, string>).Authorization, 'Bearer secret');
    const body = JSON.parse(String(sent?.init?.body));
    assert.equal(body.model, 'vendor/model');
    assert.equal(body.stream, true);
    assert.match(body.messages[0].content, /guide\.pdf/);

    for await (const _part of streamOpenAICompatible(
      'Research the latest policy updates', {} as never, controller.signal, [], [], undefined,
      undefined, { ...config, webSearch: true }
    )) { /* consume the mocked response */ }
    const researchBody = JSON.parse(String(sent?.init?.body));
    assert.equal(researchBody.model, 'vendor/model');
    assert.deepEqual(researchBody.tools, [{ type: 'openrouter:web_search' }]);

    for await (const _part of streamOpenAICompatible(
      'Hello', {} as never, controller.signal, [], [], undefined, 'vendor/chosen-model:free', config
    )) { /* consume the mocked response */ }
    assert.equal(JSON.parse(String(sent?.init?.body)).model, 'vendor/chosen-model:free');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('selected provider model uses that provider endpoint and server-only key', async () => {
  const originalFetch = globalThis.fetch;
  const priorKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'groq-test-secret';
  let sent: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent = { url: String(input), init };
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    for await (const _part of streamOpenAICompatible('Hello', {} as never, controller.signal, [], [], undefined, 'groq::llama-test')) { /* consume */ }
    assert.equal(sent?.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal((sent?.init?.headers as Record<string, string>).Authorization, 'Bearer groq-test-secret');
    assert.equal(JSON.parse(String(sent?.init?.body)).model, 'llama-test');
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = priorKey;
  }
});

test('provider system guardrails mark unsupported UpToSkills answers for HR', () => {
  const messages = buildChatMessages('When will I be selected?', [], []);
  assert.match(messages[0].content, /\[SHOW_HR_BUTTON\]/);
  assert.match(messages[0].content, /Do not access accounts, submit forms, send messages/);
});
