import assert from 'node:assert/strict';
import test from 'node:test';
import { MongoClient } from 'mongodb';
import type { AuthenticatedPrincipal } from './auth';
import { initializeMongoSchema, type AuditEvent } from './mongodb';
import { MongoMeetingRequestService, validateMeetingRequestInput, validateConfirmationInput, type MeetingRequestRecord } from './meeting-requests';

function integrationMongoTarget(): { uri: string; database: string } | undefined {
  if (process.env.RUN_LOCAL_MEETING_TESTS !== 'true' || process.env.APP_ENV !== 'local-integration') return undefined;
  const uri = process.env.MONGODB_URI, database = process.env.MONGODB_DATABASE;
  if (!uri || !database) throw new Error('Meeting integration requires a loopback MongoDB URI and *_integration database.');
  const parsed = new URL(uri);
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Meeting integration accepts loopback MongoDB only.');
  if (!/^[a-z0-9_]+_integration$/.test(database)) throw new Error('Meeting integration requires a database ending in _integration.');
  return { uri, database };
}
const target = integrationMongoTarget();

test('disposable MongoDB replica set persists meeting requests, indexes, audit, idempotency and concurrent decisions', { skip: target ? undefined : 'Requires RUN_LOCAL_MEETING_TESTS=true, APP_ENV=local-integration and a loopback MongoDB *_integration replica set.' }, async () => {
  assert.ok(target);
  const client = new MongoClient(target.uri, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 });
  const fixture = `phase8-meeting-${crypto.randomUUID()}`;
  const requester: AuthenticatedPrincipal = { subject: fixture, tenantId: 'phase8-integration-tenant', roles: ['user'] };
  const hr: AuthenticatedPrincipal = { subject: `${fixture}-hr`, tenantId: 'phase8-integration-tenant', roles: ['support_agent'] };
  let ids: string[] = [];
  try {
    await client.connect();
    const db = client.db(target.database);
    await db.command({ ping: 1 });
    await initializeMongoSchema(db);
    const service = new MongoMeetingRequestService(async () => db, async () => client.startSession());
    const preferredStart = new Date(Date.now() + 86_400_000), preferredEnd = new Date(preferredStart.getTime() + 1_800_000);
    const input = validateMeetingRequestInput({
      subject: 'Disposable integration meeting', purpose: 'Verify real MongoDB persistence and transactional audit.', timeZone: 'UTC',
      preferredTimes: [{ startAt: preferredStart.toISOString(), endAt: preferredEnd.toISOString() }],
    });
    const first = await service.create(requester, input, 'phase8-meeting-retry-key-0001', 'phase8-create');
    ids.push(first.request._id);
    assert.equal(first.request.status, 'pending');
    assert.equal(await db.collection('meeting_requests').countDocuments({ requesterId: fixture }), 1);
    assert.equal(await db.collection('audit_logs').countDocuments({ resourceId: first.request._id, action: 'meeting_request.created' }), 1);

    const restartedService = new MongoMeetingRequestService(async () => db, async () => client.startSession());
    const retry = await restartedService.create(requester, input, 'phase8-meeting-retry-key-0001', 'phase8-retry');
    assert.equal(retry.duplicate, true);
    assert.equal(retry.request._id, first.request._id);
    const indexes = await db.collection('meeting_requests').listIndexes().toArray();
    for (const name of ['meeting_requests_reference_unique', 'meeting_requests_requester_created', 'meeting_requests_queue_status_created', 'meeting_requests_requester_idempotency_unique']) assert.ok(indexes.some((index) => index.name === name), `${name} exists`);

    const confirmedStart = new Date(Date.now() + 172_800_000), confirmedEnd = new Date(confirmedStart.getTime() + 1_800_000);
    const confirmDetails = validateConfirmationInput({ startAt: confirmedStart.toISOString(), endAt: confirmedEnd.toISOString(), timeZone: 'UTC' });
    const reject = () => restartedService.reject(hr, first.request._id, 'No suitable time is available.', 1, 'phase8-reject');
    const confirm = () => restartedService.confirm(hr, first.request._id, confirmDetails, 1, 'phase8-confirm');
    const decisions = await Promise.allSettled([confirm(), reject()]);
    assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1, 'only one concurrent HR decision commits');
    const durable = await db.collection<MeetingRequestRecord>('meeting_requests').findOne({ _id: first.request._id });
    assert.ok(durable);
    assert.ok(['confirmed', 'rejected'].includes(String(durable.status)));
    assert.equal(durable.version, 2);
    assert.equal(await db.collection<AuditEvent>('audit_logs').countDocuments({ resourceId: first.request._id, action: { $in: ['meeting_request.confirmed', 'meeting_request.rejected'] } }), 1);
  } finally {
    if (ids.length) {
      const db = client.db(target.database);
      await db.collection<MeetingRequestRecord>('meeting_requests').deleteMany({ _id: { $in: ids }, requesterId: fixture }).catch(() => undefined);
      await db.collection<AuditEvent>('audit_logs').deleteMany({ resourceId: { $in: ids } }).catch(() => undefined);
    }
    await client.close();
  }
});
