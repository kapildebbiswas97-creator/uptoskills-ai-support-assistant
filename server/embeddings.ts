import { GoogleGenAI } from '@google/genai';
import { logEvent, recordMetric } from './observability.js';

export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || 768);
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';
export const EMBEDDING_VERSION = Number(process.env.EMBEDDING_VERSION || 1);
export type EmbeddingProvider = 'gemini';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  version: number;
}

export function getEmbeddingConfig(environment: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const provider = environment.EMBEDDING_PROVIDER || 'gemini';
  if (provider !== 'gemini') throw new Error(`Unsupported embedding provider: ${provider}`);
  const dimensions = Number(environment.EMBEDDING_DIMENSIONS || 768);
  const version = Number(environment.EMBEDDING_VERSION || 1);
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 3072) throw new Error('EMBEDDING_DIMENSIONS must be an integer from 1 to 3072');
  if (!Number.isInteger(version) || version < 1) throw new Error('EMBEDDING_VERSION must be a positive integer');
  return { provider, model: environment.EMBEDDING_MODEL || environment.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2', dimensions, version };
}

function getClient(apiKey?: string): GoogleGenAI {
  const key = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is required to create knowledge embeddings');
  return new GoogleGenAI({ apiKey: key, httpOptions: { timeout: 15_000 } });
}

export async function embedTexts(texts: string[], apiKey?: string, signal?: AbortSignal, taskType = 'RETRIEVAL_DOCUMENT'): Promise<number[][]> {
  if (!texts.length) return [];
  if (texts.some((text) => !text.trim() || text.length > 30_000)) throw new Error('Embedding inputs must be non-empty and at most 30000 characters');
  const config = getEmbeddingConfig();
  const client = getClient(apiKey);
  const output: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += 32) {
    if (signal?.aborted) throw new Error('Embedding request was cancelled');
    const batch = texts.slice(offset, offset + 32);
    const started = performance.now();
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await client.models.embedContent({
          model: config.model,
          contents: batch,
          config: { outputDimensionality: config.dimensions, taskType, abortSignal: signal, httpOptions: { timeout: 15_000 } },
        });
        const vectors = response.embeddings?.map((embedding) => embedding.values ?? []) ?? [];
        if (vectors.length !== batch.length || vectors.some((vector) => vector.length !== config.dimensions || vector.some((value) => !Number.isFinite(value)))) {
          throw new Error(`Embedding provider returned an invalid ${config.dimensions}-dimension batch`);
        }
        output.push(...vectors);
        lastError = undefined;
        const durationMs = Math.round(performance.now() - started);
        recordMetric('embedding_batch_duration_ms', durationMs, { provider: config.provider }, 'histogram');
        recordMetric('embedding_batches_total', 1, { provider: config.provider, status: 'success' });
        break;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    if (lastError) {
      logEvent('embedding.batch.failed', { provider: config.provider, batchSize: batch.length, errorType: lastError instanceof Error ? lastError.name : 'unknown', durationMs: Math.round(performance.now() - started) }, 'error');
      recordMetric('embedding_batches_total', 1, { provider: config.provider, status: 'failure' });
      throw lastError;
    }
  }
  return output;
}

export async function embedText(text: string, apiKey?: string, signal?: AbortSignal, taskType = 'RETRIEVAL_DOCUMENT'): Promise<number[]> {
  const [vector] = await embedTexts([text], apiKey, signal, taskType);
  return vector;
}
