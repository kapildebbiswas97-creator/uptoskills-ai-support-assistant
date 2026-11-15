import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ClientSession, Db, Document, UpdateFilter } from 'mongodb';
import type { AuthenticatedPrincipal } from './auth.js';
import { collection, getMongoDatabase, startMongoSession, writeAuditEvent } from './mongodb.js';

export const MEETING_REQUEST_STATUSES = ['pending', 'confirmed', 'rejected', 'cancelled'] as const;
export type MeetingRequestStatus = typeof MEETING_REQUEST_STATUSES[number];

export interface PreferredMeetingTime { startAt: Date; endAt: Date }
export interface MeetingRequestInput {
  subject: string;
  purpose: string;
  preferredTimes: PreferredMeetingTime[];
  timeZone: string;
  conversationId?: string;
}
export interface MeetingConfirmationInput { startAt: Date; endAt: Date; timeZone: string; location?: string }
export interface MeetingRequestRecord extends Document {
  _id: string;
  reference: string;
  tenantId: string | null;
  requesterId: string;
  conversationId: string | null;
  subject: string;
  purpose: string;
  preferredTimes: PreferredMeetingTime[];
  timeZone: string;
  status: MeetingRequestStatus;
  version: number;
  statusHistory: Array<{ from: MeetingRequestStatus | null; to: MeetingRequestStatus; actorId: string; actorRole: string; at: Date }>;
  confirmation: (MeetingConfirmationInput & { confirmedAt: Date; confirmedBy: string; source: 'hr_manual' }) | null;
  rejectionReason: string | null;
  idempotencyKey: string;
  requestHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MeetingRequestService {
  create(principal: AuthenticatedPrincipal, input: MeetingRequestInput, idempotencyKey: string, requestId?: string): Promise<{ request: MeetingRequestRecord; duplicate: boolean }>;
  listMine(principal: AuthenticatedPrincipal, page: number, pageSize: number): Promise<{ requests: MeetingRequestRecord[]; pagination: { page: number; pageSize: number; total: number } }>;
  getMine(principal: AuthenticatedPrincipal, id: string): Promise<MeetingRequestRecord | null>;
  listForHr(principal: AuthenticatedPrincipal, status: MeetingRequestStatus | undefined, page: number, pageSize: number): Promise<{ requests: MeetingRequestRecord[]; pagination: { page: number; pageSize: number; total: number } }>;
  getForHr(principal: AuthenticatedPrincipal, id: string): Promise<MeetingRequestRecord | null>;
  confirm(principal: AuthenticatedPrincipal, id: string, details: MeetingConfirmationInput, expectedVersion: number, requestId?: string): Promise<MeetingRequestRecord>;
  reject(principal: AuthenticatedPrincipal, id: string, reason: string, expectedVersion: number, requestId?: string): Promise<MeetingRequestRecord>;
  cancel(principal: AuthenticatedPrincipal, id: string, expectedVersion: number, requestId?: string): Promise<MeetingRequestRecord>;
}

export class MeetingRequestError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'MeetingRequestError'; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }

export function validateTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 || /[\x00-\x20]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); return true; } catch { return false; }
}

function parseExplicitInstant(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', , zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return undefined;
  if (zone.toUpperCase() !== 'Z' && (Number(offsetHourText) > 14 || Number(offsetMinuteText) > 59 || (Number(offsetHourText) === 14 && Number(offsetMinuteText) !== 0))) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

export function validateMeetingRequestInput(value: unknown, now = Date.now()): MeetingRequestInput {
  if (!isRecord(value) || !exactKeys(value, ['subject', 'purpose', 'preferredTimes', 'timeZone', 'conversationId'])) throw new MeetingRequestError('INVALID_REQUEST');
  if (typeof value.subject !== 'string' || value.subject.trim().length < 5 || value.subject.trim().length > 120) throw new MeetingRequestError('INVALID_SUBJECT');
  if (typeof value.purpose !== 'string' || value.purpose.trim().length < 10 || value.purpose.trim().length > 2000) throw new MeetingRequestError('INVALID_PURPOSE');
  if (!validateTimeZone(value.timeZone)) throw new MeetingRequestError('INVALID_TIMEZONE');
  if (!Array.isArray(value.preferredTimes) || value.preferredTimes.length < 1 || value.preferredTimes.length > 3) throw new MeetingRequestError('INVALID_PREFERENCES');
  const preferredTimes: PreferredMeetingTime[] = value.preferredTimes.map((item) => {
    if (!isRecord(item) || !exactKeys(item, ['startAt', 'endAt'])) throw new MeetingRequestError('INVALID_PREFERENCES');
    const startAt = parseExplicitInstant(item.startAt), endAt = parseExplicitInstant(item.endAt);
    if (!startAt || !endAt) throw new MeetingRequestError('INVALID_DATETIME');
    if (startAt.getTime() <= now) throw new MeetingRequestError('PAST_PREFERENCE');
    if (endAt.getTime() <= startAt.getTime()) throw new MeetingRequestError('INVALID_TIME_RANGE');
    return { startAt, endAt };
  });
  if (value.conversationId !== undefined && (typeof value.conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.conversationId))) throw new MeetingRequestError('INVALID_CONVERSATION');
  return {
    subject: value.subject.trim(), purpose: value.purpose.trim(), preferredTimes, timeZone: value.timeZone,
    ...(typeof value.conversationId === 'string' ? { conversationId: value.conversationId } : {}),
  };
}

export function validateConfirmationInput(value: unknown, now = Date.now()): MeetingConfirmationInput {
  if (!isRecord(value) || !exactKeys(value, ['startAt', 'endAt', 'timeZone', 'location'])) throw new MeetingRequestError('INVALID_REQUEST');
  const startAt = parseExplicitInstant(value.startAt), endAt = parseExplicitInstant(value.endAt);
  if (!startAt || !endAt) throw new MeetingRequestError('INVALID_DATETIME');
  if (startAt.getTime() <= now) throw new MeetingRequestError('PAST_CONFIRMATION');
  if (endAt.getTime() <= startAt.getTime()) throw new MeetingRequestError('INVALID_TIME_RANGE');
  if (!validateTimeZone(value.timeZone)) throw new MeetingRequestError('INVALID_TIMEZONE');
  if (value.location !== undefined && (typeof value.location !== 'string' || value.location.trim().length > 500)) throw new MeetingRequestError('INVALID_LOCATION');
  return { startAt, endAt, timeZone: value.timeZone, ...(typeof value.location === 'string' && value.location.trim() ? { location: value.location.trim() } : {}) };
}

export function validateMeetingIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new MeetingRequestError('IDEMPOTENCY_KEY_REQUIRED');
  return value;
}
function payloadHash(input: MeetingRequestInput): string {
  return createHash('sha256').update(JSON.stringify({ subject: input.subject, purpose: input.purpose, timeZone: input.timeZone, conversationId: input.conversationId ?? null, preferredTimes: input.preferredTimes.map(({ startAt, endAt }) => [startAt.toISOString(), endAt.toISOString()]) })).digest('hex');
}
function roleFor(principal: AuthenticatedPrincipal): string { return principal.roles.includes('support_agent') ? 'support_agent' : 'requester'; }
function scope(principal: AuthenticatedPrincipal) { return { tenantId: principal.tenantId ?? null }; }
function requesterScope(principal: AuthenticatedPrincipal) { return { ...scope(principal), requesterId: principal.subject }; }
function newReference(): string { return `UTM-${randomBytes(18).toString('hex').toUpperCase()}`; }
function duplicateKey(error: unknown): boolean { return isRecord(error) && error.code === 11000; }

export class MongoMeetingRequestService implements MeetingRequestService {
  constructor(private readonly database: () => Promise<Db> = getMongoDatabase, private readonly createSession: () => Promise<ClientSession> = startMongoSession) {}

  private async transaction<T>(db: Db, work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.createSession();
    try {
      const value = await session.withTransaction(() => work(session));
      if (value === undefined) throw new MeetingRequestError('TRANSACTION_FAILED');
      return value;
    } finally { await session.endSession(); }
  }

  async create(principal: AuthenticatedPrincipal, input: MeetingRequestInput, idempotencyKey: string, requestId?: string) {
    const db = await this.database();
    const requests = collection<MeetingRequestRecord>(db, 'meeting_requests');
    const keyFilter = { ...requesterScope(principal), idempotencyKey };
    const requestHash = payloadHash(input);
    if (input.conversationId) {
      const conversation = await collection<{ _id: string }>(db, 'conversations').findOne({
        _id: input.conversationId, ownerId: principal.subject, tenantId: principal.tenantId ?? null, archivedAt: null,
      }, { projection: { _id: 1 } });
      if (!conversation) throw new MeetingRequestError('CONVERSATION_NOT_FOUND');
    }
    const existing = await requests.findOne(keyFilter);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new MeetingRequestError('IDEMPOTENCY_CONFLICT');
      return { request: existing, duplicate: true };
    }
    const now = new Date();
    const record: MeetingRequestRecord = {
      _id: randomUUID(), reference: newReference(), tenantId: principal.tenantId ?? null, requesterId: principal.subject,
      conversationId: input.conversationId ?? null, subject: input.subject, purpose: input.purpose,
      preferredTimes: input.preferredTimes, timeZone: input.timeZone, status: 'pending', version: 1,
      statusHistory: [{ from: null, to: 'pending', actorId: principal.subject, actorRole: roleFor(principal), at: now }],
      confirmation: null, rejectionReason: null, idempotencyKey, requestHash, createdAt: now, updatedAt: now,
    };
    try {
      await this.transaction(db, async (session) => {
        await requests.insertOne(record, { session });
        await writeAuditEvent(db, { action: 'meeting_request.created', actorId: principal.subject, actorRole: roleFor(principal), tenantId: principal.tenantId ?? null, resourceType: 'meeting_request', resourceId: record._id, requestId, metadata: { from: 'none', to: 'pending' }, createdAt: now }, session);
        return record;
      });
      return { request: record, duplicate: false };
    } catch (error) {
      if (duplicateKey(error)) {
        const raced = await requests.findOne(keyFilter);
        if (raced) {
          if (raced.requestHash !== requestHash) throw new MeetingRequestError('IDEMPOTENCY_CONFLICT');
          return { request: raced, duplicate: true };
        }
      }
      throw error;
    }
  }

  async listMine(principal: AuthenticatedPrincipal, page: number, pageSize: number) {
    const db = await this.database(), requests = collection<MeetingRequestRecord>(db, 'meeting_requests'), filter = requesterScope(principal);
    const [rows, total] = await Promise.all([requests.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(), requests.countDocuments(filter)]);
    return { requests: rows, pagination: { page, pageSize, total } };
  }
  async getMine(principal: AuthenticatedPrincipal, id: string) { return collection<MeetingRequestRecord>(await this.database(), 'meeting_requests').findOne({ _id: id, ...requesterScope(principal) }); }
  async listForHr(principal: AuthenticatedPrincipal, status: MeetingRequestStatus | undefined, page: number, pageSize: number) {
    const db = await this.database(), requests = collection<MeetingRequestRecord>(db, 'meeting_requests'), filter = { ...scope(principal), ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([requests.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(), requests.countDocuments(filter)]);
    return { requests: rows, pagination: { page, pageSize, total } };
  }
  async getForHr(principal: AuthenticatedPrincipal, id: string) { return collection<MeetingRequestRecord>(await this.database(), 'meeting_requests').findOne({ _id: id, ...scope(principal) }); }

  private async transition(principal: AuthenticatedPrincipal, id: string, to: MeetingRequestStatus, expectedVersion: number, requestId: string | undefined, extras: { confirmation?: MeetingRequestRecord['confirmation']; rejectionReason?: string | null }, ownerId?: string) {
    const db = await this.database();
    return this.transaction(db, async (session) => {
      const requests = collection<MeetingRequestRecord>(db, 'meeting_requests');
      const actorScope = { _id: id, ...scope(principal), ...(ownerId ? { requesterId: ownerId } : {}) };
      const current = await requests.findOne(actorScope, { session });
      if (!current) throw new MeetingRequestError('NOT_FOUND');
      if (current.version !== expectedVersion) throw new MeetingRequestError('VERSION_CONFLICT');
      if (current.status !== 'pending' || !['confirmed', 'rejected', 'cancelled'].includes(to)) throw new MeetingRequestError('INVALID_TRANSITION');
      const now = new Date();
      const event = { from: current.status, to, actorId: principal.subject, actorRole: roleFor(principal), at: now };
      const set: Record<string, unknown> = { status: to, updatedAt: now, ...('confirmation' in extras ? { confirmation: extras.confirmation } : {}), ...('rejectionReason' in extras ? { rejectionReason: extras.rejectionReason } : {}) };
      const result = await requests.updateOne({ ...actorScope, status: 'pending', version: expectedVersion }, { $set: set, $inc: { version: 1 }, $push: { statusHistory: event } } as unknown as UpdateFilter<MeetingRequestRecord>, { session });
      if (result.modifiedCount !== 1) throw new MeetingRequestError('VERSION_CONFLICT');
      const action = to === 'confirmed' ? 'meeting_request.confirmed' : to === 'rejected' ? 'meeting_request.rejected' : 'meeting_request.cancelled';
      await writeAuditEvent(db, { action, actorId: principal.subject, actorRole: roleFor(principal), tenantId: principal.tenantId ?? null, resourceType: 'meeting_request', resourceId: id, requestId, metadata: { from: current.status, to, ...(to === 'confirmed' ? { source: 'hr_manual' } : {}) }, createdAt: now }, session);
      const updated = await requests.findOne(actorScope, { session });
      if (!updated) throw new MeetingRequestError('NOT_FOUND');
      return updated;
    });
  }
  async confirm(principal: AuthenticatedPrincipal, id: string, details: MeetingConfirmationInput, expectedVersion: number, requestId?: string) {
    const confirmation = { ...details, confirmedAt: new Date(), confirmedBy: principal.subject, source: 'hr_manual' as const };
    return this.transition(principal, id, 'confirmed', expectedVersion, requestId, { confirmation });
  }
  async reject(principal: AuthenticatedPrincipal, id: string, reason: string, expectedVersion: number, requestId?: string) { return this.transition(principal, id, 'rejected', expectedVersion, requestId, { rejectionReason: reason }); }
  async cancel(principal: AuthenticatedPrincipal, id: string, expectedVersion: number, requestId?: string) {
    const db = await this.database();
    const current = await collection<MeetingRequestRecord>(db, 'meeting_requests').findOne({ _id: id, ...requesterScope(principal) });
    if (!current) throw new MeetingRequestError('NOT_FOUND');
    if (current.version !== expectedVersion) throw new MeetingRequestError('VERSION_CONFLICT');
    return this.transition(principal, id, 'cancelled', expectedVersion, requestId, {}, principal.subject);
  }
}

export function createMongoMeetingRequestService(): MeetingRequestService { return new MongoMeetingRequestService(); }
