import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderModelCatalog, parseFreeChatModels, validateFreeModelChoice, clearFreeModelCatalogCacheForTests, validateModelChoice } from './model-catalog';

const freeModel = {
  id: 'vendor/free-chat:free',
  name: 'Vendor: Free Chat',
  description: 'Free text model.',
  context_length: 32000,
  architecture: { output_modalities: ['text'] },
  pricing: { prompt: '0', completion: '0' },
  endpoints: ['/api/v1/chat/completions'],
};

test('model catalog contains only free text chat models and the free router', () => {
  const catalog = parseFreeChatModels({ data: [
    freeModel,
    { ...freeModel, id: 'vendor/paid-model', pricing: { prompt: '0.000001', completion: '0.000002' } },
    { ...freeModel, id: 'vendor/free-audio:free', architecture: { output_modalities: ['audio'] } },
    { ...freeModel, id: 'openrouter/free', name: 'Free Models Router' },
  ] });
  assert.deepEqual(catalog.map((model) => model.id), ['openrouter/free', 'vendor/free-chat:free']);
  assert.equal(catalog[1].contextLength, 32000);
});

test('requested models are validated against the current free catalog', async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ data: [freeModel] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const selected = await validateFreeModelChoice('vendor/free-chat:free', 'https://openrouter.ai/api/v1', 'openrouter/free', fetcher);
  assert.equal(selected, 'vendor/free-chat:free');
  await assert.rejects(
    validateFreeModelChoice('vendor/paid-model', 'https://openrouter.ai/api/v1', 'openrouter/free', fetcher),
    /available free model list/
  );
});

test('provider model catalogs namespace choices and keep OpenRouter to zero-price text models', async () => {
  clearFreeModelCatalogCacheForTests();
  const env = { OPENROUTER_API_KEY: 'router-secret' } as NodeJS.ProcessEnv;
  const gemmaOpenRouterModel = {
    ...freeModel,
    id: 'google/gemma-4-31b-it:free',
    name: 'Google: Gemma 4 31B (free)',
  };
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ data: [freeModel, gemmaOpenRouterModel] }), { status: 200 });
  const catalog = await getProviderModelCatalog('openrouter', fetcher, env);
  assert.deepEqual(catalog.map((model) => model.id), [
    'openrouter::google/gemma-4-31b-it:free',
    'openrouter::vendor/free-chat:free',
  ]);
  assert.equal(await validateModelChoice(catalog[0].id, 'openrouter::openrouter/free', env, fetcher), catalog[0].id);
  assert.equal(await validateModelChoice('openrouter::google/gemma-4-31b-it:free', 'openrouter::openrouter/free', env, fetcher), 'openrouter::google/gemma-4-31b-it:free');
  await assert.rejects(validateModelChoice('openrouter::vendor/paid-model', 'openrouter::openrouter/free', env, fetcher), /unavailable/);
  clearFreeModelCatalogCacheForTests();
});

test('Gemini and Gemma models are loaded only when Gemini API key is configured', async () => {
  clearFreeModelCatalogCacheForTests();
  // 1. Unconfigured: returns empty catalog
  const unconfiguredCatalog = await getProviderModelCatalog('gemini', fetch, {} as NodeJS.ProcessEnv);
  assert.deepEqual(unconfiguredCatalog, []);

  // 2. Configured with GEMINI_API_KEY: fetches live models and filters out non-chat models
  let requestedUrl = '';
  let authHeader = '';
  const env = { GEMINI_API_KEY: 'gemini-test-key' } as NodeJS.ProcessEnv;
  const fetcher: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authHeader = String((init?.headers as Record<string, string>)?.Authorization);
    return new Response(JSON.stringify({
      data: [
        { id: 'models/gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
        { id: 'models/gemma-2-27b-it', name: 'Gemma 2 27B' },
        { id: 'models/text-embedding-004', name: 'Embedding' },
      ],
    }), { status: 200 });
  };
  const catalog = await getProviderModelCatalog('gemini', fetcher, env);
  assert.equal(requestedUrl, 'https://generativelanguage.googleapis.com/v1beta/openai/models');
  assert.equal(authHeader, 'Bearer gemini-test-key');
  assert.deepEqual(catalog.map((model) => model.id), [
    'gemini::gemini-2.5-flash',
    'gemini::gemma-2-27b-it',
  ]);
  assert.equal(await validateModelChoice('gemini::gemma-2-27b-it', 'gemini::gemini-2.5-flash', env, fetcher), 'gemini::gemma-2-27b-it');

  // 3. Fallback when fetch fails returns default configured model
  clearFreeModelCatalogCacheForTests();
  const failingFetcher: typeof fetch = async () => new Response('Error', { status: 500 });
  const fallbackCatalog = await getProviderModelCatalog('gemini', failingFetcher, env);
  assert.deepEqual(fallbackCatalog.map((m) => m.id), ['gemini::gemini-2.5-flash']);
  clearFreeModelCatalogCacheForTests();
});

test('unconfigured provider model choice is rejected with actionable error naming the missing key', async () => {
  clearFreeModelCatalogCacheForTests();
  // Only Groq is configured, OpenRouter and Gemini are unconfigured
  const env = { GROQ_API_KEY: 'groq-key' } as NodeJS.ProcessEnv;
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ data: [{ id: 'llama-3' }] }), { status: 200 });

  await assert.rejects(
    validateModelChoice('openrouter::google/gemma-4-31b-it:free', 'groq::llama-3', env, fetcher),
    /The provider for model "openrouter::google\/gemma-4-31b-it:free" is not configured\. Add OPENROUTER_API_KEY to \.env/
  );

  await assert.rejects(
    validateModelChoice('gemini::gemma-2-27b-it', 'groq::llama-3', env, fetcher),
    /The provider for model "gemini::gemma-2-27b-it" is not configured\. Add GEMINI_API_KEY or GOOGLE_API_KEY to \.env/
  );
  clearFreeModelCatalogCacheForTests();
});

test('Groq catalog options are loaded only when its API key is configured', async () => {
  clearFreeModelCatalogCacheForTests();
  let requestedUrl = '';
  const env = { GROQ_API_KEY: 'groq-secret' } as NodeJS.ProcessEnv;
  const fetcher: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ data: [{ id: 'llama-test', owned_by: 'meta' }] }), { status: 200 });
  };
  const catalog = await getProviderModelCatalog('groq', fetcher, env);
  assert.equal(requestedUrl, 'https://api.groq.com/openai/v1/models');
  assert.deepEqual(catalog.map((model) => model.id), ['groq::llama-test']);
  clearFreeModelCatalogCacheForTests();
});

test('Cloudflare model catalog uses its account-scoped free text catalog', async () => {
  clearFreeModelCatalogCacheForTests();
  let requestedUrl = '';
  const env = { CLOUDFLARE_API_TOKEN: 'cf-secret', CLOUDFLARE_ACCOUNT_ID: 'account-123' } as NodeJS.ProcessEnv;
  const cloudflareModel = { ...freeModel, id: '@cf/meta/test-chat' };
  const fetcher: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer cf-secret');
    return new Response(JSON.stringify({ result: { data: [cloudflareModel] } }), { status: 200 });
  };
  const catalog = await getProviderModelCatalog('cloudflare', fetcher, env);
  assert.match(requestedUrl, /accounts\/account-123\/ai\/models\/search\?task=text-generation&format=openrouter/);
  assert.deepEqual(catalog.map((model) => model.id), ['cloudflare::@cf/meta/test-chat']);
  clearFreeModelCatalogCacheForTests();
});
