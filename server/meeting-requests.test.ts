import assert from 'node:assert/strict';
import test from 'node:test';
import type { Db } from 'mongodb';
import type { AuthenticatedPrincipal } from './auth';
import { MeetingRequestError, MongoMeetingRequestService, validateConfirmationInput, validateMeetingIdempotencyKey, validateMeetingRequestInput } from './meeting-requests';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const validBody = { subject: 'Discuss onboarding steps', purpose: 'Please help me review the required onboarding next steps.', timeZone: 'Asia/Kolkata', preferredTimes: [{ startAt: '2026-12-01T09:00:00+05:30', endAt: '2026-12-01T09:30:00+05:30' }] };
const requester: AuthenticatedPrincipal = { subject: 'requester-a', tenantId: 'tenant-a', roles: ['user'] };
const hr: AuthenticatedPrincipal = { subject: 'hr-a', tenantId: 'tenant-a', roles: ['support_agent'] };

test('meeting request validation requires explicit-offset timestamps and a valid IANA time zone', () => {
  const value = validateMeetingRequestInput(validBody, NOW);
  assert.equal(value.preferredTimes[0]?.startAt.toISOString(), '2026-12-01T03:30:00.000Z');
  for (const input of [
    { ...validBody, timeZone: 'Mars/Colony' },
    { ...validBody, preferredTimes: [{ startAt: '2026-12-01T09:00:00', endAt: validBody.preferredTimes[0]!.endAt }] },
    { ...validBody, preferredTimes: [{ startAt: '2026-02-30T09:00:00Z', endAt: validBody.preferredTimes[0]!.endAt }] },
    { ...validBody, preferredTimes: [{ startAt: '2026-10-01T09:00:00Z', endAt: '2026-10-01T10:00:00Z' }] },
    { ...validBody, preferredTimes: [{ startAt: validBody.preferredTimes[0]!.endAt, endAt: validBody.preferredTimes[0]!.startAt }] },
    { ...validBody, requesterId: 'attacker' },
  ]) assert.throws(() => validateMeetingRequestInput(input, NOW), MeetingRequestError);
});

test('confirmation requires a future explicit schedule and rejects client actor or timestamps', () => {
  const details = validateConfirmationInput({ startAt: '2026-12-01T09:00:00+05:30', endAt: '2026-12-01T09:30:00+05:30', timeZone: 'Asia/Kolkata', location: 'Room 2' }, NOW);
  assert.equal(details.location, 'Room 2');
  assert.throws(() => validateConfirmationInput({ ...validBody.preferredTimes[0], timeZone: 'Asia/Kolkata', actorId: 'attacker' }, NOW), /INVALID_REQUEST/);
  assert.throws(() => validateConfirmationInput({ startAt: '2026-12-01T09:00:00', endAt: '2026-12-01T09:30:00Z', timeZone: 'UTC' }, NOW), /INVALID_DATETIME/);
  assert.throws(() => validateConfirmationInput({ startAt: '2026-10-01T09:00:00Z', endAt: '2026-10-01T10:00:00Z', timeZone: 'UTC' }, NOW), /PAST_CONFIRMATION/);
  assert.equal(validateMeetingIdempotencyKey('meeting_request_key_001'), 'meeting_request_key_001');
  assert.throws(() => validateMeetingIdempotencyKey('short'), /IDEMPOTENCY_KEY_REQUIRED/);
});

class FakeMeetingDb {
  requests: Array<Record<string, any>> = [];
  audits: Array<Record<string, any>> = [];
  failAudit = false;
  collection(name: string) {
    if (name === 'conversations') return { findOne: async () => null };
    if (name === 'meeting_requests') return {
      findOne: async (filter: Record<string, unknown>) => this.requests.find((row) => Object.entries(filter).every(([key, value]) => row[key] === value)) ?? null,
      insertOne: async (row: Record<string, any>) => { this.requests.push(structuredClone(row)); return { insertedId: row._id }; },
      find: (filter: Record<string, unknown>) => {
        let rows = this.requests.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value));
        let offset = 0, size = rows.length;
        const cursor = {
          sort() { return cursor; }, skip(value: number) { offset = value; return cursor; }, limit(value: number) { size = value; return cursor; },
          async toArray() { return structuredClone(rows.slice(offset, offset + size)); },
        };
        return cursor;
      },
      countDocuments: async (filter: Record<string, unknown>) => this.requests.filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value)).length,
      updateOne: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown>; $inc: Record<string, number>; $push: Record<string, unknown> }) => {
        const row = this.requests.find((item) => Object.entries(filter).every(([key, value]) => item[key] === value));
        if (!row) return { modifiedCount: 0 };
        Object.assign(row, structuredClone(update.$set));
        for (const [key, amount] of Object.entries(update.$inc)) row[key] += amount;
        for (const [key, value] of Object.entries(update.$push)) row[key].push(structuredClone(value));
        return { modifiedCount: 1 };
      },
    };
    if (name === 'audit_logs') return { insertOne: async (event: Record<string, unknown>) => { if (this.failAudit) throw new Error('AUDIT_WRITE_FAILED'); this.audits.push(structuredClone(event)); return { insertedId: 'audit' }; } };
    throw new Error(`unexpected collection ${name}`);
  }
  session() {
    return {
      withTransaction: async <T>(callback: () => Promise<T>) => {
        const beforeRequests = structuredClone(this.requests), beforeAudits = structuredClone(this.audits);
        try { return await callback(); } catch (error) { this.requests = beforeRequests; this.audits = beforeAudits; throw error; }
      }, endSession: async () => undefined,
    };
  }
}

test('Mongo service persists pending request and audit atomically; retries are idempotent', async () => {
  const db = new FakeMeetingDb();
  const service = new MongoMeetingRequestService(async () => db as unknown as Db, async () => db.session() as never);
  const input = validateMeetingRequestInput(validBody, NOW);
  db.failAudit = true;
  await assert.rejects(service.create(requester, input, 'meeting_retry_key_0001'), /AUDIT_WRITE_FAILED/);
  assert.equal(db.requests.length, 0); assert.equal(db.audits.length, 0);
  db.failAudit = false;
  const created = await service.create(requester, input, 'meeting_retry_key_0001');
  assert.equal(created.request.status, 'pending'); assert.equal(created.duplicate, false);
  assert.match(created.request.reference, /^UTM-[A-F0-9]{36}$/);
  assert.equal(db.audits[0]?.action, 'meeting_request.created');
  assert.equal(db.audits[0]?.actorId, requester.subject);
  const replay = await service.create(requester, input, 'meeting_retry_key_0001');
  assert.equal(replay.duplicate, true); assert.equal(replay.request._id, created.request._id);
  assert.equal(db.requests.length, 1); assert.equal(db.audits.length, 1);
  await assert.rejects(service.create(requester, validateMeetingRequestInput({ ...validBody, subject: 'Another onboarding meeting' }, NOW), 'meeting_retry_key_0001'), /IDEMPOTENCY_CONFLICT/);
});

test('Mongo service confirms only pending requests with versioned audit and protects owner scope', async () => {
  const db = new FakeMeetingDb();
  const service = new MongoMeetingRequestService(async () => db as unknown as Db, async () => db.session() as never);
  const created = await service.create(requester, validateMeetingRequestInput(validBody, NOW), 'meeting_confirm_key_0001');
  assert.equal(await service.getMine({ ...requester, subject: 'requester-b' }, created.request._id), null);
  assert.equal((await service.listForHr({ ...hr, tenantId: 'tenant-b' }, undefined, 1, 20)).pagination.total, 0);
  const confirmed = await service.confirm(hr, created.request._id, validateConfirmationInput({ startAt: '2026-12-02T10:00:00+05:30', endAt: '2026-12-02T10:30:00+05:30', timeZone: 'Asia/Kolkata' }, NOW), 1, 'confirm-request');
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.confirmation?.confirmedBy, hr.subject); assert.equal(confirmed.confirmation?.source, 'hr_manual');
  assert.equal(confirmed.version, 2); assert.equal(db.audits.at(-1)?.action, 'meeting_request.confirmed');
  await assert.rejects(service.confirm(hr, created.request._id, validateConfirmationInput({ startAt: '2026-12-02T10:00:00Z', endAt: '2026-12-02T10:30:00Z', timeZone: 'UTC' }, NOW), 1), /VERSION_CONFLICT/);
  await assert.rejects(service.reject(hr, created.request._id, 'No slot available', 2), /INVALID_TRANSITION/);
});

test('requester can cancel only their still-pending request and cancellation is audited', async () => {
  const db = new FakeMeetingDb();
  const service = new MongoMeetingRequestService(async () => db as unknown as Db, async () => db.session() as never);
  const created = await service.create(requester, validateMeetingRequestInput(validBody, NOW), 'meeting_cancel_key_0001');
  const cancelled = await service.cancel(requester, created.request._id, 1, 'cancel-request');
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.version, 2);
  assert.equal(db.audits.at(-1)?.action, 'meeting_request.cancelled');
  await assert.rejects(service.cancel(requester, created.request._id, 2), /INVALID_TRANSITION/);
});
