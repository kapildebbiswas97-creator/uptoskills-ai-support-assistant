import express, { type Express, type Request } from 'express';
import { answerFromKnowledge, LocalKnowledge, resolveVerifiedAudience } from './assistant';
import type { AssistantReplyResult } from '../src/utils/assistantEngine';
import type { KnowledgeSearch } from './database';
import type { RequestRateLimiter } from './rate-limit';
import type { ChatHistoryTurn, PdfAttachmentPayload } from '../src/types/assistant';
import type { PdfKnowledgeBase } from './knowledge-base';
import { extractPdfText } from './knowledge-base';
import { getAIProviderConfig, getConfiguredAIProviders, namespacedModel } from './ai-provider';
import { getAllConfiguredModelCatalog, validateModelChoice } from './model-catalog';

const MAX_PDF_BYTES = 3 * 1024 * 1024;

function requiresModel(query: string): boolean {
  return /\b(cod(?:e|ing)|debug|program|python|javascript|typescript|research|search(?: the)? web|look up|latest|current|recent|news|browse online|online sources)\b/i.test(query);
}

function parseHistory(value: unknown): ChatHistoryTurn[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) return undefined;
  const turns: ChatHistoryTurn[] = [];
  for (const turn of value) {
    if (
      typeof turn !== 'object' || turn === null ||
      !('role' in turn) || !['user', 'assistant'].includes(String(turn.role)) ||
      !('content' in turn) || typeof turn.content !== 'string' || turn.content.length > 2000
    ) return undefined;
    turns.push({ role: turn.role as ChatHistoryTurn['role'], content: turn.content });
  }
  return turns;
}

function parsePdfAttachment(value: unknown): PdfAttachmentPayload | undefined | null {
  if (value === undefined || value === null) return value;
  if (
    typeof value !== 'object' || value === null ||
    !('name' in value) || typeof value.name !== 'string' || !value.name.toLowerCase().endsWith('.pdf') || value.name.length > 160 ||
    !('mimeType' in value) || value.mimeType !== 'application/pdf' ||
    !('data' in value) || typeof value.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
  ) return null;
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return null;
  return { name: value.name, mimeType: 'application/pdf', data: value.data };
}

export type TextStream = (
  query: string,
  verifiedGuidance: AssistantReplyResult,
  abortSignal: AbortSignal,
  retrievedKnowledge: string[],
  history: ChatHistoryTurn[],
  attachment?: PdfAttachmentPayload,
  selectedModel?: string
) => AsyncIterable<string>;

export function createApp(
  knowledge: LocalKnowledge,
  textStream?: TextStream,
  knowledgeSearch?: KnowledgeSearch,
  rateLimiter?: RequestRateLimiter,
  pdfKnowledgeBase?: PdfKnowledgeBase
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4.2mb' }));

  app.get('/api/models', async (_request, response) => {
    const configuredProviders = getConfiguredAIProviders();
    const preferredProvider = process.env.AI_PROVIDER;
    const config = configuredProviders.find((provider) => provider.provider === preferredProvider)
      ?? configuredProviders[0]
      ?? getAIProviderConfig();
    if (!configuredProviders.length) {
      response.json({ models: [], defaultModel: '', catalog: 'unconfigured', modelAvailable: false });
      return;
    }
    try {
      let models = await getAllConfiguredModelCatalog();
  if (config.provider === 'ollama' && models.length === 0) {
    response.json({ models: [], defaultModel: '', catalog: 'ollama-unavailable', modelAvailable: false });
    return;
  }
      const providerModels = models.filter((model) => model.id.startsWith(`${config.provider}::`));
      const configuredDefault = namespacedModel(config.provider, config.model);
      const defaultModel = providerModels.some((model) => model.id === configuredDefault)
        ? configuredDefault
        : providerModels[0]?.id ?? models[0]?.id ?? configuredDefault;
      if (!models.length) models = [{ id: defaultModel, name: `${config.model} Â· ${config.providerLabel}`, description: `${config.providerLabel} model catalog unavailable. Check provider setup and current plan limits.`, contextLength: null }];
      response.json({ models, defaultModel, catalog: 'configured-provider-models', modelAvailable: configuredProviders.length > 0 });
    } catch {
      const defaultModel = namespacedModel(config.provider, config.model);
      response.json({ models: [{ id: defaultModel, name: `${config.model} Â· ${config.providerLabel}`, description: 'Model catalog unavailable. Check provider setup and current plan limits.', contextLength: null }], defaultModel, catalog: 'configured-default', modelAvailable: configuredProviders.length > 0 });
    }
  });

  app.get('/api/health', (_request, response) => {
    response.json({
      status: 'ok',
      knowledgeVersion: knowledge.version,
      vectorSearch: Boolean(knowledgeSearch),
      rateLimit: rateLimiter?.backend ?? 'none',
      modelAvailable: Boolean(textStream),
      pdfDocuments: pdfKnowledgeBase?.documentCount ?? 0,
      pdfChunks: pdfKnowledgeBase?.chunkCount ?? 0,
    });
  });

  const checkRateLimit = async (request: Request, response: express.Response) => {
    if (!rateLimiter) return true;
    const address = request.ip || request.socket.remoteAddress || 'unknown';
    if (await rateLimiter.allow(address)) return true;
    response.status(429).json({ error: 'Too many requests. Wait a moment and retry.' });
    return false;
  };

  app.post('/api/chat', async (request, response) => {
    if (!(await checkRateLimit(request, response))) return;
    const message = request.body?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
      response.status(400).json({ error: 'message must be a non-empty string up to 2000 characters' });
      return;
    }
    const query = message.trim();
    const history = parseHistory(request.body?.history);
    const attachment = parsePdfAttachment(request.body?.attachment);
    if (!history) {
      response.status(400).json({ error: 'history must contain up to 12 user or assistant messages of at most 2000 characters each' });
      return;
    }
    if (attachment === null) {
      response.status(400).json({ error: 'attachment must be a valid PDF up to 3 MB' });
      return;
    }
    if (attachment && !textStream) {
      response.status(503).json({ error: 'PDF analysis needs a provider API key. Add OPENROUTER_API_KEY or GEMINI_API_KEY to .env and restart the server.' });
      return;
    }
    if (!textStream && requiresModel(query)) {
      response.status(503).json({ error: 'AI chat, coding help, and research need a provider API key. Add OPENROUTER_API_KEY or GEMINI_API_KEY to .env and restart the server.' });
      return;
    }

    const requestedModel = request.body?.model;
    if (requestedModel !== undefined && (typeof requestedModel !== 'string' || requestedModel.length > 200)) {
      response.status(400).json({ error: 'model must be a valid model ID from the available model list' });
      return;
    }
    let selectedModel: string | undefined;
    if (requestedModel) {
      try {
        const configuredProviders = getConfiguredAIProviders();
        const preferredProvider = process.env.AI_PROVIDER;
        const config = configuredProviders.find((provider) => provider.provider === preferredProvider)
          ?? configuredProviders[0]
          ?? getAIProviderConfig();
        selectedModel = await validateModelChoice(requestedModel, namespacedModel(config.provider, config.model));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'That model is not available from a configured provider. Refresh the model list and choose another.';
        response.status(400).json({ error: msg });
        return;
      }
    } else if (textStream) {
      const configuredProviders = getConfiguredAIProviders();
      const preferredProvider = process.env.AI_PROVIDER;
      const config = configuredProviders.find((provider) => provider.provider === preferredProvider)
        ?? configuredProviders[0]
        ?? getAIProviderConfig();
      selectedModel = namespacedModel(config.provider, config.model);
    }

    const verifiedAudience = resolveVerifiedAudience(request);
    const localAnswer = answerFromKnowledge(query, knowledge, verifiedAudience);
    const retrievedKnowledge: string[] = [];
    if (localAnswer.topicId && localAnswer.content) {
      retrievedKnowledge.push(`[Source: verified knowledge.yaml topic ${localAnswer.topicId}]\n${localAnswer.content}`);
    }
    if (knowledgeSearch) {
      try {
        retrievedKnowledge.push(...await knowledgeSearch(query, new AbortController().signal));
      } catch {
        // YAML and local PDF retrieval remain available when the optional vector store is offline.
      }
    }
    retrievedKnowledge.push(...(pdfKnowledgeBase?.search(query, 4) ?? []));
    if (attachment) {
      try {
        const text = await extractPdfText(Buffer.from(attachment.data, 'base64'));
        if (!text.trim()) throw new Error('The PDF has no extractable text.');
        retrievedKnowledge.push(`[Source: uploaded PDF ${attachment.name}]\n${text.slice(0, 50000)}`);
      } catch {
        response.status(400).json({ error: 'This PDF could not be read. Use a text-based PDF and try again.' });
        return;
      }
    }
    if (!textStream) {
      response.json({ ...localAnswer, source: 'local' });
      return;
    }

    const abortController = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) abortController.abort();
    });
    try {
      let content = '';
      let showHrButton = false;
      for await (const text of textStream(query, localAnswer, abortController.signal, retrievedKnowledge, history, attachment ?? undefined, selectedModel)) {
        if (abortController.signal.aborted) return;
        content += text;
      }
      content = content.replace(/\[SHOW_HR_BUTTON\]/g, () => {
        showHrButton = true;
        return '';
      }).trim();
      if (!content) content = localAnswer.content;
      const requiresHr = /\b(human support|contact hr|speak to (?:a )?(?:person|human|hr)|talk to (?:a )?(?:person|human|hr)|contact (?:a )?(?:person|human|hr))\b/i.test(query);
      const isUpToSkillsRequest = /\b(uptoskills|internship|onboarding|offer letter|attendance|internops|certificate|leave|cohort|policy|hr|intern)\b/i.test(query);
      response.json({
        ...localAnswer,
        content,
        suggestEscalation: localAnswer.suggestEscalation || showHrButton || requiresHr || (isUpToSkillsRequest && retrievedKnowledge.length === 0),
        source: 'model',
      });
    } catch (err: unknown) {
      if (!response.headersSent) {
        const errorMsg = err instanceof Error && err.message
          ? err.message
          : 'The AI request could not complete. Check your provider API key, provider quota, and internet connection, then retry.';
        response.status(502).json({ error: errorMsg });
      }
    }
  });

  app.post('/api/chat/stream', async (request, response) => {
    if (!(await checkRateLimit(request, response))) return;
    const message = request.body?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
      response.status(400).json({ error: 'message must be a non-empty string up to 2000 characters' });
      return;
    }

    const query = message.trim();
    const history = parseHistory(request.body?.history);
    const attachment = parsePdfAttachment(request.body?.attachment);
    if (!history) {
      response.status(400).json({ error: 'history must contain up to 12 user or assistant messages of at most 2000 characters each' });
      return;
    }
    if (attachment === null) {
      response.status(400).json({ error: 'attachment must be a valid PDF up to 3 MB' });
      return;
    }
    if (attachment && !textStream) {
      response.status(503).json({ error: 'PDF analysis needs a provider API key. Add OPENROUTER_API_KEY or GEMINI_API_KEY to .env and restart the server.' });
      return;
    }
    if (!textStream && requiresModel(query)) {
      response.status(503).json({ error: 'AI chat, coding help, and research need a provider API key. Add OPENROUTER_API_KEY or GEMINI_API_KEY to .env and restart the server.' });
      return;
    }

    const requestedModel = request.body?.model;
    if (requestedModel !== undefined && (typeof requestedModel !== 'string' || requestedModel.length > 200)) {
      response.status(400).json({ error: 'model must be a valid model ID from the available model list' });
      return;
    }
    let selectedModel: string | undefined;
    if (requestedModel) {
      try {
        const configuredProviders = getConfiguredAIProviders();
        const preferredProvider = process.env.AI_PROVIDER;
        const config = configuredProviders.find((provider) => provider.provider === preferredProvider)
          ?? configuredProviders[0]
          ?? getAIProviderConfig();
        selectedModel = await validateModelChoice(requestedModel, namespacedModel(config.provider, config.model));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'That model is not available from a configured provider. Refresh the model list and choose another.';
        response.status(400).json({ error: msg });
        return;
      }
    } else if (textStream) {
      const configuredProviders = getConfiguredAIProviders();
      const preferredProvider = process.env.AI_PROVIDER;
      const config = configuredProviders.find((provider) => provider.provider === preferredProvider)
        ?? configuredProviders[0]
        ?? getAIProviderConfig();
      selectedModel = namespacedModel(config.provider, config.model);
    }
    const verifiedAudience = resolveVerifiedAudience(request);
    let localAnswer = answerFromKnowledge(query, knowledge, verifiedAudience);
    const uploadedDocuments: string[] = [];
    if (attachment) {
      try {
        const text = await extractPdfText(Buffer.from(attachment.data, 'base64'));
        if (!text.trim()) throw new Error('The PDF has no extractable text.');
        uploadedDocuments.push(`[Source: uploaded PDF ${attachment.name}]\n${text.slice(0, 50000)}`);
      } catch {
        response.status(400).json({ error: 'This PDF could not be read. Use a text-based PDF and try again.' });
        return;
      }
    }
    const abortController = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) abortController.abort();
    });
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    let retrievedKnowledge: string[] = [];
    if (localAnswer.topicId && localAnswer.content) {
      retrievedKnowledge.push(`[Source: verified knowledge.yaml topic ${localAnswer.topicId}]\n${localAnswer.content}`);
    }
    if (knowledgeSearch) {
      try {
        retrievedKnowledge = await knowledgeSearch(query, abortController.signal);
      } catch {
        // Keep chat available from knowledge.yaml if PostgreSQL or embeddings are unavailable.
      }
    }
    if (pdfKnowledgeBase) {
      retrievedKnowledge.push(...pdfKnowledgeBase.search(query, 4));
    }
    retrievedKnowledge.push(...uploadedDocuments);
    if (!textStream && uploadedDocuments.length) {
      localAnswer = {
        ...localAnswer,
        content: `I found relevant text in the PDF. Add a provider API key to .env to have the assistant analyze and summarize it.\n\n${uploadedDocuments[0].slice(0, 3000)}`,
        suggestEscalation: false,
      };
    }

    const send = (event: string, data: unknown) => {
      if (!abortController.signal.aborted) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    let content = '';
    let flagBuffer = '';
    let showHrButton = false;
    const hrFlag = '[SHOW_HR_BUTTON]';
    const emitModelText = (text: string, flush = false) => {
      flagBuffer += text;
      while (true) {
        const flagAt = flagBuffer.indexOf(hrFlag);
        if (flagAt >= 0) {
          const visible = flagBuffer.slice(0, flagAt);
          if (visible) {
            content += visible;
            send('delta', { text: visible });
          }
          showHrButton = true;
          flagBuffer = flagBuffer.slice(flagAt + hrFlag.length);
          continue;
        }
        if (flush) {
          if (flagBuffer) {
            content += flagBuffer;
            send('delta', { text: flagBuffer });
            flagBuffer = '';
          }
          return;
        }
        let suffixLength = 0;
        const maximum = Math.min(flagBuffer.length, hrFlag.length - 1);
        for (let length = 1; length <= maximum; length += 1) {
          if (hrFlag.startsWith(flagBuffer.slice(-length))) suffixLength = length;
        }
        const visible = flagBuffer.slice(0, flagBuffer.length - suffixLength);
        if (visible) {
          content += visible;
          send('delta', { text: visible });
        }
        flagBuffer = suffixLength ? flagBuffer.slice(-suffixLength) : '';
        return;
      }
    };
    const streamFallback = async function* () {
      const text = localAnswer.content;
      for (let offset = 0; offset < text.length; offset += 48) {
        yield text.slice(offset, offset + 48);
      }
    };

    try {
      const source = textStream
        ? textStream(query, localAnswer, abortController.signal, retrievedKnowledge, history, attachment ?? undefined, selectedModel)
        : streamFallback();
      for await (const text of source) {
        if (abortController.signal.aborted) return;
        if (text) emitModelText(text);
      }
      emitModelText('', true);

      if (!content.trim()) content = localAnswer.content;
      const requiresHr = /\b(human support|contact hr|speak to (?:a )?(?:person|human|hr)|talk to (?:a )?(?:person|human|hr)|contact (?:a )?(?:person|human|hr))\b/i.test(query);
      const isUpToSkillsRequest = /\b(uptoskills|internship|onboarding|offer letter|attendance|internops|certificate|leave|cohort|policy|hr|intern)\b/i.test(query);
      send('complete', {
        reply: {
          ...localAnswer,
          content,
          suggestEscalation: localAnswer.suggestEscalation || showHrButton || requiresHr || (isUpToSkillsRequest && retrievedKnowledge.length === 0),
        },
        source: textStream ? 'model' : 'local',
      });
      response.end();
    } catch (streamErr: unknown) {
      if (abortController.signal.aborted) return;
      const streamErrorMsg = streamErr instanceof Error && streamErr.message
        ? streamErr.message
        : 'The AI request could not complete. Check your provider API key, provider quota, and internet connection, then retry.';
      if (!content && (attachment || requiresModel(query))) {
        send('error', { message: streamErrorMsg });
        response.end();
        return;
      }
      if (!content) {
        for await (const text of streamFallback()) {
          if (abortController.signal.aborted) return;
          content += text;
          send('delta', { text });
        }
        send('complete', { reply: { ...localAnswer, content }, source: 'local-fallback' });
        response.end();
        return;
      }
      send('error', { message: 'The assistant stream failed. Retry the request.' });
      response.end();
    }
  });

  app.use((error: unknown, _request: Request, response: express.Response, _next: express.NextFunction) => {
    if (response.headersSent) return;
    const candidateStatus =
      typeof error === 'object' && error !== null && 'status' in error
        ? Number(error.status)
        : 500;
    const status = candidateStatus >= 400 && candidateStatus < 500 ? candidateStatus : 500;
    response.status(status).json({
      error: status === 413 ? 'Request body is too large' : status < 500 ? 'Invalid request body' : 'Internal server error',
    });
  });

  return app;
}
