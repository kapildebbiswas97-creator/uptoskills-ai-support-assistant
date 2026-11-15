CREATE SCHEMA IF NOT EXISTS knowledge;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge.document_chunks (
  chunk_id text PRIMARY KEY,
  document_id text NOT NULL,
  tenant_id text,
  owner_id text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  content text NOT NULL CHECK (length(content) > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(768) NOT NULL,
  embedding_model text NOT NULL,
  embedding_version integer NOT NULL DEFAULT 1 CHECK (embedding_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw
  ON knowledge.document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS document_chunks_tenant_document
  ON knowledge.document_chunks (tenant_id, document_id);
CREATE INDEX IF NOT EXISTS document_chunks_metadata_gin
  ON knowledge.document_chunks USING gin (metadata);
CREATE INDEX IF NOT EXISTS document_chunks_content_fts
  ON knowledge.document_chunks USING gin (to_tsvector('simple', content));

REVOKE ALL ON TABLE knowledge.document_chunks FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_assistant_reader') THEN
    GRANT SELECT ON TABLE knowledge.document_chunks TO uts_assistant_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_assistant_writer') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE knowledge.document_chunks TO uts_assistant_writer;
  END IF;
END $$;
