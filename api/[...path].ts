import type { Request, Response } from 'express';
import type { Express } from 'express';

import { createApp, type TextStream } from '../server/app';
import { loadKnowledge } from '../server/assistant';
import {
  getConfiguredAIProviders,
  streamOpenAICompatible,
  splitNamespacedModel,
} from '../server/ai-provider';
import { streamGeminiText } from '../server/gemini';
import { createPdfKnowledgeBase } from '../server/knowledge-base';
import { createRequestRateLimiter } from '../server/rate-limit';

let appPromise: Promise<Express> | undefined;

async function buildApp(): Promise<Express> {
  const knowledge = await loadKnowledge();

  const pdfKnowledgeBase = createPdfKnowledgeBase();
  await pdfKnowledgeBase.rebuild();

  // Do not start the filesystem polling watcher in a serverless function.
  const configuredAIProviders = getConfiguredAIProviders();

  const rateLimiter = await createRequestRateLimiter(process.env.REDIS_URL);

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
    undefined,
    rateLimiter,
    pdfKnowledgeBase
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
    console.error('Vercel API initialization failed:', error);

    if (!response.headersSent) {
      return response.status(500).json({
        error: 'The support service could not initialize. Please try again later.',
      });
    }

    return response.end();
  }
}
