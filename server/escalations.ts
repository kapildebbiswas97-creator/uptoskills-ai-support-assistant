import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ClientSession, Db, Document, UpdateFilter } from 'mongodb';
import { EscalationCategory } from '../src/types/assistant.js';
import type { AuthenticatedPrincipal } from './auth.js';
import { collection, getMongoDatabase, startMongoSession, writeAuditEvent } from './mongodb.js';
import { ESCALATION_CONSENT_TEXT, ESCALATION_CONSENT_VERSION } from '../src/utils/escalationConsent.js';

export const ESCALATION_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type EscalationStatus = typeof ESCALATION_STATUSES[number];
export const ESCALATION_CATEGORIES = Object.values(EscalationCategory);

export interface EscalationCreateInput {
  subject: string;
  description: string;
  category?: string;
  conversationId?: string;
  consent: { accepted: true; version: typeof ESCALATION_CONSENT_VERSION };
}

export interface EscalationTicket extends Document {
  _id: string;
  reference: string;
  tenantId: string | null;
  requesterId: string;
  conversationId?: string | null;
  subject: string;
  description: string;
  category?: string | null;
  consent: { accepted: true; version: string; text: string; at: Date };
  status: EscalationStatus;
  version: number;
  statusHistory: Array<{ from: EscalationStatus | null; to: EscalationStatus; actorId: string; actorRole: string; changedAt: Date }>;
  internalNotes: Array<{ id: string; authorId: string; createdAt: Date; content: string }>;
  idempotencyKey: string;
  requestHash: string;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EscalationPage {
  page: number;
  pageSize: number;
  total: number;
}

export interface EscalationService {
  create(principal: AuthenticatedPrincipal, input: EscalationCreateInput, idempotencyKey: string, requestId?: string): Promise<{ ticket: EscalationTicket; duplicate: boolean }>;
  listMine(principal: AuthenticatedPrincipal, page: number, pageSize: number): Promise<{ tickets: EscalationTicket[]; pagination: EscalationPage }>;
  getMine(principal: AuthenticatedPrincipal, ticketId: string): Promise<EscalationTicket | null>;
  listQueue(principal: AuthenticatedPrincipal, status: EscalationStatus | undefined, page: number, pageSize: number): Promise<{ tickets: EscalationTicket[]; pagination: EscalationPage }>;
  getForHr(principal: AuthenticatedPrincipal, ticketId: string): Promise<EscalationTicket | null>;
  updateStatus(principal: AuthenticatedPrincipal, ticketId: string, status: EscalationStatus, expectedVersion: number, requestId?: string): Promise<EscalationTicket>;
  addNote(principal: AuthenticatedPrincipal, ticketId: string, content: string, expectedVersion: number, requestId?: string): Promise<EscalationTicket>;
}

export class EscalationServiceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EscalationServiceError';
  }
}

export function validateEscalationCreateInput(value: unknown): EscalationCreateInput {
  if (!isRecord(value)) throw new EscalationServiceError('INVALID_REQUEST');
  const allowed = new Set(['subject', 'description', 'category', 'conversationId', 'consent']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new EscalationServiceError('INVALID_REQUEST');

  if (typeof value.subject !== 'string' || value.subject.trim().length < 5 || value.subject.trim().length > 120) {
    throw new EscalationServiceError('INVALID_SUBJECT');
  }
  if (typeof value.description !== 'string' || value.description.trim().length < 10 || value.description.trim().length > 10_000) {
    throw new EscalationServiceError('INVALID_DESCRIPTION');
  }
  if (value.category !== undefined && (typeof value.category !== 'string' || !ESCALATION_CATEGORIES.includes(value.category as EscalationCategory))) {
    throw new EscalationServiceError('INVALID_CATEGORY');
  }
  if (value.conversationId !== undefined && (typeof value.conversationId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.conversationId))) {
    throw new EscalationServiceError('INVALID_CONVERSATION');
  }
  if (!isRecord(value.consent) || Object.keys(value.consent).some((key) => !['accepted', 'version'].includes(key)) ||
      value.consent.accepted !== true || value.consent.version !== ESCALATION_CONSENT_VERSION) {
    throw new EscalationServiceError('CONSENT_REQUIRED');
  }

  return {
    subject: value.subject.trim(),
    description: value.description.trim(),
    ...(value.category ? { category: value.category as string } : {}),
    ...(value.conversationId ? { conversationId: value.conversationId as string } : {}),
    consent: { accepted: true, version: ESCALATION_CONSENT_VERSION },
  };
}

export function validateIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new EscalationServiceError('IDEMPOTENCY_KEY_REQUIRED');
  return value;
}

export function escalationRequestHash(input: EscalationCreateInput): string {
  return createHash('sha256').update(JSON.stringify({
    subject: input.subject,
    description: input.description,
    category: input.category ?? null,
    conversationId: input.conversationId ?? null,
    consentVersion: input.consent.version,
  })).digest('hex');
}

export function isEscalationStatus(value: unknown): value is EscalationStatus {
  return typeof value === 'string' && (ESCALATION_STATUSES as readonly string[]).includes(value);
}

export function isValidStatusTransition(from: EscalationStatus, to: EscalationStatus): boolean {
  return (from === 'open' && to === 'in_progress') ||
    (from === 'in_progress' && to === 'resolved') ||
    (from === 'resolved' && to === 'closed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11000;
}

function requesterScope(principal: AuthenticatedPrincipal) {
  return { requesterId: principal.subject, tenantId: principal.tenantId ?? null };
}

function tenantScope(principal: AuthenticatedPrincipal) {
  return { tenantId: principal.tenantId ?? null };
}

function newReference(): string {
  return `UTS-${randomBytes(18).toString('hex').toUpperCase()}`;
}

function sessionRole(principal: AuthenticatedPrincipal): string {
  return principal.roles.includes('support_agent') ? 'support_agent' : 'requester';
}

export class MongoEscalationService implements EscalationService {
  constructor(
    private readonly database: () => Promise<Db> = getMongoDatabase,
    private readonly createSession: () => Promise<ClientSession> = startMongoSession
  ) {}

  private async transaction<T>(db: Db, work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.createSession();
    try {
      const result = await session.withTransaction(() => work(session));
      if (result === undefined) throw new EscalationServiceError('TRANSACTION_FAILED');
      return result;
    } finally {
      await session.endSession();
    }
  }

  async create(principal: AuthenticatedPrincipal, input: EscalationCreateInput, idempotencyKey: string, requestId?: string) {
    const db = await this.database();
    const tickets = collection<EscalationTicket>(db, 'escalations');
    const scope = { ...requesterScope(principal), idempotencyKey };
    const requestHash = escalationRequestHash(input);

    if (input.conversationId) {
      const conversation = await collection<{ _id: string; ownerId: string; tenantId: string | null; archivedAt: Date | null }>(db, 'conversations').findOne({
        _id: input.conversationId,
        ownerId: principal.subject,
        tenantId: principal.tenantId ?? null,
        archivedAt: null,
      }, { projection: { _id: 1 } });
      if (!conversation) throw new EscalationServiceError('CONVERSATION_NOT_FOUND');
    }

    const existingTicket = async () => tickets.findOne(scope);
    const matchIdempotentRetry = async (ticket: EscalationTicket | null) => {
      if (!ticket) return undefined;
      if (ticket.requestHash !== requestHash) throw new EscalationServiceError('IDEMPOTENCY_CONFLICT');
      return { ticket, duplicate: true };
    };

    const existing = await matchIdempotentRetry(await existingTicket());
    if (existing) return existing;

    const now = new Date();
    const ticket: EscalationTicket = {
      _id: randomUUID(),
      reference: newReference(),
      tenantId: principal.tenantId ?? null,
      requesterId: principal.subject,
      conversationId: input.conversationId ?? null,
      subject: input.subject,
      description: input.description,
      category: input.category ?? null,
      consent: { accepted: true, version: input.consent.version, text: ESCALATION_CONSENT_TEXT, at: now },
      status: 'open',
      version: 1,
      statusHistory: [{ from: null, to: 'open', actorId: principal.subject, actorRole: sessionRole(principal), changedAt: now }],
      internalNotes: [],
      idempotencyKey,
      requestHash,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.transaction(db, async (session) => {
        await tickets.insertOne(ticket, { session });
        await writeAuditEvent(db, {
          action: 'escalation.created', actorId: principal.subject, actorRole: sessionRole(principal),
          tenantId: principal.tenantId ?? null, resourceType: 'escalation', resourceId: ticket._id,
          requestId, metadata: { status: 'open' }, createdAt: now,
        }, session);
        return ticket;
      });
      return { ticket, duplicate: false };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        const retried = await matchIdempotentRetry(await existingTicket());
        if (retried) return retried;
      }
      throw error;
    }
  }

  async listMine(principal: AuthenticatedPrincipal, page: number, pageSize: number) {
    const db = await this.database();
    const filter = requesterScope(principal);
    const tickets = collection<EscalationTicket>(db, 'escalations');
    const [rows, total] = await Promise.all([
      tickets.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      tickets.countDocuments(filter),
    ]);
    return { tickets: rows, pagination: { page, pageSize, total } };
  }

  async getMine(principal: AuthenticatedPrincipal, ticketId: string) {
    const db = await this.database();
    return collection<EscalationTicket>(db, 'escalations').findOne({ _id: ticketId, ...requesterScope(principal) });
  }

  async listQueue(principal: AuthenticatedPrincipal, status: EscalationStatus | undefined, page: number, pageSize: number) {
    const db = await this.database();
    const filter = { ...tenantScope(principal), ...(status ? { status } : {}) };
    const tickets = collection<EscalationTicket>(db, 'escalations');
    const [rows, total] = await Promise.all([
      tickets.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      tickets.countDocuments(filter),
    ]);
    return { tickets: rows, pagination: { page, pageSize, total } };
  }

  async getForHr(principal: AuthenticatedPrincipal, ticketId: string) {
    const db = await this.database();
    return collection<EscalationTicket>(db, 'escalations').findOne({ _id: ticketId, ...tenantScope(principal) });
  }

  async updateStatus(principal: AuthenticatedPrincipal, ticketId: string, status: EscalationStatus, expectedVersion: number, requestId?: string) {
    const db = await this.database();
    return this.transaction(db, async (session) => {
      const tickets = collection<EscalationTicket>(db, 'escalations');
      const current = await tickets.findOne({ _id: ticketId, ...tenantScope(principal) }, { session });
      if (!current) throw new EscalationServiceError('NOT_FOUND');
      if (current.version !== expectedVersion) throw new EscalationServiceError('VERSION_CONFLICT');
      if (!isValidStatusTransition(current.status, status)) throw new EscalationServiceError('INVALID_TRANSITION');
      const now = new Date();
      const statusUpdate = {
        $set: { status, updatedAt: now, ...(status === 'resolved' ? { resolvedAt: now } : {}) },
        $inc: { version: 1 },
        $push: { statusHistory: { from: current.status, to: status, actorId: principal.subject, actorRole: sessionRole(principal), changedAt: now } },
      } as unknown as UpdateFilter<EscalationTicket>;
      const result = await tickets.updateOne({ _id: ticketId, tenantId: principal.tenantId ?? null, version: expectedVersion }, statusUpdate, { session });
      if (result.modifiedCount !== 1) throw new EscalationServiceError('VERSION_CONFLICT');
      await writeAuditEvent(db, {
        action: status === 'resolved' ? 'escalation.resolved' : status === 'closed' ? 'escalation.closed' : 'escalation.status_changed',
        actorId: principal.subject, actorRole: sessionRole(principal),
        tenantId: principal.tenantId ?? null, resourceType: 'escalation', resourceId: ticketId,
        requestId, metadata: { from: current.status, to: status }, createdAt: now,
      }, session);
      const updated = await tickets.findOne({ _id: ticketId, ...tenantScope(principal) }, { session });
      if (!updated) throw new EscalationServiceError('NOT_FOUND');
      return updated;
    });
  }

  async addNote(principal: AuthenticatedPrincipal, ticketId: string, content: string, expectedVersion: number, requestId?: string) {
    const db = await this.database();
    return this.transaction(db, async (session) => {
      const tickets = collection<EscalationTicket>(db, 'escalations');
      const current = await tickets.findOne({ _id: ticketId, ...tenantScope(principal) }, { session });
      if (!current) throw new EscalationServiceError('NOT_FOUND');
      if (current.version !== expectedVersion) throw new EscalationServiceError('VERSION_CONFLICT');
      if (current.internalNotes.length >= 1000) throw new EscalationServiceError('NOTE_LIMIT_REACHED');
      const now = new Date();
      const noteUpdate = {
        $set: { updatedAt: now },
        $inc: { version: 1 },
        $push: { internalNotes: { id: randomUUID(), authorId: principal.subject, createdAt: now, content } },
      } as unknown as UpdateFilter<EscalationTicket>;
      const result = await tickets.updateOne({ _id: ticketId, tenantId: principal.tenantId ?? null, version: expectedVersion }, noteUpdate, { session });
      if (result.modifiedCount !== 1) throw new EscalationServiceError('VERSION_CONFLICT');
      await writeAuditEvent(db, {
        action: 'escalation.internal_note_created', actorId: principal.subject, actorRole: sessionRole(principal),
        tenantId: principal.tenantId ?? null, resourceType: 'escalation', resourceId: ticketId,
        requestId, metadata: { noteAdded: true }, createdAt: now,
      }, session);
      const updated = await tickets.findOne({ _id: ticketId, ...tenantScope(principal) }, { session });
      if (!updated) throw new EscalationServiceError('NOT_FOUND');
      return updated;
    });
  }
}

export function createMongoEscalationService(): EscalationService {
  return new MongoEscalationService();
}
