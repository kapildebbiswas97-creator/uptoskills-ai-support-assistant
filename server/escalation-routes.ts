import express, { type Request, type Response, type Router } from 'express';
import { requirePrincipal, requireRole } from './auth.js';
import { logEvent } from './observability.js';
import type { RequestRateLimiter } from './rate-limit';
import {
  ESCALATION_STATUSES,
  EscalationServiceError,
  isEscalationStatus,
  validateEscalationCreateInput,
  validateIdempotencyKey,
  type EscalationService,
  type EscalationStatus,
  type EscalationTicket,
} from './escalations.js';

const MAX_PAGE_SIZE = 50;

function requesterTicket(ticket: EscalationTicket) {
  return {
    id: ticket._id,
    reference: ticket.reference,
    subject: ticket.subject,
    description: ticket.description,
    category: ticket.category ?? null,
    status: ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    resolvedAt: ticket.resolvedAt,
    version: ticket.version,
    statusHistory: ticket.statusHistory.map(({ from, to, changedAt }) => ({ from, to, changedAt })),
  };
}

function requesterTicketSummary(ticket: EscalationTicket) {
  const { id, reference, subject, category, status, createdAt, updatedAt } = requesterTicket(ticket);
  return { id, reference, subject, category, status, createdAt, updatedAt };
}

function hrTicket(ticket: EscalationTicket) {
  return {
    ...requesterTicket(ticket),
    tenantId: ticket.tenantId,
    requesterId: ticket.requesterId,
    conversationId: ticket.conversationId ?? null,
    consent: ticket.consent,
    internalNotes: ticket.internalNotes.map((note) => ({ ...note })),
    statusHistory: ticket.statusHistory.map((event) => ({ ...event })),
  };
}

function hrTicketSummary(ticket: EscalationTicket) {
  return {
    id: ticket._id,
    reference: ticket.reference,
    subject: ticket.subject,
    category: ticket.category ?? null,
    status: ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    requesterId: ticket.requesterId,
  };
}

function parsePagination(request: Request): { page: number; pageSize: number } | undefined {
  const pageRaw = request.query.page;
  const sizeRaw = request.query.pageSize;
  const pageText = pageRaw === undefined ? '1' : typeof pageRaw === 'string' ? pageRaw : '';
  const sizeText = sizeRaw === undefined ? '20' : typeof sizeRaw === 'string' ? sizeRaw : '';
  if (!/^\d{1,5}$/.test(pageText) || !/^\d{1,2}$/.test(sizeText)) return undefined;
  const page = Number(pageText);
  const pageSize = Number(sizeText);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) return undefined;
  return { page, pageSize };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireHr(request: Request, response: Response) {
  const principal = requirePrincipal(request, response);
  if (!principal) return undefined;
  // Use the existing signed-role model, but do not grant generic platform admins HR access implicitly.
  if (!requireRole(principal, ['support_agent'], { includeAdministrators: false })) {
    logEvent('security.escalation_hr_denied', {
      requestId: request.requestId,
      method: request.method,
      actorId: principal.subject,
      actorRoles: principal.roles.join(','),
      scope: principal.tenantId ?? 'tenantless',
    }, 'warn');
    response.status(403).json({ error: 'Authorised support staff access is required.' });
    return undefined;
  }
  return principal;
}

function respondServiceError(response: Response, error: unknown, requestId?: string): void {
  if (error instanceof EscalationServiceError) {
    const status = error.code === 'NOT_FOUND' || error.code === 'CONVERSATION_NOT_FOUND' ? 404
      : error.code === 'IDEMPOTENCY_CONFLICT' || error.code === 'VERSION_CONFLICT' || error.code === 'INVALID_TRANSITION' ? 409
        : error.code === 'INVALID_REQUEST' || error.code.startsWith('INVALID_') || error.code === 'CONSENT_REQUIRED' || error.code === 'IDEMPOTENCY_KEY_REQUIRED' ? 400
          : 503;
    const messages: Record<string, string> = {
      INVALID_REQUEST: 'The request fields are invalid.',
      INVALID_SUBJECT: 'Provide a subject between 5 and 120 characters.',
      INVALID_DESCRIPTION: 'Provide a description between 10 and 10000 characters.',
      INVALID_CATEGORY: 'The selected category is not supported.',
      INVALID_CONVERSATION: 'The conversation reference is invalid.',
      CONSENT_REQUIRED: 'Explicit consent using the current consent statement is required.',
      IDEMPOTENCY_KEY_REQUIRED: 'A valid Idempotency-Key header is required.',
      IDEMPOTENCY_CONFLICT: 'This retry key was already used with different request details.',
      CONVERSATION_NOT_FOUND: 'The referenced conversation was not found.',
      NOT_FOUND: 'Escalation ticket not found.',
      INVALID_TRANSITION: 'That status transition is not allowed.',
      VERSION_CONFLICT: 'The ticket changed. Refresh it and try again.',
    };
    logEvent('escalation.request.rejected', { requestId, reason: error.code, status }, status >= 500 ? 'error' : 'warn');
    response.status(status).json({ error: messages[error.code] || 'The escalation request could not be completed.' });
    return;
  }
  logEvent('escalation.operation.failed', { requestId, errorType: error instanceof Error ? error.name : 'unknown' }, 'error');
  response.status(503).json({ error: 'Escalation service is temporarily unavailable. Retry using the same idempotency key.' });
}

export function createEscalationRouter(service: EscalationService, rateLimiter?: RequestRateLimiter): Router {
  const router = express.Router();

  const allowSubmission = async (request: Request, response: Response, requesterId: string): Promise<boolean> => {
    if (!rateLimiter) return true;
    const address = request.ip || request.socket.remoteAddress || 'unknown';
    if (await rateLimiter.allow(`escalation:${address}:${requesterId}`)) return true;
    logEvent('security.rate_limited', { requestId: request.requestId, route: 'escalation.create' }, 'warn');
    response.status(429).json({ error: 'Too many escalation requests. Wait before retrying.' });
    return false;
  };

  router.post('/', async (request, response) => {
    const principal = requirePrincipal(request, response);
    if (!principal) return;
    try {
      if (!(await allowSubmission(request, response, principal.subject))) return;
      const input = validateEscalationCreateInput(request.body);
      const idempotencyKey = validateIdempotencyKey(request.header('idempotency-key'));
      const result = await service.create(principal, input, idempotencyKey, request.requestId);
      response.setHeader('Idempotency-Replayed', String(result.duplicate));
      response.status(result.duplicate ? 200 : 201).json({ ticket: requesterTicket(result.ticket) });
    } catch (error) {
      respondServiceError(response, error, request.requestId);
    }
  });

  router.get('/mine', async (request, response) => {
    const principal = requirePrincipal(request, response);
    if (!principal) return;
    const pagination = parsePagination(request);
    if (!pagination) return response.status(400).json({ error: 'Pagination must use page 1–100000 and pageSize 1–50.' });
    try {
      const result = await service.listMine(principal, pagination.page, pagination.pageSize);
      return response.json({ tickets: result.tickets.map(requesterTicketSummary), pagination: result.pagination });
    } catch (error) {
      return respondServiceError(response, error, request.requestId);
    }
  });

  router.get('/mine/:ticketId', async (request, response) => {
    const principal = requirePrincipal(request, response);
    if (!principal) return;
    try {
      const ticket = await service.getMine(principal, request.params.ticketId);
      if (!ticket) return response.status(404).json({ error: 'Escalation ticket not found.' });
      return response.json({ ticket: requesterTicket(ticket) });
    } catch (error) {
      return respondServiceError(response, error, request.requestId);
    }
  });

  router.get('/admin/escalations', async (request, response) => {
    const principal = requireHr(request, response);
    if (!principal) return;
    const pagination = parsePagination(request);
    if (!pagination) return response.status(400).json({ error: 'Pagination must use page 1–100000 and pageSize 1–50.' });
    const statusValue = request.query.status;
    let status: EscalationStatus | undefined;
    if (statusValue !== undefined) {
      if (typeof statusValue !== 'string' || !isEscalationStatus(statusValue)) {
        return response.status(400).json({ error: `Status filter must be one of: ${ESCALATION_STATUSES.join(', ')}.` });
      }
      status = statusValue;
    }
    try {
      const result = await service.listQueue(principal, status, pagination.page, pagination.pageSize);
      logEvent('security.escalation_hr_access', { requestId: request.requestId, action: 'queue_read', page: pagination.page }, 'info');
      return response.json({ tickets: result.tickets.map(hrTicketSummary), pagination: result.pagination });
    } catch (error) {
      return respondServiceError(response, error, request.requestId);
    }
  });

  router.get('/admin/escalations/:ticketId', async (request, response) => {
    const principal = requireHr(request, response);
    if (!principal) return;
    try {
      const ticket = await service.getForHr(principal, request.params.ticketId);
      if (!ticket) return response.status(404).json({ error: 'Escalation ticket not found.' });
      logEvent('security.escalation_hr_access', { requestId: request.requestId, action: 'ticket_read' }, 'info');
      return response.json({ ticket: hrTicket(ticket) });
    } catch (error) {
      return respondServiceError(response, error, request.requestId);
    }
  });

  router.patch('/admin/escalations/:ticketId', async (request, response) => {
    const principal = requireHr(request, response);
    if (!principal) return;
    if (!isRecord(request.body) || Object.keys(request.body).some((key) => !['status', 'expectedVersion'].includes(key)) ||
        !isEscalationStatus(request.body.status) || !Number.isSafeInteger(request.body.expectedVersion) || (request.body.expectedVersion as number) < 1) {
      return response.status(400).json({ error: 'Provide only a valid status and expectedVersion.' });
    }
    try {
      const ticket = await service.updateStatus(principal, request.params.ticketId, request.body.status, request.body.expectedVersion as number, request.requestId);
      logEvent('escalation.status.changed', { requestId: request.requestId, status: ticket.status, version: ticket.version }, 'info');
      return response.json({ ticket: hrTicket(ticket) });
    } catch (error) {
      return respondServiceError(response, error, request.requestId);
    }
  });

  router.post('/admin/escalations/:ticketId/notes', async (request, response) => {
    const principal = requireHr(request, response);
    if (!principal) return;
    if (!isRecord(request.body) || Object.keys(request.body).some((key) => !['content', 'expectedVersion'].includes(key)) ||
        typeof request.body.content !== 'string' || request.body.content.trim().length < 1 || request.body.content.trim().length > 5000 ||
        !Number.isSafeInteger(request.body.expectedVersion) || (request.body.expectedVersion as number) < 1) {
      return response.status(400).json({ error: 'Provide note content (1–5000 characters) and expectedVersion.' });
    }
    try {
      const ticket = await service.addNote(principal, request.params.ticketId, request.body.content.trim(), request.body.expectedVersion as number, request.requestId);
      logEvent('escalation.internal_note.created', { requestId: request.requestId, version: ticket.version }, 'info');
      return response.status(201).json({ ticket: hrTicket(ticket) });
    } catch (error) {
      return respondServiceError(response, error, request.requestId);
    }
  });

  return router;
}
