import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import type { AuthenticatedPrincipal } from './auth.js';
import { collection, getMongoDatabase } from './mongodb.js';
import { embedText, getEmbeddingConfig } from './embeddings.js';
import { rerankAndDeduplicateChunks } from './rag.js';
import { createSignedRlsContext } from './rls-context.js';

export type KnowledgeSearch = (query: string, signal: AbortSignal, principal?: AuthenticatedPrincipal) => Promise<string[]>;

const POSTGRES_VECTOR_SEARCH_PATH = 'pg_catalog, extensions, public, knowledge';

export interface IndexedChunk {
  chunkId: string;
  documentId: string;
  tenantId: string | null;
  ownerId: string;
  chunkIndex: number;
  content: string;
  metadata: Record<string, string | number | boolean | null>;
  embedding: number[];
  embeddingModel: string;
  embeddingVersion: number;
}

export function vectorLiteral(values: number[]): string {
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding must contain finite numeric values');
  }
  return `[${values.join(',')}]`;
}

function createPool(connectionString: string, max = 4): Pool {
  const pool = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
    query_timeout: 8000,
    statement_timeout: 8000,
    keepAlive: true,
    application_name: 'uptoskills-ai-support-assistant',
  });
  pool.on('error', () => undefined);
  return pool;
}

async function prepareVectorClient(client: Pick<PoolClient, 'query'>): Promise<void> {
  // Supabase installs pgvector in extensions; local PostgreSQL commonly uses public.
  // pg_catalog first and extensions before public keep vector resolution explicit.
  await client.query(`SET search_path TO ${POSTGRES_VECTOR_SEARCH_PATH}`);
}

export async function setSignedRlsContext(
  client: Pick<PoolClient, 'query'>,
  tenantId: string | null,
  allowAllTenants: boolean,
  databaseRole: 'uts_assistant_reader' | 'uts_assistant_writer'
): Promise<void> {
  const context = createSignedRlsContext(tenantId, allowAllTenants);
  let ready = false;
  try {
    const result = await client.query<{ ready: boolean }>(
      'SELECT app_private.rls_context_ready($1, $2) AS ready',
      [context.keyId, databaseRole]
    );
    ready = result.rows[0]?.ready === true;
  } catch {
    throw new Error('SECURE_RLS_MIGRATION_REQUIRED');
  }
  if (!ready) throw new Error('SECURE_RLS_RUNTIME_ROLE_OR_CONTEXT_NOT_READY');
  await client.query(
    `SELECT set_config('app.tenant_id', $1, true),
            set_config('app.allow_all_tenants', $2, true),
            set_config('app.rls_key_id', $3, true),
            set_config('app.rls_issued_at', $4, true),
            set_config('app.rls_nonce', $5, true),
            set_config('app.rls_signature', $6, true)`,
    [context.tenantId ?? '', String(context.allowAllTenants), context.keyId,
      String(context.issuedAt), context.nonce, context.signature]
  );
}

export function createKnowledgeSearch(
  databaseUrl = process.env.DATABASE_URL,
  apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  mongoLoader: typeof getMongoDatabase = getMongoDatabase
): { search: KnowledgeSearch; close: () => Promise<void> } | undefined {
  if (!databaseUrl || !apiKey) return undefined;
  const pool = createPool(databaseUrl);
  const authorizedDocumentIds = async (principal: AuthenticatedPrincipal): Promise<string[]> => {
    const mongo = await mongoLoader();
    const tenantId = principal.tenantId ?? null;
    const isSuperAdmin = principal.roles.includes('super_admin');
    const isTenantAdmin = principal.roles.some((role) => role === 'admin' || role === 'knowledge_manager');
    const permissions = isSuperAdmin || isTenantAdmin ? [] : await collection<{ documentId: string }>(mongo, 'document_permissions').find({
      subject: principal.subject,
      tenantId,
    }, { projection: { documentId: 1 } }).limit(500).toArray();
    const documentFilter = isSuperAdmin
      ? { status: 'ready' }
      : isTenantAdmin
        ? { tenantId, status: 'ready' }
        : { tenantId, status: 'ready', $or: [
        { ownerId: principal.subject },
        { _id: { $in: permissions.map(({ documentId }) => documentId) } },
        ] };
    const readyDocuments = await collection<{ _id: string }>(mongo, 'documents').find(
      documentFilter,
      { projection: { _id: 1 } }
    ).limit(500).toArray();
    return readyDocuments.map(({ _id }) => _id);
  };
  return {
    async search(query, signal, principal) {
      // Vector results require server-verified identity and MongoDB authorization.
      if (!principal || signal.aborted) return [];
      const tenantId = principal.tenantId ?? null;
      const config = getEmbeddingConfig();
      const globalTenantAccess = principal.roles.includes('super_admin');
      const documentIds = await authorizedDocumentIds(principal);
      if (!documentIds.length || signal.aborted) return [];
      const embedding = await embedText(query, apiKey, signal, 'RETRIEVAL_QUERY');
      if (signal.aborted) return [];
      const client = await pool.connect();
      let result;
      try {
        await prepareVectorClient(client);
        await client.query('BEGIN');
        await setSignedRlsContext(client, tenantId, globalTenantAccess, 'uts_assistant_reader');
        result = await client.query<{ content: string; metadata: Record<string, unknown>; document_id: string; chunk_index: number; fusion_score: number }>(
        `WITH vector_candidates AS (
           SELECT document_id, chunk_index, content, metadata,
                  row_number() OVER (ORDER BY embedding <=> $1::vector) AS rank_position
           FROM knowledge.document_chunks
           WHERE ($7::boolean OR tenant_id IS NOT DISTINCT FROM $2::text) AND document_id = ANY($3::text[])
             AND embedding_model = $4 AND embedding_version = $5
           ORDER BY embedding <=> $1::vector
           LIMIT 12
         ), lexical_candidates AS (
           SELECT document_id, chunk_index, content, metadata,
                  row_number() OVER (ORDER BY ts_rank(to_tsvector('simple', content), websearch_to_tsquery('simple', $6)) DESC) AS rank_position
           FROM knowledge.document_chunks
           WHERE ($7::boolean OR tenant_id IS NOT DISTINCT FROM $2::text) AND document_id = ANY($3::text[])
             AND embedding_model = $4 AND embedding_version = $5
             AND to_tsvector('simple', content) @@ websearch_to_tsquery('simple', $6)
           ORDER BY ts_rank(to_tsvector('simple', content), websearch_to_tsquery('simple', $6)) DESC
           LIMIT 12
         ), fused AS (
           SELECT document_id, chunk_index, content, metadata, SUM(1.0 / (60 + rank_position)) AS fusion_score
           FROM (
             SELECT * FROM vector_candidates
             UNION ALL
             SELECT * FROM lexical_candidates
           ) candidates
           GROUP BY document_id, chunk_index, content, metadata
         )
         SELECT document_id, chunk_index, content, metadata, fusion_score
         FROM fused
         ORDER BY fusion_score DESC
         LIMIT 6`,
          [vectorLiteral(embedding), tenantId, documentIds, config.model, config.version, query, globalTenantAccess]
        );
        await client.query('COMMIT');
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
      // Recheck the authoritative database after retrieval so a concurrent revocation or
      // document lifecycle change does not expose a stale PostgreSQL chunk.
      if (signal.aborted) return [];
      const stillAuthorized = new Set(await authorizedDocumentIds(principal));
      return rerankAndDeduplicateChunks(query, result.rows
        .filter((row) => stillAuthorized.has(row.document_id))
        .map((row) => ({ documentId: row.document_id, chunkIndex: row.chunk_index, content: row.content, metadata: row.metadata, fusionScore: Number(row.fusion_score) })), 4)
        .map((row) => {
          const title = typeof row.metadata.filename === 'string' ? row.metadata.filename : 'Authorized document';
          const page = typeof row.metadata.page === 'number' ? `, page ${row.metadata.page}` : '';
          const section = typeof row.metadata.section === 'string' ? `, section ${row.metadata.section}` : '';
          return `[Source: ${title}${page}${section}; document ${row.documentId}; chunk ${row.chunkIndex}]\n${row.content}`;
        });
    },
    close: () => pool.end(),
  };
}

export function createDocumentChunkStore(databaseUrl = process.env.DATABASE_INGEST_URL): {
  replaceDocumentChunks(chunks: IndexedChunk[]): Promise<void>;
  deleteDocumentChunks(documentId: string, tenantId?: string | null, allowAllTenants?: boolean): Promise<void>;
  hasDocumentChunks(documentId: string): Promise<boolean>;
  listDocumentIds(limit?: number): Promise<string[]>;
  close(): Promise<void>;
} | undefined {
  if (!databaseUrl) return undefined;
  const pool = createPool(databaseUrl, 2);
  return {
    async replaceDocumentChunks(chunks) {
      if (!chunks.length) throw new Error('A document must have at least one indexed chunk');
      const { documentId, tenantId, ownerId } = chunks[0];
      if (chunks.some((chunk) => chunk.documentId !== documentId || chunk.tenantId !== tenantId || chunk.ownerId !== ownerId)) {
        throw new Error('Chunk batch must belong to one document and tenant');
      }
      const config = getEmbeddingConfig();
      if (config.dimensions !== 768 || chunks.some((chunk) => chunk.embedding.length !== config.dimensions || chunk.embedding.some((value) => !Number.isFinite(value)))) {
        throw new Error(`Every embedding must contain exactly ${config.dimensions} finite values; this schema requires 768`);
      }
      if (chunks.some((chunk) => chunk.embeddingModel !== config.model || chunk.embeddingVersion !== config.version)) {
        throw new Error('Chunk embedding model/version does not match the configured embedding schema');
      }
      const client = await pool.connect();
      try {
        await prepareVectorClient(client);
        await client.query('BEGIN');
        await setSignedRlsContext(client, tenantId, false, 'uts_assistant_writer');
        await client.query('DELETE FROM knowledge.document_chunks WHERE document_id = $1', [documentId]);
        for (const chunk of chunks) {
          await client.query(
            `INSERT INTO knowledge.document_chunks
              (chunk_id, document_id, tenant_id, owner_id, chunk_index, content, metadata, embedding, embedding_model, embedding_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::vector, $9, $10)
             ON CONFLICT (chunk_id) DO UPDATE SET content = EXCLUDED.content, metadata = EXCLUDED.metadata,
               embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model,
               embedding_version = EXCLUDED.embedding_version`,
            [chunk.chunkId, chunk.documentId, chunk.tenantId, chunk.ownerId, chunk.chunkIndex, chunk.content,
              JSON.stringify(chunk.metadata), vectorLiteral(chunk.embedding), chunk.embeddingModel, chunk.embeddingVersion]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async deleteDocumentChunks(documentId, tenantId = null, allowAllTenants = false) {
      const client = await pool.connect();
      try {
        await prepareVectorClient(client);
        await client.query('BEGIN');
        await setSignedRlsContext(client, tenantId, allowAllTenants, 'uts_assistant_writer');
        await client.query('DELETE FROM knowledge.document_chunks WHERE document_id = $1', [documentId]);
        await client.query('COMMIT');
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async hasDocumentChunks(documentId) {
      const client = await pool.connect();
      try {
        await prepareVectorClient(client);
        await client.query('BEGIN');
        await setSignedRlsContext(client, null, true, 'uts_assistant_writer');
        const result = await client.query<{ has_chunks: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM knowledge.document_chunks WHERE document_id = $1) AS has_chunks',
          [documentId]
        );
        await client.query('COMMIT');
        return result.rows[0]?.has_chunks === true;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async listDocumentIds(limit = 1000) {
      const client = await pool.connect();
      try {
        await prepareVectorClient(client);
        await client.query('BEGIN');
        await setSignedRlsContext(client, null, true, 'uts_assistant_writer');
        const result = await client.query<{ document_id: string }>(
          'SELECT DISTINCT document_id FROM knowledge.document_chunks ORDER BY document_id LIMIT $1',
          [Math.max(1, Math.min(1000, limit))]
        );
        await client.query('COMMIT');
        return result.rows.map(({ document_id }) => document_id);
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* Preserve the original database error. */ }
}

export async function runPostgresMigrations(
  databaseUrl = process.env.DATABASE_MIGRATION_URL,
  migrationsDirectory = path.resolve(process.cwd(), 'infra/postgres/migrations')
): Promise<string[]> {
  if (!databaseUrl) throw new Error('DATABASE_MIGRATION_URL is required for migrations');
  const pool = createPool(databaseUrl, 1);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(84120411)');
    await client.query('CREATE TABLE IF NOT EXISTS public.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir(migrationsDirectory))
      .filter((file) => /^\d+[-_].+\.sql$/.test(file) && shouldApplyPostgresMigration(file))
      .sort();
    for (const filename of files) {
      const seen = await client.query('SELECT 1 FROM public.schema_migrations WHERE version = $1', [filename]);
      if (seen.rowCount) continue;
      const sql = await readFile(path.join(migrationsDirectory, filename), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations(version) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        applied.push(filename);
      } catch (error) {
        await rollback(client);
        throw error;
      }
    }
    return applied;
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(84120411)'); } catch { /* Session close releases the lock. */ }
    client.release();
    await pool.end();
  }
}

export function shouldApplyPostgresMigration(filename: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  if (filename === '005-supabase-auth-roles-and-hook.sql') return Boolean(environment.SUPABASE_URL?.trim());
  return true;
}
