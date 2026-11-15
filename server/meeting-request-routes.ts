import express, { type Request, type Router } from 'express';
import { requirePrincipal, requireRole } from './auth.js';
import { logEvent } from './observability.js';
import type { RequestRateLimiter } from './rate-limit';
import {
  MEETING_REQUEST_STATUSES, MeetingRequestError, validateConfirmationInput,
  validateMeetingIdempotencyKey, validateMeetingRequestInput,
  type MeetingRequestRecord, type MeetingRequestService, type MeetingRequestStatus,
} from './meeting-requests.js';

const PAGE_SIZE_MAX = 50;
function requesterDto(record: MeetingRequestRecord) {
  return {
    id: record._id, reference: record.reference, subject: record.subject, purpose: record.purpose,
    preferredTimes: record.preferredTimes, timeZone: record.timeZone, conversationId: record.conversationId,
    status: record.status, version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt,
    statusHistory: record.statusHistory.map(({ from, to, at }) => ({ from, to, at })),
    confirmation: record.confirmation ? { startAt: record.confirmation.startAt, endAt: record.confirmation.endAt, timeZone: record.confirmation.timeZone, location: record.confirmation.location ?? null, confirmedAt: record.confirmation.confirmedAt } : null,
    rejectionReason: record.status === 'rejected' ? record.rejectionReason : null,
  };
}
function summaryDto(record: MeetingRequestRecord) {
  return { id: record._id, reference: record.reference, subject: record.subject, status: record.status, timeZone: record.timeZone, createdAt: record.createdAt, updatedAt: record.updatedAt, version: record.version, ...(record.confirmation ? { confirmedStartAt: record.confirmation.startAt } : {}) };
}
function hrDto(record: MeetingRequestRecord) {
  return { ...requesterDto(record), tenantId: record.tenantId, requesterId: record.requesterId, statusHistory: record.statusHistory.map((item) => ({ ...item })), confirmation: record.confirmation ? { ...record.confirmation } : null };
}
function pagination(request: Request) {
  const pageText = request.query.page === undefined ? '1' : typeof request.query.page === 'string' ? request.query.page : '';
  const sizeText = request.query.pageSize === undefined ? '20' : typeof request.query.pageSize === 'string' ? request.query.pageSize : '';
  if (!/^\d{1,5}$/.test(pageText) || !/^\d{1,2}$/.test(sizeText)) return undefined;
  const page = Number(pageText), pageSize = Number(sizeText);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10_000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) return undefined;
  return { page, pageSize };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function respondError(response: express.Response, error: unknown, requestId?: string) {
  if (error instanceof MeetingRequestError) {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'VERSION_CONFLICT' || error.code === 'INVALID_TRANSITION' || error.code === 'IDEMPOTENCY_CONFLICT' ? 409
      : error.code === 'INVALID_REQUEST' || error.code.startsWith('INVALID_') || error.code.endsWith('_REQUIRED') || error.code === 'PAST_PREFERENCE' || error.code === 'PAST_CONFIRMATION' ? 400 : 503;
    const messages: Record<string, string> = {
      INVALID_REQUEST: 'The request fields are invalid.', INVALID_SUBJECT: 'Subject must be 5–120 characters.', INVALID_PURPOSE: 'Purpose must be 10–2000 characters.',
      INVALID_TIMEZONE: 'Provide a valid IANA time zone.', INVALID_PREFERENCES: 'Provide one to three valid preferred time ranges.',
      INVALID_DATETIME: 'Use ISO 8601 date-time values with an explicit UTC offset, such as 2026-12-01T09:00:00+05:30.',
      PAST_PREFERENCE: 'Preferred meeting times must be in the future.', PAST_CONFIRMATION: 'Confirmed meeting time must be in the future.',
      INVALID_TIME_RANGE: 'End time must be later than start time.', INVALID_CONVERSATION: 'The conversation reference is invalid.',
      CONVERSATION_NOT_FOUND: 'The referenced conversation was not found.', IDEMPOTENCY_KEY_REQUIRED: 'A valid Idempotency-Key header is required.',
      IDEMPOTENCY_CONFLICT: 'This retry key was already used with different request details.', INVALID_TRANSITION: 'This request is no longer pending and cannot be changed.',
      VERSION_CONFLICT: 'The request changed. Refresh it and try again.', INVALID_LOCATION: 'Location details may not exceed 500 characters.',
      NOT_FOUND: 'Meeting request not found.', INVALID_REASON: 'Provide a rejection explanation between 3 and 1000 characters.',
    };
    logEvent('meeting_request.operation.rejected', { requestId, reason: error.code, status }, status >= 500 ? 'error' : 'warn');
    return response.status(status).json({ error: messages[error.code] || 'The meeting request could not be completed.' });
  }
  logEvent('meeting_request.operation.failed', { requestId, errorType: error instanceof Error ? error.name : 'unknown' }, 'error');
  return response.status(503).json({ error: 'Meeting request service is temporarily unavailable.' });
}

export function createMeetingRequestRouter(service: MeetingRequestService, rateLimiter?: RequestRateLimiter): Router {
  const router = express.Router();
  const hrPrincipal = (request: Request, response: express.Response) => {
    const principal = requirePrincipal(request, response);
    if (!principal) return undefined;
    if (!requireRole(principal, ['support_agent'], { includeAdministrators: false })) {
      logEvent('security.meeting_request_hr_denied', { requestId: request.requestId, method: request.method, actorId: principal.subject, actorRoles: principal.roles.join(','), scope: principal.tenantId ?? 'tenantless' }, 'warn');
      response.status(403).json({ error: 'Authorised support staff access is required.' });
      return undefined;
    }
    return principal;
  };
  router.post('/meeting-requests', async (request, response) => {
    const principal = requirePrincipal(request, response); if (!principal) return;
    try {
      if (rateLimiter) {
        const address = request.ip || request.socket.remoteAddress || 'unknown';
        if (!(await rateLimiter.allow(`meeting:${address}:${principal.subject}`))) return response.status(429).json({ error: 'Too many meeting requests. Wait and retry.' });
      }
      const input = validateMeetingRequestInput(request.body);
      const key = validateMeetingIdempotencyKey(request.header('idempotency-key'));
      const result = await service.create(principal, input, key, request.requestId);
      response.setHeader('Idempotency-Replayed', String(result.duplicate));
      return response.status(result.duplicate ? 200 : 201).json({ request: requesterDto(result.request) });
    } catch (error) { return respondError(response, error, request.requestId); }
  });
  router.get('/meeting-requests/mine', async (request, response) => {
    const principal = requirePrincipal(request, response); if (!principal) return;
    const page = pagination(request); if (!page) return response.status(400).json({ error: 'Pagination must be page 1–10000 and pageSize 1–50.' });
    try { const result = await service.listMine(principal, page.page, page.pageSize); return response.json({ requests: result.requests.map(summaryDto), pagination: result.pagination }); }
    catch (error) { return respondError(response, error, request.requestId); }
  });
  router.get('/meeting-requests/mine/:requestId', async (request, response) => {
    const principal = requirePrincipal(request, response); if (!principal) return;
    try { const record = await service.getMine(principal, request.params.requestId); if (!record) return response.status(404).json({ error: 'Meeting request not found.' }); return response.json({ request: requesterDto(record) }); }
    catch (error) { return respondError(response, error, request.requestId); }
  });
  router.post('/meeting-requests/mine/:requestId/cancel', async (request, response) => {
    const principal = requirePrincipal(request, response); if (!principal) return;
    if (!isRecord(request.body) || Object.keys(request.body).some((key) => key !== 'expectedVersion') || !Number.isSafeInteger(request.body.expectedVersion) || (request.body.expectedVersion as number) < 1) return response.status(400).json({ error: 'Provide only a positive expectedVersion.' });
    try { const record = await service.cancel(principal, request.params.requestId, request.body.expectedVersion as number, request.requestId); return response.json({ request: requesterDto(record) }); }
    catch (error) { return respondError(response, error, request.requestId); }
  });
  router.get('/admin/meeting-requests', async (request, response) => {
    const principal = hrPrincipal(request, response); if (!principal) return;
    const page = pagination(request); if (!page) return response.status(400).json({ error: 'Pagination must be page 1–10000 and pageSize 1–50.' });
    const rawStatus = request.query.status;
    if (rawStatus !== undefined && (typeof rawStatus !== 'string' || !(MEETING_REQUEST_STATUSES as readonly string[]).includes(rawStatus))) return response.status(400).json({ error: `Status must be one of ${MEETING_REQUEST_STATUSES.join(', ')}.` });
    try {
      const result = await service.listForHr(principal, rawStatus as MeetingRequestStatus | undefined, page.page, page.pageSize);
      logEvent('meeting_request.hr_queue_access', { requestId: request.requestId, actorId: principal.subject, actorRoles: principal.roles.join(','), page: page.page, scope: principal.tenantId ?? 'tenantless' }, 'info');
      return response.json({ requests: result.requests.map(summaryDto), pagination: result.pagination });
    } catch (error) { return respondError(response, error, request.requestId); }
  });
  router.get('/admin/meeting-requests/:requestId', async (request, response) => {
    const principal = hrPrincipal(request, response); if (!principal) return;
    try {
      const record = await service.getForHr(principal, request.params.requestId);
      if (!record) return response.status(404).json({ error: 'Meeting request not found.' });
      logEvent('meeting_request.hr_detail_access', { requestId: request.requestId, actorId: principal.subject, actorRoles: principal.roles.join(','), requestReference: record.reference, scope: principal.tenantId ?? 'tenantless' }, 'info');
      return response.json({ request: hrDto(record) });
    }
    catch (error) { return respondError(response, error, request.requestId); }
  });
  router.post('/admin/meeting-requests/:requestId/confirm', async (request, response) => {
    const principal = hrPrincipal(request, response); if (!principal) return;
    if (!isRecord(request.body) || !Object.keys(request.body).every((key) => ['expectedVersion', 'startAt', 'endAt', 'timeZone', 'location'].includes(key)) || !Number.isSafeInteger(request.body.expectedVersion) || (request.body.expectedVersion as number) < 1) return response.status(400).json({ error: 'Provide expectedVersion and actual confirmed schedule details only.' });
    try {
      const details = validateConfirmationInput(Object.fromEntries(Object.entries(request.body).filter(([key]) => key !== 'expectedVersion')));
      const record = await service.confirm(principal, request.params.requestId, details, request.body.expectedVersion as number, request.requestId);
      logEvent('meeting_request.confirmed', { requestId: request.requestId, actorId: principal.subject, requestReference: record.reference, status: record.status }, 'info');
      return response.json({ request: hrDto(record) });
    } catch (error) {
      logEvent('security.meeting_request_decision_failed', { requestId: request.requestId, actorId: principal.subject, actorRoles: principal.roles.join(','), operation: 'confirm', reason: error instanceof MeetingRequestError ? error.code : error instanceof Error ? error.name : 'unknown', scope: principal.tenantId ?? 'tenantless' }, 'warn');
      return respondError(response, error, request.requestId);
    }
  });
  router.post('/admin/meeting-requests/:requestId/reject', async (request, response) => {
    const principal = hrPrincipal(request, response); if (!principal) return;
    if (!isRecord(request.body) || !Object.keys(request.body).every((key) => ['expectedVersion', 'reason'].includes(key)) || !Number.isSafeInteger(request.body.expectedVersion) || (request.body.expectedVersion as number) < 1 || typeof request.body.reason !== 'string' || request.body.reason.trim().length < 3 || request.body.reason.trim().length > 1000) return response.status(400).json({ error: 'Provide expectedVersion and an explanation between 3 and 1000 characters.' });
    try { const record = await service.reject(principal, request.params.requestId, request.body.reason.trim(), request.body.expectedVersion as number, request.requestId); logEvent('meeting_request.rejected', { requestId: request.requestId, actorId: principal.subject, requestReference: record.reference, status: record.status }, 'info'); return response.json({ request: hrDto(record) }); }
    catch (error) {
      logEvent('security.meeting_request_decision_failed', { requestId: request.requestId, actorId: principal.subject, actorRoles: principal.roles.join(','), operation: 'reject', reason: error instanceof MeetingRequestError ? error.code : error instanceof Error ? error.name : 'unknown', scope: principal.tenantId ?? 'tenantless' }, 'warn');
      return respondError(response, error, request.requestId);
    }
  });
  return router;
}
