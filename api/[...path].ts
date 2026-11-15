import type { Request, Response } from 'express';
import type { Express } from 'express';

import { createApp, type TextStream } from '../server/app.js';
import { loadKnowledge } from '../server/assistant.js';
import {
  getConfiguredAIProviders,
  streamOpenAICompatible,
  splitNamespacedModel,
} from '../server/ai-provider.js';
import { streamGeminiText } from '../server/gemini.js';
import { createPdfKnowledgeBase } from '../server/knowledge-base.js';
import { createRequestRateLimiter } from '../server/rate-limit.js';
import { createKnowledgeSearch } from '../server/database.js';
import { createDocumentService } from '../server/document-ingestion.js';
import { createDatabaseHealthCheck } from '../server/health.js';
import { assertRuntimeEnvironment } from '../server/environment.js';
import { logEvent } from '../server/observability.js';

let appPromise: Promise<Express> | undefined;

async function buildApp(): Promise<Express> {
  // In Preview, missing integrations should be reported by /api/health and fail
  // closed at their own routes; they must not prevent protected routes from
  // returning their proper 401/403 responses.
  assertRuntimeEnvironment(process.env, false);
  const knowledge = await loadKnowledge();

  const pdfKnowledgeBase = createPdfKnowledgeBase();
  await pdfKnowledgeBase.rebuild();

  // Do not start the filesystem polling watcher in a serverless function.
  const configuredAIProviders = getConfiguredAIProviders();

  const rateLimiter = await createRequestRateLimiter(process.env.REDIS_URL);
  let knowledgeSearch: ReturnType<typeof createKnowledgeSearch>;
  try {
    knowledgeSearch = createKnowledgeSearch();
  } catch (error) {
    logEvent('serverless.dependency.initialization_failed', { dependency: 'postgres_retrieval', errorType: error instanceof Error ? error.name : 'unknown' }, 'warn');
    knowledgeSearch = undefined;
  }
  let documentService: ReturnType<typeof createDocumentService>;
  try {
    documentService = createDocumentService();
  } catch (error) {
    logEvent('serverless.dependency.initialization_failed', { dependency: 'document_ingestion', errorType: error instanceof Error ? error.name : 'unknown' }, 'warn');
    documentService = undefined;
  }
  const databaseHealthCheck = createDatabaseHealthCheck();

  const streamAI: TextStream = async function* (
    query,
    verifiedGuidance,
    abortSignal,
    retrievedKnowledge,
    history,
    attachment,
    selectedModel
  ) {
    const namespaced = selectedModel
      ? splitNamespacedModel(selectedModel)
      : undefined;

    const provider =
      namespaced?.provider ??
      configuredAIProviders[0]?.provider ??
      'openrouter';

    if (provider === 'gemini') {
      yield* streamGeminiText(
        query,
        verifiedGuidance,
        abortSignal,
        retrievedKnowledge,
        history,
        attachment,
        undefined,
        namespaced?.model
      );
    } else {
      yield* streamOpenAICompatible(
        query,
        verifiedGuidance,
        abortSignal,
        retrievedKnowledge,
        history,
        attachment,
        selectedModel
      );
    }
  };

  return createApp(
    knowledge,
    configuredAIProviders.length ? streamAI : undefined,
    knowledgeSearch?.search,
    rateLimiter,
    pdfKnowledgeBase,
    documentService,
    databaseHealthCheck
  );
}

function getApp(): Promise<Express> {
  if (!appPromise) {
    appPromise = buildApp().catch((error) => {
      appPromise = undefined;
      throw error;
    });
  }

  return appPromise;
}

export default async function handler(
  request: Request,
  response: Response
) {
  try {
    const app = await getApp();
    return app(request, response);
  } catch (error) {
    logEvent('serverless.initialization.failed', { errorType: error instanceof Error ? error.name : 'unknown' }, 'error');

    if (!response.headersSent) {
      return response.status(500).json({
        error: 'The support service could not initialize. Please try again later.',
      });
    }

    return response.end();
  }
}
