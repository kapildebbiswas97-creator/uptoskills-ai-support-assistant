import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { Binary, type Db } from 'mongodb';
import type { AuthenticatedPrincipal } from './auth.js';
import { collection, getMongoDatabase, writeAuditEvent, type DocumentRecord, type IngestionJob } from './mongodb.js';
import { createDocumentChunkStore, type IndexedChunk } from './database.js';
import { EMBEDDING_MODEL, EMBEDDING_VERSION, getEmbeddingConfig, embedTexts } from './embeddings.js';
import { splitIntoChunks } from './knowledge-base.js';
import { logEvent } from './observability.js';

// Keep the encoded JSON request comfortably below Vercel's 4.5 MB function payload limit.
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;
export const MAX_DOCUMENT_CHUNKS = 1200;
const MAX_ACTIVE_PARSER_WORKERS = 2;
let activeParserWorkers = 0;
const ALLOWED_TYPES: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.txt': ['text/plain'],
  '.md': ['text/markdown', 'text/plain'],
  '.html': ['text/html'],
};

export interface UploadedDocument {
  filename: string;
  mediaType: string;
  bytes: Buffer;
}

export interface DocumentService {
  ingest(principal: AuthenticatedPrincipal, upload: UploadedDocument): Promise<{ documentId: string; status: string; duplicate: boolean; chunkCount?: number }>;
  getStatus(principal: AuthenticatedPrincipal, documentId: string): Promise<{ documentId: string; filename: string; status: string; chunkCount: number } | undefined>;
  delete(principal: AuthenticatedPrincipal, documentId: string): Promise<boolean>;
  recoverPending(limit?: number): Promise<{ recovered: number; failed: number }>;
  close(): Promise<void>;
}

export interface MalwareScanner {
  scan(bytes: Buffer, filename: string, signal?: AbortSignal): Promise<'clean' | 'infected'>;
}

export type DocumentEmbedder = typeof embedTexts;

export async function scanUpload(upload: UploadedDocument, scanner?: MalwareScanner): Promise<void> {
  if (!scanner) throw new Error('SCANNER_UNAVAILABLE');
  const result = await scanner.scan(upload.bytes, path.basename(upload.filename), AbortSignal.timeout(12_000));
  if (result !== 'clean') throw new Error('MALWARE_DETECTED');
}

export function createMalwareScanner(environment: NodeJS.ProcessEnv = process.env): MalwareScanner | undefined {
  const endpoint = environment.MALWARE_SCANNER_URL;
  if (!endpoint) return undefined;
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('MALWARE_SCANNER_URL must be an absolute HTTPS URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(environment.NODE_ENV !== 'production' && local && url.protocol === 'http:')) {
    throw new Error('MALWARE_SCANNER_URL must use HTTPS outside local development');
  }
  if (url.username || url.password || !environment.MALWARE_SCANNER_TOKEN) throw new Error('MALWARE_SCANNER_TOKEN is required and scanner URL credentials are not allowed');
  return {
    async scan(bytes, filename, signal) {
      const timeout = AbortSignal.timeout(10_000);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            authorization: `Bearer ${environment.MALWARE_SCANNER_TOKEN}`,
            'content-type': 'application/octet-stream',
            'x-file-name': encodeURIComponent(path.basename(filename)),
          },
          body: new Uint8Array(bytes),
          signal: combined,
        });
      } catch {
        throw new Error('SCANNER_UNAVAILABLE');
      }
      if (!response.ok) throw new Error('SCANNER_UNAVAILABLE');
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > 1024) throw new Error('SCANNER_UNAVAILABLE');
      const responseText = await response.text();
      if (responseText.length > 1024) throw new Error('SCANNER_UNAVAILABLE');
      let result: unknown;
      try { result = JSON.parse(responseText); } catch { throw new Error('SCANNER_UNAVAILABLE'); }
      if (typeof result !== 'object' || result === null || !('status' in result)) throw new Error('SCANNER_UNAVAILABLE');
      if (result.status === 'clean') return 'clean';
      if (result.status === 'infected') return 'infected';
      throw new Error('SCANNER_UNAVAILABLE');
    },
  };
}

export function canManageDocuments(principal: AuthenticatedPrincipal): boolean {
  return principal.roles.some((role) => role === 'super_admin' || role === 'admin' || role === 'knowledge_manager');
}

export function documentScope(principal: AuthenticatedPrincipal, documentId: string): Record<string, unknown> {
  if (principal.roles.includes('super_admin')) return { _id: documentId };
  if (principal.tenantId && principal.roles.some((role) => role === 'admin' || role === 'knowledge_manager')) {
    return { _id: documentId, tenantId: principal.tenantId };
  }
  return { _id: documentId, ownerId: principal.subject, tenantId: principal.tenantId ?? null };
}

export function validateUpload(upload: UploadedDocument): { extension: string; sha256: string } {
  const filename = path.basename(upload.filename).trim();
  if (!filename || filename.length > 240 || filename !== upload.filename || /[\\/\x00-\x1f]/.test(filename)) throw new Error('INVALID_FILENAME');
  const extension = path.extname(filename).toLowerCase();
  const allowed = ALLOWED_TYPES[extension];
  if (!allowed || !allowed.includes(upload.mediaType)) throw new Error('UNSUPPORTED_DOCUMENT_TYPE');
  if (!Buffer.isBuffer(upload.bytes) || upload.bytes.length < 1 || upload.bytes.length > MAX_DOCUMENT_BYTES) throw new Error('INVALID_DOCUMENT_SIZE');
  if (extension === '.pdf' && upload.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('INVALID_DOCUMENT');
  if (extension === '.docx' && upload.bytes.subarray(0, 2).toString('ascii') !== 'PK') throw new Error('INVALID_DOCUMENT');
  if (extension === '.docx') validateDocxArchive(upload.bytes);
  if (['.txt', '.md', '.html'].includes(extension)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(upload.bytes); } catch { throw new Error('INVALID_DOCUMENT'); }
    if (upload.bytes.includes(0)) throw new Error('INVALID_DOCUMENT');
  }
  return { extension, sha256: createHash('sha256').update(upload.bytes).digest('hex') };
}

function validateDocxArchive(bytes: Buffer): void {
  const eocdSearchStart = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= eocdSearchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 > bytes.length) throw new Error('INVALID_DOCUMENT');
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk || centralDisk || entriesOnDisk !== entryCount || entryCount < 1 || entryCount > 1024 ||
      entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
      eocd + 22 + commentLength !== bytes.length || centralOffset + centralSize > eocd) throw new Error('INVALID_DOCUMENT');
  let cursor = centralOffset;
  let totalUncompressed = 0;
  let hasDocument = false;
  let hasContentTypes = false;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('INVALID_DOCUMENT');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const fileCommentLength = bytes.readUInt16LE(cursor + 32);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const filename = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const next = cursor + 46 + nameLength + extraLength + fileCommentLength;
    const mode = externalAttributes >>> 16;
    if (next > centralOffset + centralSize || !filename || filename.startsWith('/') || filename.includes('\\') ||
        filename.split('/').some((part) => part === '..') || (flags & 1) !== 0 || ![0, 8].includes(method) ||
        (mode & 0xf000) === 0xa000 || /\.(?:zip|jar|7z|rar)$/i.test(filename)) throw new Error('INVALID_DOCUMENT');
    if (uncompressedSize > 10 * 1024 * 1024 || (compressedSize === 0 && uncompressedSize > 0) ||
        (compressedSize > 0 && uncompressedSize / compressedSize > 100)) throw new Error('ZIP_BOMB');
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('INVALID_DOCUMENT');
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8');
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localName !== filename || localFlags !== flags || localMethod !== method || dataOffset + compressedSize > centralOffset) throw new Error('INVALID_DOCUMENT');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > 20 * 1024 * 1024) throw new Error('ZIP_BOMB');
    if (filename === 'word/document.xml') hasDocument = true;
    if (filename === '[Content_Types].xml') hasContentTypes = true;
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize || !hasDocument || !hasContentTypes) throw new Error('INVALID_DOCUMENT');
}

export interface ExtractedSegment {
  text: string;
  page?: number;
  section?: string;
}

function normalizeSegment(text: string): string {
  return text.replace(/\u0000/g, '').replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function plainTextSegments(text: string, page?: number): ExtractedSegment[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const segments: ExtractedSegment[] = [];
  let section = '';
  let paragraph: string[] = [];
  const flush = () => {
    const value = normalizeSegment(paragraph.join('\n'));
    if (value) segments.push({ text: section ? `${section}\n${value}` : value, ...(page ? { page } : {}), ...(section ? { section } : {}) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const markdownHeading = /^#{1,6}\s+(.+)$/.exec(line)?.[1];
    const underlinedHeading = index + 1 < lines.length && /^\s*(?:={2,}|-{2,})\s*$/.test(lines[index + 1]) ? line : undefined;
    const heading = markdownHeading || underlinedHeading;
    if (heading) {
      flush();
      section = normalizeSegment(heading).slice(0, 200);
      if (underlinedHeading) index += 1;
    } else if (!line) {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return segments;
}

export async function extractDocumentSegments(extension: string, bytes: Buffer): Promise<ExtractedSegment[]> {
  const parsed = await parseInWorker(extension, bytes);
  let segments: ExtractedSegment[];
  if (parsed.segments) {
    segments = parsed.segments;
  } else if (extension === '.pdf') {
    segments = (parsed.pages ?? []).flatMap((page) => plainTextSegments(page.text, page.num));
    if (!segments.length) segments = plainTextSegments(parsed.text);
  } else {
    segments = plainTextSegments(parsed.text);
  }
  segments = segments.map((segment) => ({ ...segment, text: normalizeSegment(segment.text) })).filter((segment) => segment.text.length > 0);
  if (!segments.length) throw new Error('EMPTY_DOCUMENT');
  return segments;
}

export async function extractText(extension: string, bytes: Buffer): Promise<string> {
  return (await extractDocumentSegments(extension, bytes)).map(({ text }) => text).join('\n\n');
}

interface ParsedDocument {
  text: string;
  pages?: Array<{ num: number; text: string }>;
  segments?: ExtractedSegment[];
}

async function parseInWorker(extension: string, bytes: Buffer): Promise<ParsedDocument> {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const data = Buffer.from(workerData.bytes);
      const extension = workerData.extension;
      if (extension === '.pdf') {
        let module;
        try {
          module = await import('pdf-parse');
        } catch {
          parentPort.postMessage({ error: 'PDF_PROCESSING_UNAVAILABLE' });
          return;
        }
        const parser = new module.PDFParse({ data });
        try {
          const result = await parser.getText();
          parentPort.postMessage({ text: result.text, pages: result.pages.map(page => ({ num: page.num, text: page.text })) });
        } finally { await parser.destroy(); }
      } else if (extension === '.docx') {
        const module = await import('mammoth');
        const mammoth = module.default || module;
        const result = await mammoth.convertToHtml({ buffer: data });
        const cheerioModule = await import('cheerio');
        const load = cheerioModule.load;
        const $ = load(result.value);
        $('script,style,noscript,iframe,object,svg,template').remove();
        const segments = [];
        let section = '';
        $('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th').each((_index, element) => {
          const node = $(element);
          const name = element.tagName.toLowerCase();
          const text = node.text().replace(/\\u0000/g, '').replace(/\\r/g, '').replace(/[\\t ]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
          if (!text) return;
          if (/^h[1-6]$/.test(name)) section = text.slice(0, 200);
          else segments.push({ text: section ? section + '\\n' + text : text, ...(section ? { section } : {}) });
        });
        if (!segments.length) {
          const text = ($('body').text() || $.root().text()).replace(/\\u0000/g, '').replace(/\\r/g, '').replace(/[\\t ]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
          if (text) segments.push({ text });
        }
        parentPort.postMessage({ text: '', segments });
      } else if (extension === '.html') {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        const cheerioModule = await import('cheerio');
        const load = cheerioModule.load;
        const $ = load(text);
        $('script,style,noscript,iframe,object,svg,template').remove();
        const segments = [];
        let section = '';
        $('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th').each((_index, element) => {
          const node = $(element);
          const name = element.tagName.toLowerCase();
          const content = node.text().replace(/\\u0000/g, '').replace(/\\r/g, '').replace(/[\\t ]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
          if (!content) return;
          if (/^h[1-6]$/.test(name)) section = content.slice(0, 200);
          else segments.push({ text: section ? section + '\\n' + content : content, ...(section ? { section } : {}) });
        });
        if (!segments.length) {
          const content = ($('body').text() || $.root().text()).replace(/\\u0000/g, '').replace(/\\r/g, '').replace(/[\\t ]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
          if (content) segments.push({ text: content });
        }
        parentPort.postMessage({ text: '', segments });
      } else {
        parentPort.postMessage({ text: new TextDecoder('utf-8', { fatal: true }).decode(data) });
      }
    })().catch(error => parentPort.postMessage({ error: error instanceof Error ? error.name : 'PARSER_FAILED' }));
  `;
  const requestedTimeout = Number(process.env.DOCUMENT_PARSE_TIMEOUT_MS || 10_000);
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(1000, Math.min(requestedTimeout, 30_000)) : 10_000;
  if (activeParserWorkers >= MAX_ACTIVE_PARSER_WORKERS) throw new Error('PARSER_BUSY');
  const worker = new Worker(source, {
    eval: true,
    workerData: { extension, bytes: new Uint8Array(bytes) },
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
  });
  activeParserWorkers += 1;
  return new Promise<ParsedDocument>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: ParsedDocument) => {
      if (settled) return;
      settled = true;
      activeParserWorkers -= 1;
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const timeout = setTimeout(() => finish(new Error('PARSER_TIMEOUT')), timeoutMs);
    worker.once('message', (result: ParsedDocument | { error: string }) => {
      if ('error' in result) finish(new Error(result.error));
      else if (typeof result.text !== 'string') finish(new Error('PARSER_FAILED'));
      else finish(undefined, result);
    });
    worker.once('error', () => finish(new Error('PARSER_FAILED')));
    worker.once('exit', (code) => {
      if (code !== 0 && !settled) finish(new Error('PARSER_FAILED'));
    });
  });
}

function documentBytes(content: Buffer | Binary | undefined): Buffer | undefined {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Binary) return Buffer.from(content.value());
  return undefined;
}

async function indexDocument(documentId: string, principal: AuthenticatedPrincipal, upload: UploadedDocument, mongo: Db, chunkStore: NonNullable<ReturnType<typeof createDocumentChunkStore>>, embedder: DocumentEmbedder): Promise<number> {
  const { extension } = validateUpload(upload);
  const segments = await extractDocumentSegments(extension, upload.bytes);
  const chunks: Array<{ text: string; page?: number; section?: string }> = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    for (const text of splitIntoChunks(segment.text)) {
      const key = text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      chunks.push({ text, ...(segment.page ? { page: segment.page } : {}), ...(segment.section ? { section: segment.section } : {}) });
      if (chunks.length > MAX_DOCUMENT_CHUNKS) throw new Error('TOO_MANY_CHUNKS');
    }
  }
  if (!chunks.length) throw new Error('EMPTY_DOCUMENT');
  const config = getEmbeddingConfig();
  if (config.dimensions !== 768) throw new Error('VECTOR_DIMENSION_MISMATCH');
  const vectors = await embedder(chunks.map(({ text }) => text));
  const tenantId = principal.tenantId ?? null;
  const indexed: IndexedChunk[] = chunks.map(({ text, page, section }, chunkIndex) => ({
    chunkId: `${documentId}:${chunkIndex}`,
    documentId,
    tenantId,
    ownerId: principal.subject,
    chunkIndex,
    content: text,
    metadata: { filename: path.basename(upload.filename), chunkIndex, ...(page ? { page } : {}), ...(section ? { section } : {}) },
    embedding: vectors[chunkIndex],
    embeddingModel: config.model || EMBEDDING_MODEL,
    embeddingVersion: config.version || EMBEDDING_VERSION,
  }));
  await chunkStore.replaceDocumentChunks(indexed);
  const now = new Date();
  const readyResult = await collection<DocumentRecord>(mongo, 'documents').updateOne({ _id: documentId, status: 'processing' }, {
    $set: { status: 'ready', chunkCount: chunks.length, updatedAt: now },
  });
  if (readyResult.modifiedCount !== 1) {
    await chunkStore.deleteDocumentChunks(documentId, tenantId);
    throw new Error('DOCUMENT_STATE_CHANGED');
  }
  await collection<IngestionJob>(mongo, 'ingestion_jobs').updateOne({ documentId, state: 'processing' }, {
    $set: { state: 'complete', updatedAt: now },
  });
  return chunks.length;
}

export function createDocumentService(
  mongoLoader: () => Promise<Db> = getMongoDatabase,
  chunkStore = createDocumentChunkStore(),
  malwareScanner = createMalwareScanner(),
  embedder: DocumentEmbedder = embedTexts
): DocumentService | undefined {
  if (!chunkStore) return undefined;
  return {
    close: () => chunkStore.close(),
    async ingest(principal, upload) {
      if (!canManageDocuments(principal)) throw new Error('NOT_AUTHORIZED');
      const { sha256 } = validateUpload(upload);
      await scanUpload(upload, malwareScanner);
      const mongo = await mongoLoader();
      const docs = collection<DocumentRecord>(mongo, 'documents');
      const jobs = collection<IngestionJob>(mongo, 'ingestion_jobs');
      const tenantId = principal.tenantId ?? null;
      const duplicate = await docs.findOne({ tenantId, ownerId: principal.subject, sha256, status: { $ne: 'deleting' } }, { projection: { _id: 1, status: 1, chunkCount: 1 } });
      if (duplicate) return { documentId: duplicate._id, status: duplicate.status, duplicate: true, chunkCount: duplicate.chunkCount };
      const documentId = randomUUID();
      const now = new Date();
      const record: DocumentRecord & { content: Buffer } = {
        _id: documentId, tenantId, ownerId: principal.subject, filename: path.basename(upload.filename),
        mediaType: upload.mediaType, sha256, status: 'processing', chunkCount: 0,
        content: upload.bytes, createdAt: now, updatedAt: now,
      };
      try {
        await docs.insertOne(record);
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const raced = await docs.findOne({ tenantId, ownerId: principal.subject, sha256, status: { $ne: 'deleting' } }, { projection: { _id: 1, status: 1, chunkCount: 1 } });
        if (raced) return { documentId: raced._id, status: raced.status, duplicate: true, chunkCount: raced.chunkCount };
        throw error;
      }
      await jobs.insertOne({ _id: documentId, documentId, tenantId, ownerId: principal.subject, state: 'processing', attempts: 1, createdAt: now, updatedAt: now });
      try {
        const chunkCount = await indexDocument(documentId, principal, upload, mongo, chunkStore!, embedder);
        await writeAuditEvent(mongo, { action: 'document.ingested', actorId: principal.subject, tenantId, resourceType: 'document', resourceId: documentId, createdAt: new Date() });
        return { documentId, status: 'ready', duplicate: false, chunkCount };
      } catch (error) {
        const failureCode = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'INGESTION_FAILED';
        const failedAt = new Date();
        logEvent('database.ingestion.sync_failed', { operation: 'ingest', failureCode, errorType: error instanceof Error ? error.name : 'unknown' }, 'error');
        await docs.updateOne({ _id: documentId, status: { $ne: 'deleting' } }, { $set: { status: 'failed', failureCode, updatedAt: failedAt } });
        await jobs.updateOne({ documentId }, { $set: { state: 'failed', lastErrorCode: failureCode, updatedAt: failedAt } });
        throw error;
      }
    },
    async getStatus(principal, documentId) {
      const mongo = await mongoLoader();
      const record = await collection<DocumentRecord>(mongo, 'documents').findOne(documentScope(principal, documentId), { projection: { filename: 1, status: 1, chunkCount: 1 } });
      return record ? { documentId, filename: record.filename, status: record.status, chunkCount: record.chunkCount } : undefined;
    },
    async delete(principal, documentId) {
      if (!canManageDocuments(principal)) return false;
      const mongo = await mongoLoader();
      const docs = collection<DocumentRecord>(mongo, 'documents');
      const scope = documentScope(principal, documentId);
      const record = await docs.findOneAndUpdate(scope, { $set: { status: 'deleting', updatedAt: new Date() } }, { returnDocument: 'after' });
      if (!record) return false;
      try {
        await chunkStore!.deleteDocumentChunks(documentId, record.tenantId);
        await docs.deleteOne(scope);
        await collection<IngestionJob>(mongo, 'ingestion_jobs').deleteMany({ documentId });
        await writeAuditEvent(mongo, { action: 'document.deleted', actorId: principal.subject, tenantId: principal.tenantId ?? null, resourceType: 'document', resourceId: documentId, createdAt: new Date() });
        return true;
      } catch (error) {
        // Keep the Mongo tombstone so retrieval fails closed and a reconciler can retry.
        logEvent('database.deletion.sync_failed', { operation: 'delete', errorType: error instanceof Error ? error.name : 'unknown' }, 'error');
        return false;
      }
    },
    async recoverPending(limit = 25) {
      const mongo = await mongoLoader();
      const jobs = collection<IngestionJob>(mongo, 'ingestion_jobs');
      let recovered = 0;
      let failed = 0;
      const pendingDocuments = await collection<DocumentRecord>(mongo, 'documents').find(
        { status: { $in: ['pending', 'processing', 'failed'] } },
        { projection: { _id: 1, tenantId: 1, ownerId: 1 } }
      ).limit(Math.max(1, Math.min(limit, 100))).toArray();
      for (const document of pendingDocuments) {
        if (await jobs.findOne({ documentId: document._id }, { projection: { _id: 1 } })) continue;
        try {
          const now = new Date();
          await jobs.insertOne({ _id: document._id, documentId: document._id, tenantId: document.tenantId, ownerId: document.ownerId, state: 'pending', attempts: 0, createdAt: now, updatedAt: now });
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
        }
      }
      const deleting = await collection<DocumentRecord>(mongo, 'documents').find({ status: 'deleting' }, { projection: { _id: 1, tenantId: 1 } }).limit(100).toArray();
      for (const { _id, tenantId } of deleting) {
        await chunkStore!.deleteDocumentChunks(_id, tenantId);
        await collection<DocumentRecord>(mongo, 'documents').deleteOne({ _id, status: 'deleting' });
        await jobs.deleteMany({ documentId: _id });
        recovered += 1;
      }
      const indexedIds = await chunkStore!.listDocumentIds(1000);
      if (indexedIds.length) {
        const known = await collection<DocumentRecord>(mongo, 'documents').find(
          { _id: { $in: indexedIds }, status: { $in: ['ready', 'processing', 'pending'] } },
          { projection: { _id: 1 } }
        ).toArray();
        const knownIds = new Set(known.map(({ _id }) => _id));
        for (const indexedId of indexedIds) {
          if (!knownIds.has(indexedId)) {
            await chunkStore!.deleteDocumentChunks(indexedId, null, true);
            recovered += 1;
          }
        }
      }
      const readyDocuments = await collection<DocumentRecord>(mongo, 'documents').find(
        { status: 'ready' },
        { projection: { _id: 1, tenantId: 1, ownerId: 1 } }
      ).limit(Math.max(1, Math.min(limit, 100))).toArray();
      for (const document of readyDocuments) {
        if (await chunkStore!.hasDocumentChunks(document._id)) continue;
        const now = new Date();
        await collection<DocumentRecord>(mongo, 'documents').updateOne({ _id: document._id, status: 'ready' }, {
          $set: { status: 'failed', failureCode: 'VECTOR_CHUNKS_MISSING', updatedAt: now },
        });
        const existingJob = await jobs.findOne({ documentId: document._id }, { projection: { _id: 1 } });
        if (existingJob) {
          await jobs.updateOne({ _id: existingJob._id }, { $set: { state: 'failed', lastErrorCode: 'VECTOR_CHUNKS_MISSING', updatedAt: now } });
        } else {
          try {
            await jobs.insertOne({ _id: document._id, documentId: document._id, tenantId: document.tenantId, ownerId: document.ownerId, state: 'failed', attempts: 0, lastErrorCode: 'VECTOR_CHUNKS_MISSING', createdAt: now, updatedAt: now });
          } catch (error) {
            if (!isDuplicateKey(error)) throw error;
          }
        }
      }
      for (let index = 0; index < Math.max(1, Math.min(limit, 100)); index += 1) {
        const now = new Date();
        const job = await jobs.findOneAndUpdate({
          attempts: { $lt: 5 },
          $or: [
            { state: { $in: ['pending', 'failed'] } },
            { state: 'processing', updatedAt: { $lt: new Date(now.getTime() - 5 * 60_000) } },
          ],
        }, { $set: { state: 'processing', updatedAt: now }, $inc: { attempts: 1 } }, { returnDocument: 'after', sort: { updatedAt: 1 } });
        if (!job) break;
        const docs = collection<DocumentRecord>(mongo, 'documents');
        const document = await docs.findOne({ _id: job.documentId });
        if (document?.status === 'deleting') {
          await chunkStore!.deleteDocumentChunks(job.documentId, job.tenantId);
          await docs.deleteOne({ _id: job.documentId, status: 'deleting' });
          await jobs.deleteOne({ _id: job._id });
          recovered += 1;
          continue;
        }
        const bytes = documentBytes(document?.content);
        if (!document || !bytes) {
          await jobs.updateOne({ _id: job._id }, { $set: { state: 'failed', lastErrorCode: 'DOCUMENT_CONTENT_MISSING', updatedAt: now } });
          failed += 1;
          continue;
        }
        try {
          const processingResult = await docs.updateOne({ _id: job.documentId, status: { $ne: 'deleting' } }, { $set: { status: 'processing', updatedAt: now } });
          if (processingResult.modifiedCount !== 1) {
            await jobs.updateOne({ _id: job._id }, { $set: { state: 'failed', lastErrorCode: 'DOCUMENT_STATE_CHANGED', updatedAt: now } });
            failed += 1;
            continue;
          }
          await indexDocument(job.documentId, { subject: job.ownerId, roles: [], ...(job.tenantId ? { tenantId: job.tenantId } : {}) }, {
            filename: document.filename, mediaType: document.mediaType, bytes,
          }, mongo, chunkStore!, embedder);
          recovered += 1;
        } catch (error) {
          const failureCode = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'INGESTION_FAILED';
          logEvent('database.ingestion.sync_failed', { operation: 'reconcile', failureCode, errorType: error instanceof Error ? error.name : 'unknown' }, 'error');
          await docs.updateOne({ _id: job.documentId, status: { $ne: 'deleting' } }, { $set: { status: 'failed', failureCode, updatedAt: now } });
          await jobs.updateOne({ _id: job._id }, { $set: { state: 'failed', lastErrorCode: failureCode, updatedAt: now } });
          failed += 1;
        }
      }
      return { recovered, failed };
    },
  };
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 11000;
}
