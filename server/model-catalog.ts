import { getAIProviderConfig, getConfiguredAIProviders, namespacedModel, providerLabel, type AIProviderConfig, type AIProviderId } from './ai-provider.js';

export interface AvailableAIModel {
  id: string;
  name: string;
  description: string;
  contextLength: number | null;
}

interface OpenRouterModelRecord {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  architecture?: { output_modalities?: unknown };
  pricing?: { prompt?: unknown; completion?: unknown };
  endpoints?: unknown;
}

const CATALOG_TTL_MS = 60 * 60 * 1000;
let cachedCatalog: AvailableAIModel[] | undefined;
let cachedAt = 0;
let pendingCatalog: Promise<AvailableAIModel[]> | undefined;
const providerCatalogCache = new Map<string, { models: AvailableAIModel[]; cachedAt: number }>();

export function isFreeChatModel(value: unknown): value is OpenRouterModelRecord {
  if (!value || typeof value !== 'object') return false;
  const model = value as OpenRouterModelRecord;
  const endpoints = Array.isArray(model.endpoints) ? model.endpoints : [];
  const outputModalities = Array.isArray(model.architecture?.output_modalities)
    ? model.architecture.output_modalities
    : [];
  const isFreeId = model.id === 'openrouter/free' || (typeof model.id === 'string' && model.id.endsWith(':free'));
  return isFreeId && model.pricing?.prompt === '0' && model.pricing?.completion === '0' &&
    outputModalities.includes('text') && endpoints.includes('/api/v1/chat/completions');
}

export function parseFreeChatModels(value: unknown): AvailableAIModel[] {
  if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data)) return [];
  return value.data.filter(isFreeChatModel).map((entry) => {
    const id = String(entry.id);
    return {
      id,
      name: typeof entry.name === 'string' ? entry.name : id,
      description: typeof entry.description === 'string' ? entry.description.slice(0, 240) : '',
      contextLength: typeof entry.context_length === 'number' ? entry.context_length : null,
    };
  }).sort((a, b) => {
    if (a.id === 'openrouter/free') return -1;
    if (b.id === 'openrouter/free') return 1;
    return a.name.localeCompare(b.name);
  });
}

function parseProviderModels(value: unknown, config: AIProviderConfig): AvailableAIModel[] {
  if (!value || typeof value !== 'object') return [];
  let raw: unknown[] = [];
  if ('data' in value && Array.isArray(value.data)) raw = value.data;
  else if ('result' in value && Array.isArray(value.result)) raw = value.result;
  else if ('result' in value && value.result && typeof value.result === 'object' && 'data' in value.result && Array.isArray(value.result.data)) raw = value.result.data;
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string') return [];
    const record = entry as { id: string; name?: unknown; description?: unknown; context_length?: unknown; contextLength?: unknown; architecture?: { output_modalities?: unknown }; pricing?: { prompt?: unknown; completion?: unknown }; endpoints?: unknown };
    if (config.provider === 'openrouter') {
      const [freeModel] = parseFreeChatModels({ data: [record] });
      if (!freeModel) return [];
      return [{ ...freeModel, id: namespacedModel(config.provider, freeModel.id), name: `${freeModel.name} · ${providerLabel(config.provider)}` }];
    }
    if (config.provider === 'gemini') {
      const model = record.id.replace(/^models\//, '');
      if (/embedding|imagen|aqa|bison/i.test(model)) return [];
      return [{
        id: namespacedModel(config.provider, model),
        name: `${typeof record.name === 'string' && record.name ? record.name : model} · ${providerLabel(config.provider)}`,
        description: typeof record.description === 'string'
          ? record.description.slice(0, 200)
          : `${providerLabel(config.provider)} model. Free-tier limits apply.`,
        contextLength: typeof record.context_length === 'number' ? record.context_length : 1048576,
      }];
    }
    if (config.provider === 'cloudflare') {
      const modalities = Array.isArray(record.architecture?.output_modalities) ? record.architecture.output_modalities : [];
      const endpoints = Array.isArray(record.endpoints) ? record.endpoints : [];
      if (!record.id.startsWith('@cf/') || record.pricing?.prompt !== '0' || record.pricing?.completion !== '0' || !modalities.includes('text') || !endpoints.includes('/api/v1/chat/completions')) return [];
      return [{
        id: namespacedModel(config.provider, record.id),
        name: `${typeof record.name === 'string' ? record.name : record.id} · ${providerLabel(config.provider)}`,
        description: typeof record.description === 'string' ? record.description.slice(0, 200) : 'Zero-price text model; Cloudflare account allowance and eligibility apply.',
        contextLength: typeof record.context_length === 'number' ? record.context_length : null,
      }];
    }
    const model = record.id;
    return [{
      id: namespacedModel(config.provider, model),
      name: `${typeof record.name === 'string' ? record.name : model} · ${providerLabel(config.provider)}`,
      description: typeof record.description === 'string'
        ? record.description.slice(0, 200)
        : `${providerLabel(config.provider)} model. Account pricing and free-tier limits apply.`,
      contextLength: typeof record.context_length === 'number' ? record.context_length : typeof record.contextLength === 'number' ? record.contextLength : null,
    }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function fetchProviderCatalog(config: AIProviderConfig, fetcher: typeof fetch, environment: NodeJS.ProcessEnv): Promise<AvailableAIModel[]> {
  if (config.provider === 'ollama') {
    const tagsUrl = `${config.baseUrl.replace(/\/v1\/?$/, '')}/api/tags`;
    const response = await fetcher(tagsUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Ollama model catalog returned HTTP ${response.status}`);

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('models' in payload) || !Array.isArray(payload.models)) return [];

    return payload.models.flatMap((entry): AvailableAIModel[] => {
      if (!entry || typeof entry !== 'object' || !('name' in entry) || typeof entry.name !== 'string') return [];
      const item = entry as { name: string; size?: unknown; details?: { family?: unknown; parameter_size?: unknown } };
      const size = typeof item.size === 'number' ? ` · ${(item.size / 1_000_000_000).toFixed(1)} GB` : '';
      const details = [
        typeof item.details?.family === 'string' ? item.details.family : '',
        typeof item.details?.parameter_size === 'string' ? item.details.parameter_size : '',
      ].filter(Boolean).join(', ');

      return [{
        id: namespacedModel('ollama', item.name),
        name: `${item.name}${size} · ${providerLabel('ollama')}`,
        description: details ? `Installed local model: ${details}.` : 'Installed local Ollama model.',
        contextLength: null,
      }];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  let url: string;
  if (config.provider === 'cloudflare') {
    const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId || !config.apiKey) return [];
    url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=text-generation&format=openrouter&per_page=100`;
  } else {
    url = `${config.baseUrl}/models`;
  }
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`${config.providerLabel} model catalog returned HTTP ${response.status}`);
  return parseProviderModels(await response.json(), config);
}

export async function getProviderModelCatalog(
  provider: AIProviderId,
  fetcher: typeof fetch = fetch,
  environment: NodeJS.ProcessEnv = process.env
): Promise<AvailableAIModel[]> {
  const config = getAIProviderConfig(environment, provider);
  if ((provider !== 'ollama' && !config.apiKey) || !config.baseUrl) return [];
  const cacheKey = `${provider}:${config.baseUrl}`;
  const cached = providerCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CATALOG_TTL_MS) return cached.models;
  try {
    const models = await fetchProviderCatalog(config, fetcher, environment);
    if (models.length) {
      providerCatalogCache.set(cacheKey, { models, cachedAt: Date.now() });
      return models;
    }
  } catch {
    // If live fetch fails, fall back to default model for this configured provider
  }
  if (provider === 'ollama') return [];

  const fallbackModel: AvailableAIModel = {
    id: namespacedModel(config.provider, config.model),
    name: `${config.model} · ${providerLabel(config.provider)}`,
    description: `${providerLabel(config.provider)} model. Free-tier limits apply.`,
    contextLength: null,
  };
  return [fallbackModel];
}

export async function getAllConfiguredModelCatalog(
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch
): Promise<AvailableAIModel[]> {
  const configured = getConfiguredAIProviders(environment);
  const results = await Promise.all(configured.map(async ({ provider }) => {
    try { return await getProviderModelCatalog(provider, fetcher, environment); }
    catch { return []; }
  }));
  return results.flat();
}

export async function validateModelChoice(
  requestedModel: string | undefined,
  defaultModel: string,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch
): Promise<string> {
  if (!requestedModel) return defaultModel;
  if (requestedModel === defaultModel) return requestedModel;
  const separator = requestedModel.indexOf('::');
  if (separator < 1) {
    const configuredProviders = getConfiguredAIProviders(environment);
    const preferred = environment.AI_PROVIDER;
    const provider = (configuredProviders.find((p) => p.provider === preferred) ?? configuredProviders[0] ?? getAIProviderConfig(environment)).provider;
    const compatibleId = namespacedModel(provider, requestedModel);
    if (compatibleId === defaultModel) return compatibleId;
    const models = await getProviderModelCatalog(provider, fetcher, environment);
    if (models.some((model) => model.id === compatibleId)) return compatibleId;
    throw new Error(`That model is unavailable from ${providerLabel(provider)}. Refresh the model list and choose another.`);
  }
  const provider = requestedModel.slice(0, separator) as AIProviderId;
  const configuredProviders = getConfiguredAIProviders(environment);
  const isConfigured = configuredProviders.some((p) => p.provider === provider);
  if (!isConfigured) {
    const keyHint = provider === 'gemini' ? 'GEMINI_API_KEY or GOOGLE_API_KEY' : provider === 'openrouter' ? 'OPENROUTER_API_KEY' : `${provider.toUpperCase()}_API_KEY`;
    throw new Error(`The provider for model "${requestedModel}" is not configured. Add ${keyHint} to .env and restart the server.`);
  }
  const models = await getProviderModelCatalog(provider, fetcher, environment);
  if (!models.some((model) => model.id === requestedModel)) {
    throw new Error(`That model is unavailable from ${providerLabel(provider)}. Refresh the model list and choose another.`);
  }
  return requestedModel;
}

export async function getFreeModelCatalog(baseUrl: string, fetcher: typeof fetch = fetch): Promise<AvailableAIModel[]> {
  if (!baseUrl.includes('openrouter.ai')) return [];
  if (cachedCatalog && Date.now() - cachedAt < CATALOG_TTL_MS) return cachedCatalog;
  if (pendingCatalog) return pendingCatalog;

  pendingCatalog = (async () => {
    const response = await fetcher(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Model catalog request failed with HTTP ${response.status}`);
    const models = parseFreeChatModels(await response.json());
    if (!models.length) throw new Error('Provider returned no free chat models');
    cachedCatalog = models;
    cachedAt = Date.now();
    return models;
  })().finally(() => {
    pendingCatalog = undefined;
  });
  return pendingCatalog;
}

export async function validateFreeModelChoice(
  modelId: string | undefined,
  baseUrl: string,
  configuredModel: string,
  fetcher?: typeof fetch
): Promise<string> {
  if (!modelId) return configuredModel;
  if (modelId === configuredModel) return modelId;
  const models = await getFreeModelCatalog(baseUrl, fetcher);
  if (!models.some((model) => model.id === modelId)) throw new Error('Select a model from the available free model list.');
  return modelId;
}

export function clearFreeModelCatalogCacheForTests(): void {
  cachedCatalog = undefined;
  cachedAt = 0;
  pendingCatalog = undefined;
  providerCatalogCache.clear();
}
