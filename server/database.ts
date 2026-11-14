import { Pool } from 'pg';
import { embedText } from './embeddings';

export type KnowledgeSearch = (query: string, signal: AbortSignal) => Promise<string[]>;

export function vectorLiteral(values: number[]): string {
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding must contain finite numeric values');
  }
  return `[${values.join(',')}]`;
}

export function createKnowledgeSearch(databaseUrl?: string, apiKey?: string): {
  search: KnowledgeSearch;
  close: () => Promise<void>;
} | undefined {
  if (!databaseUrl || !apiKey) return undefined;

  const pool = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 1200 });
  pool.on('error', () => undefined);

  return {
    async search(query, signal) {
      const embedding = await embedText(query, apiKey);
      if (signal.aborted) return [];
      const result = await pool.query<{ content: string }>(
        `SELECT content
         FROM knowledge.documents
         ORDER BY embedding <=> $1::vector
         LIMIT 4`,
        [vectorLiteral(embedding)]
      );
      return result.rows.map((row) => row.content);
    },
    close: () => pool.end(),
  };
}
