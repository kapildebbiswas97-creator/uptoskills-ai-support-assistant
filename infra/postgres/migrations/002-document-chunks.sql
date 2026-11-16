-- The reader/writer roles must exist before this migration so it cannot be
-- recorded as applied while silently omitting their grants.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_assistant_reader')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'uts_assistant_writer') THEN
    RAISE EXCEPTION 'Create distinct LOGIN roles uts_assistant_reader and uts_assistant_writer with NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS before migration 002';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('uts_assistant_reader', 'uts_assistant_writer')
      AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Application roles must be distinct LOGIN roles with NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS';
  END IF;
END
$roles$;

CREATE SCHEMA IF NOT EXISTS knowledge;

-- pgvector is enabled separately through the database's extension manager.
-- Resolve its actual extension schema before using vector and vector_cosine_ops.
DO $vector$
DECLARE
  vector_schema text;
BEGIN
  SELECT namespace.nspname INTO vector_schema
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'vector';

  IF vector_schema IS NULL THEN
    RAISE EXCEPTION 'pgvector is not enabled; enable the vector extension in the database before applying migration 002';
  END IF;
  IF NOT has_schema_privilege(current_user, vector_schema, 'USAGE') THEN
    RAISE EXCEPTION 'Migration role % lacks USAGE on the pgvector extension schema %', current_user, vector_schema;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type AS type
    WHERE type.typname = 'vector' AND type.typnamespace = to_regnamespace(vector_schema)
  ) THEN
    RAISE EXCEPTION 'The vector extension schema % does not contain type vector; inspect the pgvector installation before retrying', vector_schema;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_opclass AS opclass
    WHERE opclass.opcname = 'vector_cosine_ops' AND opclass.opcnamespace = to_regnamespace(vector_schema)
  ) THEN
    RAISE EXCEPTION 'The vector extension schema % does not contain vector_cosine_ops; inspect the pgvector installation before retrying', vector_schema;
  END IF;

  PERFORM pg_catalog.set_config(
    'search_path',
    pg_catalog.format('pg_catalog, %I, public, knowledge', vector_schema),
    true
  );
END
$vector$;

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
GRANT USAGE ON SCHEMA knowledge TO uts_assistant_reader, uts_assistant_writer;
DO $grants$
DECLARE
  vector_schema text;
BEGIN
  SELECT namespace.nspname INTO vector_schema
  FROM pg_catalog.pg_extension AS extension
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'vector';
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO uts_assistant_reader, uts_assistant_writer', vector_schema);
  GRANT SELECT ON TABLE knowledge.document_chunks TO uts_assistant_reader;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE knowledge.document_chunks TO uts_assistant_writer;
END $grants$;
