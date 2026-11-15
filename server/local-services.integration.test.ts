import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { Pool } from 'pg';
import { createRemoteJWKSet } from 'jose';
import { createDocumentChunkStore, setSignedRlsContext, vectorLiteral } from './database';
import { createMalwareScanner, createDocumentService, type MalwareScanner } from './document-ingestion';
import { initializeMongoSchema } from './mongodb';
import { createRequestRateLimiter } from './rate-limit';
import { verifyAccessToken, type AppRole } from './auth';

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];

function localUrl(value: string | undefined, protocols: string[], label: string): URL | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !LOCAL.includes(url.hostname)) {
    throw new Error(`${label} integration tests accept loopback URLs only.`);
  }
  return url;
}

function localDatabaseTarget(value: string | undefined, label: string): string | undefined {
  const url = localUrl(value, ['postgres:', 'postgresql:'], label);
  if (!url) return undefined;
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+_integration$/.test(database)) throw new Error(`${label} must target a database ending in _integration.`);
  return value;
}

interface LocalTargets {
  mongoUri: string;
  mongoDatabase: string;
  readerUrl: string;
  writerUrl: string;
}

function serviceTargets(): LocalTargets | undefined {
  if (process.env.RUN_LOCAL_SERVICE_TESTS !== 'true' || process.env.APP_ENV !== 'local-integration') return undefined;
  const mongoUri = process.env.MONGODB_URI;
  const mongoDatabase = process.env.MONGODB_DATABASE;
  const readerUrl = localDatabaseTarget(process.env.DATABASE_URL, 'DATABASE_URL');
  const writerUrl = localDatabaseTarget(process.env.DATABASE_INGEST_URL, 'DATABASE_INGEST_URL');
  if (!mongoUri || !mongoDatabase || !readerUrl || !writerUrl) {
    throw new Error('Local service tests require loopback MongoDB, PostgreSQL reader and writer URLs, plus a database name ending in _integration.');
  }
  localUrl(mongoUri, ['mongodb:'], 'MONGODB_URI');
  if (!/^[a-z0-9_]+_integration$/.test(mongoDatabase)) throw new Error('MONGODB_DATABASE must end in _integration.');
  if (!process.env.RLS_CONTEXT_KEY_ID || !process.env.RLS_CONTEXT_HMAC_KEY) throw new Error('Local service tests require a provisioned signed RLS context key.');
  return { mongoUri, mongoDatabase, readerUrl, writerUrl };
}

const targets = serviceTargets();

test('local MongoDB and PostgreSQL services verify pgvector and dual-database lifecycle', { skip: targets ? undefined : 'Requires explicit local-integration mode and loopback *_integration databases.' }, async () => {
  assert.ok(targets);
  const mongoClient = new MongoClient(targets.mongoUri, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 });
  const reader = new Pool({ connectionString: targets.readerUrl, connectionTimeoutMillis: 3000, query_timeout: 8000, max: 1 });
  const mongoDb = undefined as never;
  let db: Db | undefined;
  let service: ReturnType<typeof createDocumentService> | undefined;
  let fixtureOwner: string | undefined;
  try {
    await mongoClient.connect();
    db = mongoClient.db(targets.mongoDatabase);
    await db.command({ ping: 1 });
    await initializeMongoSchema(db);

    const vectorCheck = await reader.query<{ dims: number; extension: string | null }>(
      `SELECT vector_dims($1::vector) AS dims,
              (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS extension`,
      [vectorLiteral(Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0))]
    );
    assert.equal(vectorCheck.rows[0]?.dims, 768);
    assert.ok(vectorCheck.rows[0]?.extension, 'pgvector extension must be installed');

    const owner = `local-service-${randomUUID()}`;
    fixtureOwner = owner;
    const tenantId = `tenant-${randomUUID()}`;
    const principal = { subject: owner, tenantId, roles: ['super_admin'] as AppRole[] };
    const scanner: MalwareScanner = { scan: async () => 'clean' };
    const embedder = async (texts: string[]) => texts.map(() => Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0));
    const createService = (writerUrl: string) => {
      const store = createDocumentChunkStore(writerUrl);
      assert.ok(store);
      return createDocumentService(() => Promise.resolve(db!), store, scanner, embedder);
    };
    service = createService(targets.writerUrl);
    assert.ok(service);

    const upload = { filename: 'integration.txt', mediaType: 'text/plain', bytes: Buffer.from('Local integration fixture: cross-database persistence and idempotency.') };
    const first = await service.ingest(principal, upload);
    assert.equal(first.status, 'ready');
    assert.equal(first.duplicate, false);
    const duplicate = await service.ingest(principal, upload);
    assert.equal(duplicate.documentId, first.documentId);
    assert.equal(duplicate.duplicate, true);

    const status = await service.getStatus(principal, first.documentId);
    assert.equal(status?.status, 'ready');
    const readerClient = await reader.connect();
    try {
      await readerClient.query('BEGIN');
      await setSignedRlsContext(readerClient, tenantId, false, 'uts_assistant_reader');
      const chunks = await readerClient.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM knowledge.document_chunks WHERE document_id = $1', [first.documentId]
      );
      assert.equal(Number(chunks.rows[0]?.count), first.chunkCount);
      await readerClient.query('COMMIT');
    } catch (error) {
      await readerClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      readerClient.release();
    }

    assert.equal(await service.delete(principal, first.documentId), true);
    assert.equal(await service.getStatus(principal, first.documentId), undefined);

    // Simulate a loopback PostgreSQL outage during ingestion while MongoDB remains available.
    const unavailableWriter = new URL(targets.writerUrl);
    unavailableWriter.port = '1';
    const outageService = createService(unavailableWriter.toString());
    assert.ok(outageService);
    await assert.rejects(() => outageService.ingest(principal, {
      ...upload,
      filename: 'recovery-fixture.txt',
      bytes: Buffer.from('Local recovery fixture after PostgreSQL outage.'),
    }));
    await outageService.close();

    const recoveryService = createService(targets.writerUrl);
    assert.ok(recoveryService);
    service = recoveryService;
    const recovery = await recoveryService.recoverPending();
    assert.ok(recovery.recovered >= 1);
    const recovered = await db.collection<{ _id: string; ownerId: string; status: string }>('documents').findOne({ ownerId: owner, filename: 'recovery-fixture.txt' });
    assert.equal(recovered?.status, 'ready');
    if (recovered) assert.equal(await recoveryService.delete(principal, recovered._id), true);
  } finally {
    if (service && db && fixtureOwner) {
      const remaining = await db.collection<{ _id: string }>('documents').find({ ownerId: fixtureOwner }, { projection: { _id: 1 } }).toArray().catch(() => []);
      for (const document of remaining) await service.delete({ subject: fixtureOwner, roles: ['super_admin'] }, document._id).catch(() => false);
    }
    await service?.close();
    await Promise.all([reader.end(), mongoClient.close()]);
  }
});

const redisUrl = process.env.APP_ENV === 'local-integration' ? localUrl(process.env.REDIS_URL, ['redis:', 'rediss:'], 'REDIS_URL') : undefined;
test('local Redis coordinates rate limits across limiter instances', { skip: process.env.APP_ENV === 'local-integration' && redisUrl ? undefined : 'Requires APP_ENV=local-integration and a loopback Redis URL.' }, async () => {
  assert.ok(redisUrl);
  const first = await createRequestRateLimiter(redisUrl.toString());
  const second = await createRequestRateLimiter(redisUrl.toString());
  const address = `integration-${randomUUID()}`;
  try {
    assert.equal(first.backend, 'redis');
    assert.equal(second.backend, 'redis');
    for (let i = 0; i < 40; i += 1) assert.equal(await first.allow(address), true);
    assert.equal(await second.allow(address), false);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

const scannerUrl = process.env.APP_ENV === 'local-integration' ? localUrl(process.env.MALWARE_SCANNER_URL, ['http:', 'https:'], 'MALWARE_SCANNER_URL') : undefined;
test('local malware scanner accepts a harmless fixture and adapter fails closed when unavailable', { skip: process.env.APP_ENV === 'local-integration' && scannerUrl && process.env.MALWARE_SCANNER_TOKEN ? undefined : 'Requires APP_ENV=local-integration and a loopback scanner endpoint/token.' }, async () => {
  assert.ok(scannerUrl);
  const scanner = createMalwareScanner(process.env);
  assert.ok(scanner);
  assert.equal(await scanner.scan(Buffer.from('harmless scanner integration fixture'), 'safe.txt'), 'clean');

  const unavailable = createMalwareScanner({
    ...process.env,
    MALWARE_SCANNER_URL: 'http://127.0.0.1:1/scan',
    MALWARE_SCANNER_TOKEN: 'local-integration-only',
  });
  assert.ok(unavailable);
  await assert.rejects(() => unavailable.scan(Buffer.from('harmless fixture'), 'safe.txt'), /SCANNER_UNAVAILABLE/);
});

const issuerUrl = process.env.APP_ENV === 'local-integration' ? localUrl(process.env.LOCAL_OIDC_ISSUER, ['http:', 'https:'], 'LOCAL_OIDC_ISSUER') : undefined;
const jwksUrl = process.env.APP_ENV === 'local-integration' ? localUrl(process.env.LOCAL_OIDC_JWKS_URL, ['http:', 'https:'], 'LOCAL_OIDC_JWKS_URL') : undefined;
test('local OIDC issuer accepts its test token and rejects an invalid token', { skip: process.env.APP_ENV === 'local-integration' && issuerUrl && jwksUrl && process.env.LOCAL_OIDC_AUDIENCE && process.env.LOCAL_OIDC_VALID_TOKEN ? undefined : 'Requires a loopback OIDC issuer/JWKS and an explicitly supplied local test token.' }, async () => {
  assert.ok(issuerUrl && jwksUrl && process.env.LOCAL_OIDC_AUDIENCE && process.env.LOCAL_OIDC_VALID_TOKEN);
  const resolver = createRemoteJWKSet(jwksUrl);
  const settings = {
    issuer: issuerUrl.toString().replace(/\/$/, ''),
    audience: process.env.LOCAL_OIDC_AUDIENCE,
    roleMapping: { 'integration-user': 'user' as const },
  };
  const principal = await verifyAccessToken(process.env.LOCAL_OIDC_VALID_TOKEN, settings, resolver);
  assert.ok(principal.subject);
  await assert.rejects(() => verifyAccessToken('not.a.valid.token', settings, resolver));
});
