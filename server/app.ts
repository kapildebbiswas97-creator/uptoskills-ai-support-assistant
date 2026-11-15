import express, { type Express, type Request } from 'express';
import { answerFromKnowledge, LocalKnowledge, resolveVerifiedAudience } from './assistant.js';
import type { AssistantReplyResult } from '../src/utils/assistantEngine';
import type { KnowledgeSearch } from './database.js';
import type { RequestRateLimiter } from './rate-limit.js';
import type { ChatHistoryTurn, PdfAttachmentPayload } from '../src/types/assistant.js';
import type { PdfKnowledgeBase } from './knowledge-base.js';
import { extractPdfText } from './knowledge-base.js';
import { getAIProviderConfig, getConfiguredAIProviders, namespacedModel } from './ai-provider.js';
import { getAllConfiguredModelCatalog, validateModelChoice } from './model-catalog.js';
import { authenticationMiddleware } from './auth.js';
import { requirePrincipal, requireRole } from './auth.js';
import { requiresAuthenticatedChat } from './environment.js';
import type { DocumentService } from './document-ingestion.js';
import { MAX_DOCUMENT_BYTES } from './document-ingestion.js';
import { collection, conversationScope, getMongoDatabase, saveConversationTurn, type ConversationRecord, type MessageRecord } from './mongodb.js';
import { filterUnverifiedCitations, validateAndAppendCitations } from './rag.js';
import { logEvent, requestObservabilityMiddleware } from './observability.js';
import { deploymentRequiresReadiness, isApplicationHealthDegraded, type DatabaseHealthCheck } from './health.js';
import { createEscalationRouter } from './escalation-routes.js';
import { createMongoEscalationService, type EscalationService } from './escalations.js';
import { createMeetingRequestRouter } from './meeting-request-routes.js';
import { createMongoMeetingRequestService, type MeetingRequestService } from './meeting-requests.js';
import { randomUUID } from 'node:crypto';
import { createRequestBodyParser } from './request-body.js';

const MAX_PDF_BYTES = 3 * 1024 * 1024;
const MAX_MODEL_OUTPUT_CHARS = 24_000;

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

function parseConversationId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) return null;
  return value;
}

async function persistConversation(
  request: Request,
  conversationId: string | undefined,
  query: string,
  answer: string,
  source: 'model' | 'local' | 'local-fallback'
): Promise<string | undefined> {
  if (!request.principal) return undefined;
  try {
    return await saveConversationTurn(await getMongoDatabase(), request.principal, conversationId, query, answer, source);
  } catch (error) {
    logEvent('conversation.persistence.failed', { requestId: request.requestId, errorType: error instanceof Error ? error.name : 'unknown' }, 'warn');
    // Keep chat available during an operational database outage; no client history is treated as persisted.
    return undefined;
  }
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
  pdfKnowledgeBase?: PdfKnowledgeBase,
  documentService?: DocumentService,
  databaseHealthCheck?: DatabaseHealthCheck,
  options: { requireChatAuthentication?: boolean; escalationService?: EscalationService; meetingRequestService?: MeetingRequestService } = {}
): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(createRequestBodyParser());
  app.use(requestObservabilityMiddleware);
  app.use(authenticationMiddleware);
  const requireChatAuthentication = options.requireChatAuthentication ?? requiresAuthenticatedChat();

  app.get('/api/session', (request, response) => {
    const principal = requirePrincipal(request, response);
    if (!principal) return;
    response.json({ roles: principal.roles });
  });

  app.use('/api/escalations', createEscalationRouter(options.escalationService ?? createMongoEscalationService(), rateLimiter));
  app.use('/api', createMeetingRequestRouter(options.meetingRequestService ?? createMongoMeetingRequestService(), rateLimiter));

  app.get('/api/models', async (_request, response) => {
    if (requireChatAuthentication && !requirePrincipal(_request, response)) return;
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
    } catch (error) {
      logEvent('ai.model_catalog.failed', { requestId: _request.requestId, errorType: error instanceof Error ? error.name : 'unknown' }, 'warn');
      const defaultModel = namespacedModel(config.provider, config.model);
      response.json({ models: [{ id: defaultModel, name: `${config.model} Â· ${config.providerLabel}`, description: 'Model catalog unavailable. Check provider setup and current plan limits.', contextLength: null }], defaultModel, catalog: 'configured-default', modelAvailable: configuredProviders.length > 0 });
    }
  });

  app.get('/api/health', async (_request, response) => {
    const started = performance.now();
    const databases = databaseHealthCheck ? await databaseHealthCheck.check() : undefined;
    const modelAvailable = Boolean(textStream);
    const authenticationConfigured = Boolean(process.env.AUTH_ISSUER && process.env.AUTH_AUDIENCE && process.env.AUTH_ROLE_MAPPING);
    const unhealthy = isApplicationHealthDegraded(databases, modelAvailable, authenticationConfigured);
    logEvent('health.check.complete', { requestId: _request.requestId, status: unhealthy ? 'degraded' : 'ok', mongo: databases?.mongo || 'not_checked', postgres: databases?.postgres || 'not_checked', model: modelAvailable ? 'configured' : 'not_configured', authentication: authenticationConfigured ? 'configured' : 'not_configured', durationMs: Math.round(performance.now() - started) }, unhealthy ? 'warn' : 'info');
    response.status(unhealthy ? 503 : 200).json({
      status: unhealthy ? 'degraded' : 'ok',
      knowledgeVersion: knowledge.version,
      vectorSearch: Boolean(knowledgeSearch),
      rateLimit: rateLimiter?.backend ?? 'none',
      modelAvailable: Boolean(textStream),
      pdfDocuments: pdfKnowledgeBase?.documentCount ?? 0,
      pdfChunks: pdfKnowledgeBase?.chunkCount ?? 0,
      ...(databases ? { databases } : {}),
      ...(deploymentRequiresReadiness() ? { dependencies: { model: modelAvailable ? 'configured' : 'not_configured', authentication: authenticationConfigured ? 'configured' : 'not_configured' } } : {}),
    });
  });

  const checkRateLimit = async (request: Request, response: express.Response) => {
    if (!rateLimiter) return true;
    const address = request.ip || request.socket.remoteAddress || 'unknown';
    if (await rateLimiter.allow(address)) return true;
    logEvent('security.rate_limited', { requestId: request.requestId, method: request.method }, 'warn');
    response.status(429).json({ error: 'Too many requests. Wait a moment and retry.' });
    return false;
  };

  app.get('/api/conversations', async (request, response) => {
    const principal = requirePrincipal(request, response);
    if (!principal) return;
    try {
      const db = await getMongoDatabase();
      const conversations = await collection<ConversationRecord>(db, 'conversations').find({
        ownerId: principal.subject,
        tenantId: principal.tenantId ?? null,
        archivedAt: null,
      }, { projection: { title: 1, createdAt: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(50).toArray();
      return response.json({ conversations });
    } catch {
      return response.status(503).json({ error: 'Conversation history is temporarily unavailable.' });
    }
  });

  app.get('/api/conversations/:conversationId/messages', async (request, response) => {
    const principal = requirePrincipal(request, response);
    if (!principal) return;
    const conversationId = parseConversationId(request.params.conversationId);
    if (!conversationId) return response.status(404).json({ error: 'Conversation not found.' });
    try {
      const db = await getMongoDatabase();
      const scope = conversationScope(principal, conversationId);
      const conversation = await collection<ConversationRecord>(db, 'conversations').findOne(scope, { projection: { _id: 1 } });
      if (!conversation) return response.status(404).json({ error: 'Conversation not found.' });
      const messages = await collection<MessageRecord>(db, 'messages').find({
        conversationId,
        ownerId: principal.subject,
        tenantId: principal.tenantId ?? null,
      }).sort({ createdAt: 1 }).limit(100).toArray();
      return response.json({ messages });
    } catch {
      return response.status(503).json({ error: 'Conversation history is temporarily unavailable.' });
    }
  });

  const knowledgeManager = (request: Request, response: express.Response) => {
    const principal = requirePrincipal(request, response);
    if (!principal) return undefined;
    if (!requireRole(principal, ['knowledge_manager'])) {
      logEvent('security.role_denied', { requestId: request.requestId, method: request.method, role: 'knowledge_manager' }, 'warn');
      response.status(403).json({ error: 'Knowledge manager access is required.' });
      return undefined;
    }
    return principal;
  };

  app.post('/api/documents', async (request, response) => {
    if (!(await checkRateLimit(request, response))) return;
    const principal = knowledgeManager(request, response);
    if (!principal) return;
    if (!documentService) {
      response.status(503).json({ error: 'Document ingestion is not configured.' });
      return;
    }
    const { filename, mediaType, data } = request.body ?? {};
    if (typeof filename !== 'string' || typeof mediaType !== 'string' || typeof data !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4) {
      response.status(400).json({ error: 'Provide a supported filename, media type, and base64 encoded file up to 3 MiB.' });
      return;
    }
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data) {
      response.status(400).json({ error: 'The uploaded file encoding is invalid.' });
      return;
    }
    try {
      response.status(201).json(await documentService.ingest(principal, { filename, mediaType, bytes }));
      } catch (error) {
        const failureCode = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'INGESTION_FAILED';
        logEvent('document.ingestion.failed', { requestId: request.requestId, failureCode, errorType: error instanceof Error ? error.name : 'unknown' }, 'error');
      const code = error instanceof Error ? error.message : '';
      const status = code === 'UNSUPPORTED_DOCUMENT_TYPE' || code === 'INVALID_FILENAME' || code === 'INVALID_DOCUMENT_SIZE' || code === 'INVALID_DOCUMENT' || code === 'ZIP_BOMB' || code === 'EMPTY_DOCUMENT' || code === 'MALWARE_DETECTED'
        ? 400
        : 503;
      response.status(status).json({ error: code === 'SCANNER_UNAVAILABLE'
        ? 'Document ingestion is disabled because the malware scanner is unavailable.'
        : code === 'MALWARE_DETECTED'
          ? 'The document did not pass the safety scan.'
          : status === 400
            ? 'The document is invalid, unsafe, empty, or uses an unsupported format.'
            : 'The document could not be indexed. Its status can be checked and the operation retried.' });
    }
  });

  app.get('/api/documents/:documentId', async (request, response) => {
    const principal = requirePrincipal(request, response);
    if (!principal) return;
    if (!documentService) return response.status(503).json({ error: 'Document service is not configured.' });
    try {
      const result = await documentService.getStatus(principal, request.params.documentId);
      if (!result) return response.status(404).json({ error: 'Document not found.' });
      return response.json(result);
    } catch {
      return response.status(503).json({ error: 'Document status is temporarily unavailable.' });
    }
  });

  app.delete('/api/documents/:documentId', async (request, response) => {
    if (!(await checkRateLimit(request, response))) return;
    const principal = knowledgeManager(request, response);
    if (!principal) return;
    if (!documentService) return response.status(503).json({ error: 'Document service is not configured.' });
    try {
      const deleted = await documentService.delete(principal, request.params.documentId);
      if (!deleted) return response.status(404).json({ error: 'Document not found or deletion is awaiting recovery.' });
      return response.status(204).end();
    } catch (error) {
      logEvent('document.deletion.failed', { requestId: request.requestId, errorType: error instanceof Error ? error.name : 'unknown' }, 'error');
      return response.status(503).json({ error: 'Document deletion is temporarily unavailable.' });
    }
  });

  app.post('/api/chat', async (request, response) => {
    if (requireChatAuthentication && !requirePrincipal(request, response)) return;
    if (!(await checkRateLimit(request, response))) return;
    const message = request.body?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
      response.status(400).json({ error: 'message must be a non-empty string up to 2000 characters' });
      return;
    }
    const query = message.trim();
    const conversationId = parseConversationId(request.body?.conversationId);
    if (conversationId === null) {
      response.status(400).json({ error: 'conversationId must be a short alphanumeric identifier' });
      return;
    }
    const history = parseHistory(request.body?.history);
    const attachment = parsePdfAttachment(request.body?.attachment);
    if (!history) {
      response.status(400).json({ error: 'history must contain up to 12 user or assistant messages of at most 2000 characters each' });
      return;
    }
    if (attachment === null) {
      response.status(400).json({ error: 'attachment must be a valid PDF up to 3 MiB' });
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
    request.ragExecutionId = randomUUID();
    const localAnswer = answerFromKnowledge(query, knowledge, verifiedAudience);
    const retrievedKnowledge: string[] = [];
    if (localAnswer.topicId && localAnswer.content) {
      retrievedKnowledge.push(`[Source: verified knowledge.yaml topic ${localAnswer.topicId}]\n${localAnswer.content}`);
    }
    if (knowledgeSearch) {
      const ragStarted = performance.now();
      try {
        const vectorRecords = await knowledgeSearch(query, new AbortController().signal, request.principal);
        retrievedKnowledge.push(...vectorRecords);
        logEvent('rag.retrieval.complete', { requestId: request.requestId, ragExecutionId: request.ragExecutionId, resultCount: vectorRecords.length, durationMs: Math.round(performance.now() - ragStarted) });
      } catch (error) {
        logEvent('rag.retrieval.failed', { requestId: request.requestId, ragExecutionId: request.ragExecutionId, errorType: error instanceof Error ? error.name : 'unknown', durationMs: Math.round(performance.now() - ragStarted) }, 'warn');
        // YAML and local PDF retrieval remain available when the optional vector store is offline.
      }
    }
    retrievedKnowledge.push(...(pdfKnowledgeBase?.search(query, 4) ?? []));
    if (attachment) {
      try {
        const text = await extractPdfText(Buffer.from(attachment.data, 'base64'));
        if (!text.trim()) throw new Error('The PDF has no extractable text.');
        retrievedKnowledge.push(`[Source: uploaded PDF ${attachment.name}]\n${text.slice(0, 50000)}`);
      } catch (error) {
        if (error instanceof Error && error.message === 'PDF_PROCESSING_UNAVAILABLE') {
          response.status(503).json({ error: 'PDF processing is unavailable in this runtime.' });
        } else {
          response.status(400).json({ error: 'This PDF could not be read. Use a text-based PDF and try again.' });
        }
        return;
      }
    }
    if (!textStream) {
      const citedAnswer = validateAndAppendCitations(localAnswer.content, retrievedKnowledge);
      response.json({ ...localAnswer, content: citedAnswer.answer, citations: citedAnswer.citations, source: 'local' });
      return;
    }

    const abortController = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) abortController.abort();
    });
    try {
      let content = '';
      let showHrButton = false;
      const providerStarted = performance.now();
      for await (const text of textStream(query, localAnswer, abortController.signal, retrievedKnowledge, history, attachment ?? undefined, selectedModel)) {
        if (abortController.signal.aborted) return;
        if (content.length + text.length > MAX_MODEL_OUTPUT_CHARS) throw new Error('OUTPUT_LIMIT');
        content += text;
      }
      logEvent('ai.provider.complete', { requestId: request.requestId, ragExecutionId: request.ragExecutionId, provider: selectedModel?.split('::')[0] || 'default', durationMs: Math.round(performance.now() - providerStarted) });
      content = content.replace(/\[SHOW_HR_BUTTON\]/g, () => {
        showHrButton = true;
        return '';
      }).trim();
      if (!content) content = localAnswer.content;
      const citedAnswer = validateAndAppendCitations(content, retrievedKnowledge);
      content = citedAnswer.answer;
      const requiresHr = /\b(human support|contact hr|speak to (?:a )?(?:person|human|hr)|talk to (?:a )?(?:person|human|hr)|contact (?:a )?(?:person|human|hr))\b/i.test(query);
      const isUpToSkillsRequest = /\b(uptoskills|internship|onboarding|offer letter|attendance|internops|certificate|leave|cohort|policy|hr|intern)\b/i.test(query);
      const source = 'model' as const;
      const savedConversationId = await persistConversation(request, conversationId, query, content, source);
      response.json({
        ...localAnswer,
        content,
        suggestEscalation: localAnswer.suggestEscalation || showHrButton || requiresHr || (isUpToSkillsRequest && retrievedKnowledge.length === 0),
        source,
        citations: citedAnswer.citations,
        ...(savedConversationId ? { conversationId: savedConversationId } : {}),
      });
    } catch (err: unknown) {
      logEvent('ai.provider.failure', { requestId: request.requestId, ragExecutionId: request.ragExecutionId, provider: selectedModel?.split('::')[0] || 'default', errorType: err instanceof Error ? err.name : 'unknown' }, 'error');
      if (!response.headersSent) {
        const errorMsg = err instanceof Error && err.message === 'OUTPUT_LIMIT'
          ? 'The assistant response exceeded the safe output limit. Please narrow the request and retry.'
          : 'The AI request could not complete. Check provider status and configuration, then retry.';
        response.status(502).json({ error: errorMsg });
      }
    }
  });

  app.post('/api/chat/stream', async (request, response) => {
    if (requireChatAuthentication && !requirePrincipal(request, response)) return;
    if (!(await checkRateLimit(request, response))) return;
    const message = request.body?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
      response.status(400).json({ error: 'message must be a non-empty string up to 2000 characters' });
      return;
    }

    const query = message.trim();
    const conversationId = parseConversationId(request.body?.conversationId);
    if (conversationId === null) {
      response.status(400).json({ error: 'conversationId must be a short alphanumeric identifier' });
      return;
    }
    const history = parseHistory(request.body?.history);
    const attachment = parsePdfAttachment(request.body?.attachment);
    if (!history) {
      response.status(400).json({ error: 'history must contain up to 12 user or assistant messages of at most 2000 characters each' });
      return;
    }
    if (attachment === null) {
      response.status(400).json({ error: 'attachment must be a valid PDF up to 3 MiB' });
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
    request.ragExecutionId = randomUUID();
    let localAnswer = answerFromKnowledge(query, knowledge, verifiedAudience);
    const uploadedDocuments: string[] = [];
    if (attachment) {
      try {
        const text = await extractPdfText(Buffer.from(attachment.data, 'base64'));
        if (!text.trim()) throw new Error('The PDF has no extractable text.');
        uploadedDocuments.push(`[Source: uploaded PDF ${attachment.name}]\n${text.slice(0, 50000)}`);
      } catch (error) {
        if (error instanceof Error && error.message === 'PDF_PROCESSING_UNAVAILABLE') {
          response.status(503).json({ error: 'PDF processing is unavailable in this runtime.' });
        } else {
          response.status(400).json({ error: 'This PDF could not be read. Use a text-based PDF and try again.' });
        }
        return;
      }
    }
    const abortController = new AbortController();
    let timedOut = false;
    const requestedTimeout = Number(process.env.CHAT_TIMEOUT_MS || 55_000);
    const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(1000, Math.min(requestedTimeout, 58_000)) : 55_000;
    let rejectTimeout: (reason: Error) => void = () => undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      rejectTimeout(new Error('CHAT_TIMEOUT'));
    }, timeoutMs);
    response.on('close', () => {
      clearTimeout(timeout);
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
      const ragStarted = performance.now();
      try {
        const vectorRecords = await knowledgeSearch(query, abortController.signal, request.principal);
        retrievedKnowledge.push(...vectorRecords);
        logEvent('rag.retrieval.complete', { requestId: request.requestId, ragExecutionId: request.ragExecutionId, resultCount: vectorRecords.length, durationMs: Math.round(performance.now() - ragStarted) });
      } catch (error) {
        logEvent('rag.retrieval.failed', { requestId: request.requestId, ragExecutionId: request.ragExecutionId, errorType: error instanceof Error ? error.name : 'unknown', durationMs: Math.round(performance.now() - ragStarted) }, 'warn');
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

    const send = (event: string, data: unknown, force = false) => {
      if (!abortController.signal.aborted || force) {
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    let content = '';
    let flagBuffer = '';
    let showHrButton = false;
    const hrFlag = '[SHOW_HR_BUTTON]';
    const citationFlag = '[Source:';
    const emitModelText = (text: string, flush = false) => {
      if (content.length + flagBuffer.length + text.length > MAX_MODEL_OUTPUT_CHARS) throw new Error('OUTPUT_LIMIT');
      flagBuffer += text;
      while (true) {
        const flagAt = flagBuffer.indexOf(hrFlag);
        const citationAt = flagBuffer.indexOf(citationFlag);
        if (flagAt >= 0 && (citationAt < 0 || flagAt < citationAt)) {
          const visible = flagBuffer.slice(0, flagAt);
          if (visible) {
            content += visible;
          }
          showHrButton = true;
          flagBuffer = flagBuffer.slice(flagAt + hrFlag.length);
          continue;
        }
        if (citationAt >= 0) {
          const visible = flagBuffer.slice(0, citationAt);
          if (visible) {
            content += visible;
          }
          const citationEnd = flagBuffer.indexOf(']', citationAt + citationFlag.length);
          if (citationEnd < 0) {
            if (flush || flagBuffer.length - citationAt > 600) {
              flagBuffer = '';
              return;
            }
            flagBuffer = flagBuffer.slice(citationAt);
            return;
          }
          // Model-authored citations are discarded; only retrieved source labels are emitted below.
          flagBuffer = flagBuffer.slice(citationEnd + 1);
          continue;
        }
        if (flush) {
          if (flagBuffer) {
            content += flagBuffer;
            flagBuffer = '';
          }
          return;
        }
        let suffixLength = 0;
        const maximum = Math.min(flagBuffer.length, Math.max(hrFlag.length, citationFlag.length) - 1);
        for (let length = 1; length <= maximum; length += 1) {
          const suffix = flagBuffer.slice(-length);
          if (hrFlag.startsWith(suffix) || citationFlag.startsWith(suffix)) suffixLength = length;
        }
        const visible = flagBuffer.slice(0, flagBuffer.length - suffixLength);
        if (visible) {
          content += visible;
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
      const providerStarted = performance.now();
      const source = textStream
        ? textStream(query, localAnswer, abortController.signal, retrievedKnowledge, history, attachment ?? undefined, selectedModel)
        : streamFallback();
      await Promise.race([
        (async () => {
          for await (const text of filterUnverifiedCitations(source)) {
            if (abortController.signal.aborted) return;
            if (text) emitModelText(text);
          }
        })(),
        timeoutPromise,
      ]);
      if (abortController.signal.aborted && !timedOut) return;
      logEvent('ai.provider.complete', { requestId: request.requestId, ragExecutionId: request.ragExecutionId, provider: selectedModel?.split('::')[0] || (textStream ? 'default' : 'local'), durationMs: Math.round(performance.now() - providerStarted) });
      emitModelText('', true);

      if (!content.trim()) content = localAnswer.content;
      const baseContent = content.trim();
      const citedAnswer = validateAndAppendCitations(baseContent, retrievedKnowledge);
      if (/may expose sensitive information|internal instructions/i.test(citedAnswer.answer)) {
        logEvent('security.output_blocked', { requestId: request.requestId, ragExecutionId: request.ragExecutionId, reason: /sensitive information/i.test(citedAnswer.answer) ? 'sensitive_data' : 'internal_prompt' }, 'warn');
      }
      content = citedAnswer.answer;
      // The model stream is buffered until the complete output has passed review.
      if (content) send('delta', { text: content });
      const requiresHr = /\b(human support|contact hr|speak to (?:a )?(?:person|human|hr)|talk to (?:a )?(?:person|human|hr)|contact (?:a )?(?:person|human|hr))\b/i.test(query);
      const isUpToSkillsRequest = /\b(uptoskills|internship|onboarding|offer letter|attendance|internops|certificate|leave|cohort|policy|hr|intern)\b/i.test(query);
      const answerSource = textStream ? 'model' : 'local';
      const savedConversationId = await persistConversation(request, conversationId, query, content, answerSource);
      send('complete', {
        reply: {
          ...localAnswer,
          content,
          suggestEscalation: localAnswer.suggestEscalation || showHrButton || requiresHr || (isUpToSkillsRequest && retrievedKnowledge.length === 0),
        },
        source: answerSource,
        citations: citedAnswer.citations,
        ...(savedConversationId ? { conversationId: savedConversationId } : {}),
      });
      response.end();
      clearTimeout(timeout);
    } catch (streamErr: unknown) {
      clearTimeout(timeout);
      if (abortController.signal.aborted && !timedOut) return;
      if (timedOut) {
        logEvent('ai.provider.timeout', { requestId: request.requestId, ragExecutionId: request.ragExecutionId }, 'error');
        if (!response.writableEnded) {
          send('error', { message: 'The assistant request timed out. Please retry.' }, true);
          response.end();
        }
        return;
      }
      logEvent('ai.provider.failure', { requestId: request.requestId, ragExecutionId: request.ragExecutionId, provider: selectedModel?.split('::')[0] || 'default', errorType: streamErr instanceof Error ? streamErr.name : 'unknown' }, 'error');
      const streamErrorMsg = streamErr instanceof Error && streamErr.message === 'OUTPUT_LIMIT'
        ? 'The assistant response exceeded the safe output limit. Please narrow the request and retry.'
        : 'The AI request could not complete. Check provider status and configuration, then retry.';
      if (!content && (attachment || requiresModel(query))) {
        send('error', { message: streamErrorMsg });
        response.end();
        return;
      }
      if (!content) {
        for await (const text of streamFallback()) {
          if (abortController.signal.aborted) return;
          content += text;
        }
        const citedAnswer = validateAndAppendCitations(content, retrievedKnowledge);
        content = citedAnswer.answer;
        if (content) send('delta', { text: content });
        const savedConversationId = await persistConversation(request, conversationId, query, content, 'local-fallback');
        send('complete', { reply: { ...localAnswer, content }, citations: citedAnswer.citations, source: 'local-fallback', ...(savedConversationId ? { conversationId: savedConversationId } : {}) });
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
