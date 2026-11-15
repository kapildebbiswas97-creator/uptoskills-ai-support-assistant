import { Binary, MongoClient, type ClientSession, type Collection, type Db, type Document, type IndexDescription } from 'mongodb';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedPrincipal } from './auth';

export interface ConversationRecord extends Document {
  _id: string;
  tenantId: string | null;
  ownerId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface MessageRecord extends Document {
  _id: string;
  conversationId: string;
  tenantId: string | null;
  ownerId: string;
  role: 'user' | 'assistant';
  content: string;
  source: 'model' | 'local' | 'local-fallback';
  createdAt: Date;
}

export interface DocumentRecord extends Document {
  _id: string;
  tenantId: string | null;
  ownerId: string;
  filename: string;
  mediaType: string;
  sha256: string;
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'deleting';
  chunkCount: number;
  createdAt: Date;
  updatedAt: Date;
  failureCode?: string;
  content?: Buffer | Binary;
}

export interface IngestionJob extends Document {
  _id: string;
  documentId: string;
  tenantId: string | null;
  ownerId: string;
  state: 'pending' | 'processing' | 'complete' | 'failed';
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  lastErrorCode?: string;
}

export interface AuditEvent extends Document {
  action: string;
  actorId: string;
  actorRole?: string;
  tenantId: string | null;
  resourceType: string;
  resourceId?: string;
  requestId?: string;
  metadata?: Record<string, string | number | boolean | null>;
  createdAt: Date;
}

let clientPromise: Promise<MongoClient> | undefined;

export function mongoConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(environment.MONGODB_URI && environment.MONGODB_DATABASE);
}

export async function getMongoDatabase(environment: NodeJS.ProcessEnv = process.env): Promise<Db> {
  const uri = environment.MONGODB_URI;
  const databaseName = environment.MONGODB_DATABASE;
  if (!uri || !databaseName) throw new Error('MongoDB is not configured');
  if (!clientPromise) {
    const client = new MongoClient(uri, {
      appName: 'uptoskills-ai-support-assistant',
      maxPoolSize: Number(environment.MONGODB_MAX_POOL_SIZE || 10),
      minPoolSize: 0,
      maxIdleTimeMS: 30_000,
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
      socketTimeoutMS: 10_000,
      retryReads: true,
      retryWrites: true,
    });
    clientPromise = client.connect().then(() => client).catch((error: unknown) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return (await clientPromise).db(databaseName);
}

export async function closeMongoForTests(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  if (pending) await (await pending).close();
}

export async function startMongoSession(): Promise<ClientSession> {
  if (!clientPromise) throw new Error('MongoDB is not connected');
  return (await clientPromise).startSession();
}

const validators: Record<string, Document> = {
  users: { $jsonSchema: { bsonType: 'object', required: ['_id', 'subject', 'createdAt', 'updatedAt'], properties: { _id: { bsonType: 'string' }, subject: { bsonType: 'string', minLength: 1 }, email: { bsonType: ['string', 'null'] }, createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' } } } },
  organizations: { $jsonSchema: { bsonType: 'object', required: ['_id', 'name', 'createdAt'], properties: { _id: { bsonType: 'string' }, name: { bsonType: 'string', minLength: 1, maxLength: 200 }, createdAt: { bsonType: 'date' } } } },
  memberships: { $jsonSchema: { bsonType: 'object', required: ['tenantId', 'subject', 'roles', 'createdAt'], properties: { tenantId: { bsonType: 'string' }, subject: { bsonType: 'string' }, roles: { bsonType: 'array', items: { enum: ['super_admin', 'admin', 'support_agent', 'knowledge_manager', 'user'] } }, createdAt: { bsonType: 'date' } } } },
  conversations: { $jsonSchema: { bsonType: 'object', required: ['_id', 'ownerId', 'title', 'createdAt', 'updatedAt'], properties: { _id: { bsonType: 'string' }, ownerId: { bsonType: 'string' }, title: { bsonType: 'string', maxLength: 200 }, createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' } } } },
  messages: { $jsonSchema: { bsonType: 'object', required: ['_id', 'conversationId', 'ownerId', 'role', 'content', 'createdAt'], properties: { _id: { bsonType: 'string' }, conversationId: { bsonType: 'string' }, ownerId: { bsonType: 'string' }, role: { enum: ['user', 'assistant'] }, content: { bsonType: 'string', maxLength: 20000 }, createdAt: { bsonType: 'date' } } } },
  documents: { $jsonSchema: { bsonType: 'object', required: ['_id', 'ownerId', 'filename', 'mediaType', 'sha256', 'status', 'createdAt', 'updatedAt'], properties: { _id: { bsonType: 'string' }, ownerId: { bsonType: 'string' }, filename: { bsonType: 'string', maxLength: 240 }, mediaType: { bsonType: 'string' }, sha256: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, status: { enum: ['pending', 'processing', 'ready', 'failed', 'deleting'] }, createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' } } } },
  document_permissions: { $jsonSchema: { bsonType: 'object', required: ['documentId', 'subject', 'createdAt'], properties: { documentId: { bsonType: 'string' }, subject: { bsonType: 'string' }, tenantId: { bsonType: ['string', 'null'] }, createdAt: { bsonType: 'date' } } } },
  ingestion_jobs: { $jsonSchema: { bsonType: 'object', required: ['_id', 'documentId', 'ownerId', 'state', 'attempts', 'createdAt', 'updatedAt'], properties: { _id: { bsonType: 'string' }, documentId: { bsonType: 'string' }, ownerId: { bsonType: 'string' }, state: { enum: ['pending', 'processing', 'complete', 'failed'] }, attempts: { bsonType: 'int', minimum: 0 }, createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' } } } },
  audit_logs: { $jsonSchema: { bsonType: 'object', required: ['action', 'actorId', 'resourceType', 'createdAt'], properties: { action: { bsonType: 'string' }, actorId: { bsonType: 'string' }, resourceType: { bsonType: 'string' }, createdAt: { bsonType: 'date' } } } },
  escalations: { $jsonSchema: { bsonType: 'object', required: ['_id', 'reference', 'tenantId', 'requesterId', 'subject', 'description', 'consent', 'status', 'version', 'statusHistory', 'internalNotes', 'idempotencyKey', 'requestHash', 'createdAt', 'updatedAt'], properties: { _id: { bsonType: 'string' }, reference: { bsonType: 'string', minLength: 20, maxLength: 40 }, tenantId: { bsonType: ['string', 'null'] }, requesterId: { bsonType: 'string', minLength: 1, maxLength: 200 }, conversationId: { bsonType: ['string', 'null'] }, subject: { bsonType: 'string', minLength: 5, maxLength: 120 }, description: { bsonType: 'string', minLength: 10, maxLength: 10000 }, category: { bsonType: ['string', 'null'], maxLength: 100 }, consent: { bsonType: 'object', required: ['accepted', 'version', 'text', 'at'], properties: { accepted: { enum: [true] }, version: { bsonType: 'string' }, text: { bsonType: 'string', maxLength: 500 }, at: { bsonType: 'date' } } }, status: { enum: ['open', 'in_progress', 'resolved', 'closed'] }, version: { bsonType: 'int', minimum: 1 }, statusHistory: { bsonType: 'array', maxItems: 1000 }, internalNotes: { bsonType: 'array', maxItems: 1000 }, idempotencyKey: { bsonType: 'string', minLength: 16, maxLength: 128 }, requestHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, resolvedAt: { bsonType: ['date', 'null'] }, createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' } } } },
  meeting_requests: { $jsonSchema: { bsonType: 'object', required: ['_id', 'reference', 'tenantId', 'requesterId', 'conversationId', 'subject', 'purpose', 'preferredTimes', 'timeZone', 'status', 'version', 'statusHistory', 'confirmation', 'rejectionReason', 'idempotencyKey', 'requestHash', 'createdAt', 'updatedAt'], properties: { _id: { bsonType: 'string' }, reference: { bsonType: 'string', pattern: '^UTM-[A-F0-9]{36}$' }, tenantId: { bsonType: ['string', 'null'] }, requesterId: { bsonType: 'string', minLength: 1, maxLength: 200 }, conversationId: { bsonType: ['string', 'null'] }, subject: { bsonType: 'string', minLength: 5, maxLength: 120 }, purpose: { bsonType: 'string', minLength: 10, maxLength: 2000 }, preferredTimes: { bsonType: 'array', minItems: 1, maxItems: 3, items: { bsonType: 'object', required: ['startAt', 'endAt'], properties: { startAt: { bsonType: 'date' }, endAt: { bsonType: 'date' } } } }, timeZone: { bsonType: 'string', minLength: 1, maxLength: 100 }, status: { enum: ['pending', 'confirmed', 'rejected', 'cancelled'] }, version: { bsonType: 'int', minimum: 1 }, statusHistory: { bsonType: 'array', maxItems: 1000 }, confirmation: { bsonType: ['object', 'null'] }, rejectionReason: { bsonType: ['string', 'null'], maxLength: 1000 }, idempotencyKey: { bsonType: 'string', minLength: 16, maxLength: 128 }, requestHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' }, createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' } } } },
  system_settings: { $jsonSchema: { bsonType: 'object', required: ['_id', 'updatedAt'], properties: { _id: { bsonType: 'string' }, updatedAt: { bsonType: 'date' } } } },
};

const indexes: Record<string, IndexDescription[]> = {
  users: [{ key: { subject: 1 }, name: 'users_subject_unique', unique: true }, { key: { email: 1 }, name: 'users_email' }],
  organizations: [{ key: { name: 1 }, name: 'organizations_name' }],
  memberships: [{ key: { tenantId: 1, subject: 1 }, name: 'memberships_tenant_subject_unique', unique: true }],
  conversations: [{ key: { tenantId: 1, ownerId: 1, updatedAt: -1 }, name: 'conversations_owner_updated' }],
  messages: [{ key: { tenantId: 1, conversationId: 1, createdAt: 1 }, name: 'messages_conversation_created' }, { key: { ownerId: 1, createdAt: -1 }, name: 'messages_owner_created' }],
  documents: [{ key: { tenantId: 1, ownerId: 1, status: 1 }, name: 'documents_owner_status' }, { key: { tenantId: 1, sha256: 1, ownerId: 1 }, name: 'documents_duplicate_unique', unique: true }],
  document_permissions: [{ key: { tenantId: 1, documentId: 1, subject: 1 }, name: 'document_permission_unique', unique: true }],
  ingestion_jobs: [{ key: { documentId: 1 }, name: 'ingestion_jobs_document' }, { key: { state: 1, updatedAt: 1 }, name: 'ingestion_jobs_retry' }],
  audit_logs: [{ key: { tenantId: 1, createdAt: -1 }, name: 'audit_tenant_created' }],
  escalations: [
    { key: { reference: 1 }, name: 'escalations_reference_unique', unique: true },
    { key: { tenantId: 1, requesterId: 1, createdAt: -1 }, name: 'escalations_requester_created' },
    { key: { tenantId: 1, status: 1, createdAt: -1 }, name: 'escalations_queue_status_created' },
    { key: { tenantId: 1, requesterId: 1, idempotencyKey: 1 }, name: 'escalations_requester_idempotency_unique', unique: true },
  ],
  meeting_requests: [
    { key: { reference: 1 }, name: 'meeting_requests_reference_unique', unique: true },
    { key: { tenantId: 1, requesterId: 1, createdAt: -1 }, name: 'meeting_requests_requester_created' },
    { key: { tenantId: 1, status: 1, createdAt: -1 }, name: 'meeting_requests_queue_status_created' },
    { key: { tenantId: 1, requesterId: 1, idempotencyKey: 1 }, name: 'meeting_requests_requester_idempotency_unique', unique: true },
  ],
  system_settings: [],
};

export async function initializeMongoSchema(db: Db): Promise<void> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name));
  for (const [name, validator] of Object.entries(validators)) {
    if (!existing.has(name)) {
      await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' });
    }
    const collection = db.collection(name);
    for (const index of indexes[name] ?? []) await collection.createIndex(index.key, { name: index.name, unique: index.unique });
  }
}

export function collection<T extends Document>(db: Db, name: string): Collection<T> {
  return db.collection<T>(name);
}

export function tenantFilter(principal: AuthenticatedPrincipal): { ownerId: string; tenantId: string | null } {
  return { ownerId: principal.subject, tenantId: principal.tenantId ?? null };
}

export async function writeAuditEvent(db: Db, event: Omit<AuditEvent, '_id'>, session?: ClientSession): Promise<void> {
  await db.collection<AuditEvent>('audit_logs').insertOne(event as AuditEvent, { session });
}

export function conversationScope(principal: AuthenticatedPrincipal, conversationId: string): Pick<ConversationRecord, '_id' | 'ownerId' | 'tenantId'> {
  return { _id: conversationId, ownerId: principal.subject, tenantId: principal.tenantId ?? null };
}

export async function saveConversationTurn(
  db: Db,
  principal: AuthenticatedPrincipal,
  conversationId: string | undefined,
  userContent: string,
  assistantContent: string,
  source: MessageRecord['source']
): Promise<string> {
  const id = conversationId ?? randomUUID();
  const tenantId = principal.tenantId ?? null;
  const now = new Date();
  const conversations = db.collection<ConversationRecord>('conversations');
  await conversations.updateOne(
    conversationScope(principal, id),
    { $setOnInsert: { title: userContent.slice(0, 200), createdAt: now, archivedAt: null }, $set: { updatedAt: now } },
    { upsert: true }
  );
  const messages = db.collection<MessageRecord>('messages');
  await messages.insertMany([
    { _id: randomUUID(), conversationId: id, tenantId, ownerId: principal.subject, role: 'user', content: userContent.slice(0, 20_000), source: 'local', createdAt: now },
    { _id: randomUUID(), conversationId: id, tenantId, ownerId: principal.subject, role: 'assistant', content: assistantContent.slice(0, 20_000), source, createdAt: new Date(now.getTime() + 1) },
  ]);
  return id;
}
