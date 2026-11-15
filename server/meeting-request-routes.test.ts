import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createApp } from './app';
import { loadKnowledge } from './assistant';
import type { AuthenticatedPrincipal } from './auth';
import { MeetingRequestError, type MeetingConfirmationInput, type MeetingRequestInput, type MeetingRequestRecord, type MeetingRequestService, type MeetingRequestStatus } from './meeting-requests';

const envNames = ['NODE_ENV', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL', 'AUTH_ROLE_MAPPING'] as const;
type Snapshot = Record<typeof envNames[number], string | undefined>;
function listen(server: Server): Promise<string> { return new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))); }
function close(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function clone<T>(value: T): T { return structuredClone(value); }

class MemoryMeetings implements MeetingRequestService {
  records: MeetingRequestRecord[] = [];
  audits: Array<{ action: string; actorId: string; requestReference: string }> = [];
  failCreate = false;
  async create(principal: AuthenticatedPrincipal, input: MeetingRequestInput, idempotencyKey: string) {
    if (this.failCreate) throw new Error('DATABASE_DOWN');
    const prior = this.records.find((r) => r.requesterId === principal.subject && r.tenantId === (principal.tenantId ?? null) && r.idempotencyKey === idempotencyKey);
    const requestHash = JSON.stringify(input);
    if (prior) { if (prior.requestHash !== requestHash) throw new MeetingRequestError('IDEMPOTENCY_CONFLICT'); return { request: clone(prior), duplicate: true }; }
    const now = new Date();
    const record: MeetingRequestRecord = { _id: `meeting-${this.records.length + 1}`, reference: `UTM-${'A'.repeat(36)}`, tenantId: principal.tenantId ?? null, requesterId: principal.subject, conversationId: input.conversationId ?? null, subject: input.subject, purpose: input.purpose, preferredTimes: clone(input.preferredTimes), timeZone: input.timeZone, status: 'pending', version: 1, statusHistory: [{ from: null, to: 'pending', actorId: principal.subject, actorRole: 'requester', at: now }], confirmation: null, rejectionReason: null, idempotencyKey, requestHash, createdAt: now, updatedAt: now };
    this.records.push(record); this.audits.push({ action: 'meeting_request.created', actorId: principal.subject, requestReference: record.reference }); return { request: clone(record), duplicate: false };
  }
  private page(rows: MeetingRequestRecord[], page: number, pageSize: number) { return { requests: clone(rows.slice((page - 1) * pageSize, page * pageSize)), pagination: { page, pageSize, total: rows.length } }; }
  async listMine(principal: AuthenticatedPrincipal, page: number, pageSize: number) { return this.page(this.records.filter((r) => r.requesterId === principal.subject && r.tenantId === (principal.tenantId ?? null)), page, pageSize); }
  async getMine(principal: AuthenticatedPrincipal, id: string) { const row = this.records.find((r) => r._id === id && r.requesterId === principal.subject && r.tenantId === (principal.tenantId ?? null)); return row ? clone(row) : null; }
  async listForHr(principal: AuthenticatedPrincipal, status: MeetingRequestStatus | undefined, page: number, pageSize: number) { return this.page(this.records.filter((r) => r.tenantId === (principal.tenantId ?? null) && (!status || r.status === status)), page, pageSize); }
  async getForHr(principal: AuthenticatedPrincipal, id: string) { const row = this.records.find((r) => r._id === id && r.tenantId === (principal.tenantId ?? null)); return row ? clone(row) : null; }
  private change(principal: AuthenticatedPrincipal, id: string, expected: number, status: MeetingRequestStatus, extras: { confirmation?: MeetingRequestRecord['confirmation']; rejectionReason?: string | null }) {
    const row = this.records.find((r) => r._id === id && r.tenantId === (principal.tenantId ?? null));
    if (!row) throw new MeetingRequestError('NOT_FOUND');
    if (row.version !== expected) throw new MeetingRequestError('VERSION_CONFLICT');
    if (row.status !== 'pending') throw new MeetingRequestError('INVALID_TRANSITION');
    const from = row.status, now = new Date(); row.status = status; row.version++; row.updatedAt = now;
    if (extras.confirmation !== undefined) row.confirmation = extras.confirmation;
    if (extras.rejectionReason !== undefined) row.rejectionReason = extras.rejectionReason;
    row.statusHistory.push({ from, to: status, actorId: principal.subject, actorRole: principal.roles.includes('support_agent') ? 'support_agent' : 'requester', at: now });
    this.audits.push({ action: `meeting_request.${status}`, actorId: principal.subject, requestReference: row.reference }); return clone(row);
  }
  async confirm(principal: AuthenticatedPrincipal, id: string, details: MeetingConfirmationInput, version: number) { return this.change(principal, id, version, 'confirmed', { confirmation: { ...details, confirmedAt: new Date(), confirmedBy: principal.subject, source: 'hr_manual' } }); }
  async reject(principal: AuthenticatedPrincipal, id: string, reason: string, version: number) { return this.change(principal, id, version, 'rejected', { rejectionReason: reason }); }
  async cancel(principal: AuthenticatedPrincipal, id: string, version: number) { const row = await this.getMine(principal, id); if (!row) throw new MeetingRequestError('NOT_FOUND'); return this.change(principal, id, version, 'cancelled', {}); }
}

test('meeting request HTTP workflow enforces OIDC, ownership, HR decisions and truthful status', async (t) => {
  const prior: Snapshot = Object.fromEntries(envNames.map((key) => [key, process.env[key]])) as Snapshot;
  process.env.NODE_ENV = 'test';
  const keys = await generateKeyPair('RS256', { modulusLength: 2048 });
  const jwk = await exportJWK(keys.publicKey) as JWK; Object.assign(jwk, { kid: 'meeting-test-key', alg: 'RS256', use: 'sig' });
  const jwks = createServer((request, response) => { if (request.url !== '/jwks') return void response.writeHead(404).end(); response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=10' }); response.end(JSON.stringify({ keys: [jwk] })); });
  const issuer = await listen(jwks);
  process.env.AUTH_ISSUER = issuer; process.env.AUTH_AUDIENCE = 'meeting-api'; process.env.AUTH_JWKS_URL = `${issuer}/jwks`;
  process.env.AUTH_ROLE_MAPPING = JSON.stringify({ applicant: 'user', trusted_hr_group: 'support_agent', generic_admin: 'admin' });
  const service = new MemoryMeetings();
  const app = createApp(await loadKnowledge(), undefined, undefined, undefined, undefined, undefined, undefined, { meetingRequestService: service });
  const api = createServer(app); const baseUrl = await listen(api);
  t.after(async () => { await close(api); await close(jwks); for (const key of envNames) { const value = prior[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const token = (subject: string, role: 'applicant' | 'trusted_hr_group' | 'generic_admin', tenant: string) => new SignJWT({ roles: [role], org_id: tenant }).setProtectedHeader({ alg: 'RS256', kid: 'meeting-test-key' }).setIssuer(issuer).setAudience('meeting-api').setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const requester = await token('requester-a', 'applicant', 'tenant-a'), other = await token('requester-b', 'applicant', 'tenant-b');
  const hr = await token('hr-a', 'trusted_hr_group', 'tenant-a'), hrOtherTenant = await token('hr-b', 'trusted_hr_group', 'tenant-b');
  const admin = await token('admin-a', 'generic_admin', 'tenant-a');
  const send = (path: string, init: RequestInit = {}, accessToken?: string) => fetch(`${baseUrl}${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...init.headers } });
  const body = { subject: 'Discuss onboarding steps', purpose: 'Please help me review the required onboarding next steps.', timeZone: 'Asia/Kolkata', preferredTimes: [{ startAt: '2026-12-01T09:00:00+05:30', endAt: '2026-12-01T09:30:00+05:30' }] };

  assert.equal((await send('/api/meeting-requests', { method: 'POST', body: JSON.stringify(body) })).status, 401);
  assert.equal((await send('/api/meeting-requests', { method: 'POST', headers: { 'Idempotency-Key': 'meeting_invalid_key_001' }, body: JSON.stringify({ ...body, timeZone: 'Mars/Colony' }) }, requester)).status, 400);
  assert.equal((await send('/api/meeting-requests', { method: 'POST', headers: { 'Idempotency-Key': 'meeting_offset_key_001' }, body: JSON.stringify({ ...body, preferredTimes: [{ startAt: '2026-12-01T09:00:00', endAt: body.preferredTimes[0]!.endAt }] }) }, requester)).status, 400);
  const createdResponse = await send('/api/meeting-requests', { method: 'POST', headers: { 'Idempotency-Key': 'meeting_create_key_001' }, body: JSON.stringify(body) }, requester);
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json() as { request: Record<string, any> }).request;
  assert.equal(created.status, 'pending'); assert.match(created.reference, /^UTM-[A-F0-9]{36}$/); assert.equal('requesterId' in created, false);
  assert.equal((await send('/api/meeting-requests', { method: 'POST', headers: { 'Idempotency-Key': 'meeting_create_key_001' }, body: JSON.stringify(body) }, requester)).status, 200);
  assert.equal((await send('/api/meeting-requests', { method: 'POST', headers: { 'Idempotency-Key': 'meeting_create_key_001' }, body: JSON.stringify({ ...body, subject: 'Another meeting subject' }) }, requester)).status, 409);
  assert.equal((await send(`/api/meeting-requests/mine/${created.id}`, {}, other)).status, 404);
  assert.equal((await send('/api/meeting-requests/mine', {}, requester)).status, 200);
  assert.equal((await send('/api/admin/meeting-requests', {}, requester)).status, 403);
  assert.equal((await send('/api/admin/meeting-requests', {}, admin)).status, 403);
  const queue = await send('/api/admin/meeting-requests?status=pending', {}, hr); assert.equal(queue.status, 200);
  assert.equal((await queue.json() as { requests: unknown[] }).requests.length, 1);
  assert.equal((await send(`/api/admin/meeting-requests/${created.id}`, {}, hrOtherTenant)).status, 404);
  assert.equal((await send(`/api/admin/meeting-requests/${created.id}/confirm`, { method: 'POST', body: JSON.stringify({ expectedVersion: 1 }) }, hr)).status, 400);
  assert.equal((await send(`/api/admin/meeting-requests/${created.id}/confirm`, { method: 'POST', body: JSON.stringify({ expectedVersion: 1, startAt: '2026-12-01T09:00:00+05:30', endAt: '2026-12-01T09:30:00+05:30', timeZone: 'Asia/Kolkata', confirmedBy: 'attacker', confirmedAt: '2026-11-14T00:00:00Z' }) }, hr)).status, 400);
  const confirmation = { expectedVersion: 1, startAt: '2026-12-01T09:00:00+05:30', endAt: '2026-12-01T09:30:00+05:30', timeZone: 'Asia/Kolkata', location: 'Room 2' };
  const confirmResponse = await send(`/api/admin/meeting-requests/${created.id}/confirm`, { method: 'POST', body: JSON.stringify(confirmation) }, hr); assert.equal(confirmResponse.status, 200);
  const confirmed = (await confirmResponse.json() as { request: any }).request;
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.confirmation.confirmedBy, 'hr-a'); assert.equal(confirmed.confirmation.source, 'hr_manual');
  assert.equal((await send(`/api/admin/meeting-requests/${created.id}/confirm`, { method: 'POST', body: JSON.stringify(confirmation) }, hr)).status, 409);
  const requesterDetail = (await send(`/api/meeting-requests/mine/${created.id}`, {}, requester).then((r) => r.json()) as { request: any }).request;
  assert.equal(requesterDetail.status, 'confirmed'); assert.equal('requesterId' in requesterDetail, false); assert.equal(requesterDetail.confirmation.confirmedBy, undefined);

  const second = await send('/api/meeting-requests', { method: 'POST', headers: { 'Idempotency-Key': 'meeting_reject_key_001' }, body: JSON.stringify(body) }, requester);
  const secondRequest = (await second.json() as { request: any }).request;
  const rejectedResponse = await send(`/api/admin/meeting-requests/${secondRequest.id}/reject`, { method: 'POST', body: JSON.stringify({ expectedVersion: 1, reason: 'No suitable time is available.' }) }, hr);
  assert.equal(rejectedResponse.status, 200);
  const rejected = (await rejectedResponse.json() as { request: any }).request; assert.equal(rejected.status, 'rejected');
  const requesterRejected = (await send(`/api/meeting-requests/mine/${secondRequest.id}`, {}, requester).then((r) => r.json()) as { request: any }).request;
  assert.equal(requesterRejected.rejectionReason, 'No suitable time is available.'); assert.equal('statusHistory' in requesterRejected, true);
  assert.ok(service.audits.some((event) => event.action === 'meeting_request.confirmed' && event.actorId === 'hr-a'));
  assert.ok(service.audits.some((event) => event.action === 'meeting_request.rejected' && event.actorId === 'hr-a'));

  service.failCreate = true;
  const failure = await send('/api/meeting-requests', { method: 'POST', headers: { 'Idempotency-Key': 'meeting_failure_key_01' }, body: JSON.stringify(body) }, requester);
  assert.equal(failure.status, 503); assert.doesNotMatch(await failure.text(), /DATABASE_DOWN|stack/);
});
