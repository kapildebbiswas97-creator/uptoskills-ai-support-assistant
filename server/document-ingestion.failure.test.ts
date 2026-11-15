import assert from 'node:assert/strict';
import test from 'node:test';
import type { Db } from 'mongodb';
import { createDocumentService, type MalwareScanner } from './document-ingestion';
import type { IndexedChunk } from './database';
import type { AuthenticatedPrincipal } from './auth';

const principal: AuthenticatedPrincipal = { subject: 'manager-1', tenantId: 'tenant-a', roles: ['knowledge_manager'] };
const upload = { filename: 'policy.txt', mediaType: 'text/plain', bytes: Buffer.from('Approved leave requests must be submitted in advance.') };
const scanner: MalwareScanner = { scan: async () => 'clean' };
const embedder = async (texts: string[]) => texts.map(() => Array<number>(768).fill(0.01));

test('PostgreSQL write failure leaves a durable failed Mongo job and reconciles idempotently', async () => {
  const mongo = new FakeMongo();
  const chunks = new FakeChunkStore();
  chunks.failReplace = true;
  const service = createDocumentService(async () => mongo.asDb(), chunks, scanner, embedder)!;
  await assert.rejects(() => service.ingest(principal, upload), /VECTOR_STORE_DOWN/);
  assert.equal(mongo.documents[0].status, 'failed');
  assert.equal(mongo.jobs[0].state, 'failed');

  chunks.failReplace = false;
  assert.deepEqual(await service.recoverPending(10), { recovered: 1, failed: 0 });
  assert.equal(mongo.documents[0].status, 'ready');
  assert.equal(mongo.jobs[0].state, 'complete');
  const duplicate = await service.ingest(principal, upload);
  assert.equal(duplicate.duplicate, true);
  await service.close();
});

test('concurrent duplicate ingestion returns the existing Mongo document', async () => {
  const mongo = new FakeMongo();
  const chunks = new FakeChunkStore();
  const service = createDocumentService(async () => mongo.asDb(), chunks, scanner, embedder)!;
  const results = await Promise.all([service.ingest(principal, upload), service.ingest(principal, upload)]);
  assert.equal(mongo.documents.length, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 1);
  assert.equal(mongo.documents[0].status, 'ready');
  await service.close();
});

test('vector commit followed by failed Mongo job acknowledgement is repaired by reconciliation', async () => {
  const mongo = new FakeMongo();
  mongo.jobCollection.failNextCompletion = true;
  const chunks = new FakeChunkStore();
  const service = createDocumentService(async () => mongo.asDb(), chunks, scanner, embedder)!;
  await assert.rejects(() => service.ingest(principal, upload), /MONGO_ACK_DOWN/);
  assert.equal(chunks.indexed.size, 1);
  assert.equal(mongo.documents[0].status, 'failed');
  assert.deepEqual(await service.recoverPending(10), { recovered: 2, failed: 0 });
  assert.equal(mongo.documents[0].status, 'ready');
  assert.equal(mongo.jobs[0].state, 'complete');
  await service.close();
});

test('MongoDB outage prevents durable document creation', async () => {
  const chunks = new FakeChunkStore();
  const service = createDocumentService(async () => { throw new Error('MONGO_DOWN'); }, chunks, scanner, embedder)!;
  await assert.rejects(() => service.ingest(principal, upload), /MONGO_DOWN/);
  assert.equal(chunks.indexed.size, 0);
  await service.close();
});

test('reconciliation recreates a missing job for an orphaned Mongo document', async () => {
  const mongo = new FakeMongo();
  mongo.documents.push({
    _id: 'orphan-doc', tenantId: 'tenant-a', ownerId: 'manager-1', filename: upload.filename,
    mediaType: upload.mediaType, sha256: 'a'.repeat(64), status: 'processing', chunkCount: 0,
    content: upload.bytes, createdAt: new Date(), updatedAt: new Date(),
  });
  const chunks = new FakeChunkStore();
  const service = createDocumentService(async () => mongo.asDb(), chunks, scanner, embedder)!;
  assert.deepEqual(await service.recoverPending(10), { recovered: 1, failed: 0 });
  assert.equal(mongo.jobs.length, 1);
  assert.equal(mongo.documents[0].status, 'ready');
  await service.close();
});

test('reconciliation detects ready Mongo documents whose PostgreSQL chunks are missing', async () => {
  const mongo = new FakeMongo();
  mongo.documents.push({
    _id: 'missing-vector-doc', tenantId: 'tenant-a', ownerId: 'manager-1', filename: upload.filename,
    mediaType: upload.mediaType, sha256: 'b'.repeat(64), status: 'ready', chunkCount: 1,
    content: upload.bytes, createdAt: new Date(), updatedAt: new Date(),
  });
  mongo.jobs.push({ _id: 'missing-vector-doc', documentId: 'missing-vector-doc', tenantId: 'tenant-a', ownerId: 'manager-1', state: 'complete', attempts: 1, createdAt: new Date(), updatedAt: new Date() });
  const service = createDocumentService(async () => mongo.asDb(), new FakeChunkStore(), scanner, embedder)!;
  assert.deepEqual(await service.recoverPending(10), { recovered: 1, failed: 0 });
  assert.equal(mongo.documents[0].status, 'ready');
  assert.equal(mongo.jobs[0].state, 'complete');
  await service.close();
});

test('document tombstone during vector indexing removes the late index and is reconciled', async () => {
  const mongo = new FakeMongo();
  const chunks = new FakeChunkStore();
  chunks.beforeReplace = () => { mongo.documents[0].status = 'deleting'; };
  const service = createDocumentService(async () => mongo.asDb(), chunks, scanner, embedder)!;
  await assert.rejects(() => service.ingest(principal, upload), /DOCUMENT_STATE_CHANGED/);
  assert.equal(chunks.indexed.size, 0);
  assert.equal(mongo.documents[0].status, 'deleting');
  assert.deepEqual(await service.recoverPending(10), { recovered: 1, failed: 0 });
  assert.equal(mongo.documents.length, 0);
  await service.close();
});

class FakeMongo {
  documents: Array<Record<string, any>> = [];
  jobs: Array<Record<string, any>> = [];
  audits: Array<Record<string, any>> = [];
  readonly documentCollection = new FakeCollection(() => this.documents);
  readonly jobCollection = new FakeCollection(() => this.jobs);
  readonly auditCollection = new FakeCollection(() => this.audits);
  readonly collections = { documents: this.documentCollection, ingestion_jobs: this.jobCollection, audit_logs: this.auditCollection };

  asDb(): Db {
    return { collection: (name: string) => this.collections[name as keyof typeof this.collections] } as unknown as Db;
  }
}

class FakeCollection {
  failNextCompletion = false;
  constructor(private readonly rows: () => Array<Record<string, any>>) {}

  async findOne(query: Record<string, any>): Promise<Record<string, any> | null> {
    return this.rows().find((row) => matches(row, query)) ?? null;
  }

  find(query: Record<string, any>) {
    const rows = this.rows();
    let limit = Number.POSITIVE_INFINITY;
    return {
      limit(count: number) { limit = count; return this; },
      toArray: async () => rows.filter((row) => matches(row, query)).slice(0, limit),
    };
  }

  async insertOne(record: Record<string, any>): Promise<void> {
    if (record.documentId && this.rows().some((row) => row.documentId === record.documentId)) throw duplicateKey();
    if (record.sha256 && this.rows().some((row) => row.sha256 === record.sha256 && row.ownerId === record.ownerId && row.tenantId === record.tenantId)) throw duplicateKey();
    this.rows().push({ ...record });
  }

  async updateOne(query: Record<string, any>, update: Record<string, any>): Promise<{ modifiedCount: number }> {
    if (this.failNextCompletion && update.$set?.state === 'complete') {
      this.failNextCompletion = false;
      throw new Error('MONGO_ACK_DOWN');
    }
    const row = this.rows().find((candidate) => matches(candidate, query));
    if (!row) return { modifiedCount: 0 };
    Object.assign(row, update.$set ?? {});
    for (const [key, amount] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(amount);
    return { modifiedCount: 1 };
  }

  async findOneAndUpdate(query: Record<string, any>, update: Record<string, any>): Promise<Record<string, any> | null> {
    let row: Record<string, any> | undefined;
    if (query.$or) row = this.rows().find((candidate) => candidate.attempts < 5 && ['pending', 'failed'].includes(candidate.state));
    else row = this.rows().find((candidate) => matches(candidate, query));
    if (!row) return null;
    Object.assign(row, update.$set ?? {});
    for (const [key, amount] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(amount);
    return { ...row };
  }

  async deleteOne(query: Record<string, any>): Promise<void> {
    const index = this.rows().findIndex((row) => matches(row, query));
    if (index >= 0) this.rows().splice(index, 1);
  }

  async deleteMany(query: Record<string, any>): Promise<void> {
    const kept = this.rows().filter((row) => !matches(row, query));
    this.rows().splice(0, this.rows().length, ...kept);
  }
}

class FakeChunkStore {
  indexed = new Map<string, IndexedChunk[]>();
  failReplace = false;
  beforeReplace?: () => void;
  async replaceDocumentChunks(chunks: IndexedChunk[]) {
    this.beforeReplace?.();
    if (this.failReplace) throw new Error('VECTOR_STORE_DOWN');
    this.indexed.set(chunks[0].documentId, chunks);
  }
  async deleteDocumentChunks(documentId: string) { this.indexed.delete(documentId); }
  async hasDocumentChunks(documentId: string) { return this.indexed.has(documentId); }
  async listDocumentIds() { return [...this.indexed.keys()]; }
  async close() {}
}

function matches(row: Record<string, any>, query: Record<string, any>): boolean {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some((part: Record<string, unknown>) => matches(row, part));
    const actual = row[key];
    if (expected && typeof expected === 'object') {
      if ('$ne' in expected) return actual !== expected.$ne;
      if ('$in' in expected) return expected.$in.includes(actual);
    }
    return actual === expected;
  });
}

function duplicateKey(): Error & { code: number } {
  return Object.assign(new Error('duplicate key'), { code: 11000 });
}
