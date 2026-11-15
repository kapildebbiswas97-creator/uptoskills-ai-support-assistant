import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createApp } from './app';
import { loadKnowledge } from './assistant';
import type { AuthenticatedPrincipal } from './auth';
import {
  EscalationServiceError,
  escalationRequestHash,
  isValidStatusTransition,
  type EscalationCreateInput,
  type EscalationPage,
  type EscalationService,
  type EscalationStatus,
  type EscalationTicket,
} from './escalations';
import { ESCALATION_CONSENT_VERSION } from '../src/utils/escalationConsent';

const envNames = ['NODE_ENV', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL', 'AUTH_ROLE_MAPPING'] as const;
type EnvSnapshot = Record<typeof envNames[number], string | undefined>;

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve()));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryEscalationService implements EscalationService {
  readonly records: EscalationTicket[] = [];
  readonly auditEvents: Array<{ action: string; actorId: string; resourceId: string; metadata?: Record<string, unknown> }> = [];
  failCreate = false;

  async create(principal: AuthenticatedPrincipal, input: EscalationCreateInput, idempotencyKey: string) {
    if (this.failCreate) throw new Error('DATABASE_UNAVAILABLE');
    const old = this.records.find((ticket) => ticket.requesterId === principal.subject && ticket.tenantId === (principal.tenantId ?? null) && ticket.idempotencyKey === idempotencyKey);
    const requestHash = escalationRequestHash(input);
    if (old) {
      if (old.requestHash !== requestHash) throw new EscalationServiceError('IDEMPOTENCY_CONFLICT');
      return { ticket: clone(old), duplicate: true };
    }
    const now = new Date();
    const ticket: EscalationTicket = {
      _id: `ticket-${this.records.length + 1}`,
      reference: `UTS-${String(this.records.length + 1).padStart(36, '0')}`,
      tenantId: principal.tenantId ?? null,
      requesterId: principal.subject,
      conversationId: input.conversationId ?? null,
      subject: input.subject,
      description: input.description,
      category: input.category ?? null,
      consent: { accepted: true, version: input.consent.version, text: 'test consent wording', at: now },
      status: 'open', version: 1,
      statusHistory: [{ from: null, to: 'open', actorId: principal.subject, actorRole: 'requester', changedAt: now }],
      internalNotes: [], idempotencyKey, requestHash, resolvedAt: null, createdAt: now, updatedAt: now,
    };
    this.records.push(ticket);
    this.auditEvents.push({ action: 'escalation.created', actorId: principal.subject, resourceId: ticket._id, metadata: { status: 'open' } });
    return { ticket: clone(ticket), duplicate: false };
  }

  private page(records: EscalationTicket[], page: number, pageSize: number): { tickets: EscalationTicket[]; pagination: EscalationPage } {
    const offset = (page - 1) * pageSize;
    return { tickets: clone(records.slice(offset, offset + pageSize)), pagination: { page, pageSize, total: records.length } };
  }

  async listMine(principal: AuthenticatedPrincipal, page: number, pageSize: number) {
    return this.page(this.records.filter((ticket) => ticket.requesterId === principal.subject && ticket.tenantId === (principal.tenantId ?? null)), page, pageSize);
  }

  async getMine(principal: AuthenticatedPrincipal, ticketId: string) {
    const ticket = this.records.find((item) => item._id === ticketId && item.requesterId === principal.subject && item.tenantId === (principal.tenantId ?? null));
    return ticket ? clone(ticket) : null;
  }

  async listQueue(principal: AuthenticatedPrincipal, status: EscalationStatus | undefined, page: number, pageSize: number) {
    return this.page(this.records.filter((ticket) => ticket.tenantId === (principal.tenantId ?? null) && (!status || ticket.status === status)), page, pageSize);
  }

  async getForHr(principal: AuthenticatedPrincipal, ticketId: string) {
    const ticket = this.records.find((item) => item._id === ticketId && item.tenantId === (principal.tenantId ?? null));
    return ticket ? clone(ticket) : null;
  }

  async updateStatus(principal: AuthenticatedPrincipal, ticketId: string, status: EscalationStatus, expectedVersion: number) {
    const ticket = this.records.find((item) => item._id === ticketId && item.tenantId === (principal.tenantId ?? null));
    if (!ticket) throw new EscalationServiceError('NOT_FOUND');
    if (ticket.version !== expectedVersion) throw new EscalationServiceError('VERSION_CONFLICT');
    if (!isValidStatusTransition(ticket.status, status)) throw new EscalationServiceError('INVALID_TRANSITION');
    const previous = ticket.status;
    const now = new Date();
    ticket.status = status;
    ticket.version += 1;
    ticket.updatedAt = now;
    if (status === 'resolved') ticket.resolvedAt = now;
    ticket.statusHistory.push({ from: previous, to: status, actorId: principal.subject, actorRole: 'support_agent', changedAt: now });
    this.auditEvents.push({ action: status === 'resolved' ? 'escalation.resolved' : status === 'closed' ? 'escalation.closed' : 'escalation.status_changed', actorId: principal.subject, resourceId: ticket._id, metadata: { from: previous, to: status } });
    return clone(ticket);
  }

  async addNote(principal: AuthenticatedPrincipal, ticketId: string, content: string, expectedVersion: number) {
    const ticket = this.records.find((item) => item._id === ticketId && item.tenantId === (principal.tenantId ?? null));
    if (!ticket) throw new EscalationServiceError('NOT_FOUND');
    if (ticket.version !== expectedVersion) throw new EscalationServiceError('VERSION_CONFLICT');
    const now = new Date();
    ticket.version += 1;
    ticket.updatedAt = now;
    ticket.internalNotes.push({ id: `note-${ticket.internalNotes.length + 1}`, authorId: principal.subject, createdAt: now, content });
    this.auditEvents.push({ action: 'escalation.internal_note_created', actorId: principal.subject, resourceId: ticket._id, metadata: { noteAdded: true } });
    return clone(ticket);
  }
}

test('escalation APIs authenticate signed principals, scope ownership and tenant, and keep HR notes private', async (t) => {
  const previous: EnvSnapshot = Object.fromEntries(envNames.map((name) => [name, process.env[name]])) as EnvSnapshot;
  process.env.NODE_ENV = 'test';
  const keys = await generateKeyPair('RS256', { modulusLength: 2048 });
  const publicJwk = await exportJWK(keys.publicKey) as JWK;
  publicJwk.kid = 'escalation-test-key';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwksServer = createServer((request, response) => {
    if (request.url !== '/jwks') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' });
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  const issuer = await listen(jwksServer);
  process.env.AUTH_ISSUER = issuer;
  process.env.AUTH_AUDIENCE = 'escalation-api-test';
  process.env.AUTH_JWKS_URL = `${issuer}/jwks`;
  process.env.AUTH_ROLE_MAPPING = JSON.stringify({ applicant: 'user', trusted_hr_group: 'support_agent', platform_admin: 'admin' });

  const service = new MemoryEscalationService();
  const app = createApp(await loadKnowledge(), undefined, undefined, undefined, undefined, undefined, undefined, { escalationService: service });
  const apiServer = createServer(app);
  const baseUrl = await listen(apiServer);
  t.after(async () => {
    await closeServer(apiServer);
    await closeServer(jwksServer);
    for (const name of envNames) {
      const value = previous[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  const token = async (subject: string, role: 'applicant' | 'trusted_hr_group' | 'platform_admin', tenant: string) => new SignJWT({ roles: [role], org_id: tenant })
    .setProtectedHeader({ alg: 'RS256', kid: 'escalation-test-key' })
    .setIssuer(issuer).setAudience('escalation-api-test').setSubject(subject)
    .setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const requesterA = await token('requester-a', 'applicant', 'tenant-a');
  const requesterB = await token('requester-b', 'applicant', 'tenant-b');
  const hr = await token('hr-1', 'trusted_hr_group', 'tenant-a');
  const adminOnly = await token('platform-admin', 'platform_admin', 'tenant-a');
  const send = (path: string, init: RequestInit = {}, accessToken?: string) => fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...init.headers },
  });
  const payload = {
    subject: 'Help with my application',
    description: 'I need help understanding the next step in my application.',
    consent: { accepted: true, version: ESCALATION_CONSENT_VERSION },
  };

  const noAuth = await send('/api/escalations', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(noAuth.status, 401);
  const invalidToken = await send('/api/escalations/mine', {}, 'not-a-jwt');
  assert.equal(invalidToken.status, 401);

  const missingConsent = await send('/api/escalations', { method: 'POST', body: JSON.stringify({ ...payload, consent: { accepted: false, version: ESCALATION_CONSENT_VERSION } }) }, requesterA);
  assert.equal(missingConsent.status, 400);
  const identityInjection = await send('/api/escalations', { method: 'POST', headers: { 'Idempotency-Key': 'identity_injection_key_1' }, body: JSON.stringify({ ...payload, requesterId: 'victim' }) }, requesterA);
  assert.equal(identityInjection.status, 400);
  const missingKey = await send('/api/escalations', { method: 'POST', body: JSON.stringify(payload) }, requesterA);
  assert.equal(missingKey.status, 400);
  const oversized = await send('/api/escalations', { method: 'POST', headers: { 'Idempotency-Key': 'oversized_payload_key_1' }, body: JSON.stringify({ ...payload, description: 'x'.repeat(20_000) }) }, requesterA);
  assert.equal(oversized.status, 413);

  const createResponse = await send('/api/escalations', { method: 'POST', headers: { 'Idempotency-Key': 'requester_a_create_key_1' }, body: JSON.stringify(payload) }, requesterA);
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json() as { ticket: Record<string, unknown> }).ticket;
  const ticketId = String(created.id);
  const ticketReference = String(created.reference);
  assert.match(ticketReference, /^UTS-[A-F0-9]{36}$/);
  assert.equal(created.status, 'open');
  assert.equal('requesterId' in created, false);
  assert.equal('tenantId' in created, false);
  assert.equal('internalNotes' in created, false);

  const repeated = await send('/api/escalations', { method: 'POST', headers: { 'Idempotency-Key': 'requester_a_create_key_1' }, body: JSON.stringify(payload) }, requesterA);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.headers.get('idempotency-replayed'), 'true');
  assert.equal((await repeated.json() as { ticket: { reference: string } }).ticket.reference, ticketReference);
  assert.equal(service.records.length, 1);
  const changedRetry = await send('/api/escalations', { method: 'POST', headers: { 'Idempotency-Key': 'requester_a_create_key_1' }, body: JSON.stringify({ ...payload, subject: 'A different valid issue' }) }, requesterA);
  assert.equal(changedRetry.status, 409);

  const tenantBTicketResponse = await send('/api/escalations', { method: 'POST', headers: { 'Idempotency-Key': 'requester_b_create_key_1' }, body: JSON.stringify(payload) }, requesterB);
  assert.equal(tenantBTicketResponse.status, 201);
  const tenantBTicket = (await tenantBTicketResponse.json() as { ticket: { id: string } }).ticket;
  const mine = await send('/api/escalations/mine?page=1&pageSize=10', {}, requesterA);
  assert.equal(mine.status, 200);
  assert.equal((await mine.json() as { tickets: unknown[] }).tickets.length, 1);
  assert.equal((await send(`/api/escalations/mine/${encodeURIComponent(tenantBTicket.id)}`, {}, requesterA)).status, 404);
  assert.equal((await send('/api/escalations/admin/escalations', {}, requesterA)).status, 403);
  assert.equal((await send('/api/escalations/admin/escalations', {}, adminOnly)).status, 403);

  const queue = await send('/api/escalations/admin/escalations?status=open&page=1&pageSize=20', {}, hr);
  assert.equal(queue.status, 200);
  const queueBody = await queue.json() as { tickets: Array<{ id: string; requesterId: string }> };
  assert.equal(queueBody.tickets.length, 1);
  assert.equal(queueBody.tickets[0]?.id, ticketId);
  assert.equal(queueBody.tickets[0]?.requesterId, 'requester-a');
  assert.equal((await send(`/api/escalations/admin/escalations/${encodeURIComponent(tenantBTicket.id)}`, {}, hr)).status, 404);

  const invalidTransition = await send(`/api/escalations/admin/escalations/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed', expectedVersion: 1 }) }, hr);
  assert.equal(invalidTransition.status, 409);
  const updatedResponse = await send(`/api/escalations/admin/escalations/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ status: 'in_progress', expectedVersion: 1 }) }, hr);
  assert.equal(updatedResponse.status, 200);
  const updated = (await updatedResponse.json() as { ticket: { version: number; status: string } }).ticket;
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.version, 2);
  const staleUpdate = await send(`/api/escalations/admin/escalations/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved', expectedVersion: 1 }) }, hr);
  assert.equal(staleUpdate.status, 409);

  const noteResponse = await send(`/api/escalations/admin/escalations/${ticketId}/notes`, { method: 'POST', body: JSON.stringify({ content: 'Reviewed the supplied information.', expectedVersion: 2 }) }, hr);
  assert.equal(noteResponse.status, 201);
  const hrDetail = (await send(`/api/escalations/admin/escalations/${ticketId}`, {}, hr).then((response) => response.json()) as { ticket: { internalNotes: Array<{ content: string }> } }).ticket;
  assert.equal(hrDetail.internalNotes[0]?.content, 'Reviewed the supplied information.');
  const requesterDetailResponse = await send(`/api/escalations/mine/${ticketId}`, {}, requesterA);
  assert.equal(requesterDetailResponse.status, 200);
  const requesterDetail = (await requesterDetailResponse.json() as { ticket: Record<string, unknown> }).ticket;
  assert.equal('internalNotes' in requesterDetail, false);
  assert.equal(JSON.stringify(requesterDetail).includes('Reviewed the supplied information.'), false);

  assert.deepEqual(service.auditEvents.map(({ action }) => action), [
    'escalation.created', 'escalation.created', 'escalation.status_changed', 'escalation.internal_note_created',
  ]);
  assert.equal(service.auditEvents[2]?.actorId, 'hr-1');
  assert.deepEqual(service.auditEvents[2]?.metadata, { from: 'open', to: 'in_progress' });

  service.failCreate = true;
  const failure = await send('/api/escalations', { method: 'POST', headers: { 'Idempotency-Key': 'db_failure_retry_key_1' }, body: JSON.stringify(payload) }, requesterA);
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /DATABASE_UNAVAILABLE|stack|server\/escalations/i);
  assert.equal(service.records.length, 2);
});
