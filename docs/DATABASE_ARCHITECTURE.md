# Database Architecture

Status: code paths and additive schemas implemented; live MongoDB Atlas and PostgreSQL connectivity remain unverified.

## MongoDB Atlas

`server/mongodb.ts` reuses a bounded MongoDB driver connection pool and defines validators and indexes for users, organizations, memberships, conversations, messages, documents, permissions, ingestion jobs, audit logs, and system settings. Run `npm run db:mongo:init` deliberately in the target environment to create missing collections and indexes. This command is not run automatically at application startup.

Documents have stable UUID identifiers. MongoDB owns document metadata, ownership, tenant, lifecycle status, content bytes (capped at 3 MiB by the API to fit base64 JSON within Vercel's 4.5 MB function payload limit), and ingestion state. Authenticated chat turns are stored with owner and tenant IDs in conversations and messages; requests without a verified principal are not persisted.

## PostgreSQL and pgvector

`infra/postgres/migrations/002-document-chunks.sql` adds `knowledge.document_chunks`, vector and metadata indexes, and role grants when expected roles already exist. Migration `003-document-chunk-rls.sql` is the historical caller-settable-GUC policy. Additive migration `004-signed-tenant-rls.sql` replaces it with a signed, transaction-local context verified by a fixed-search-path `SECURITY DEFINER` function; keys remain in a private database table and are not readable by runtime roles. The readiness function requires `session_user` to match the expected reader/writer login and fails closed for a migration/admin URL. The server process and its signing key remain in the trust boundary, and superuser/BYPASSRLS/migration roles can bypass or alter RLS. The migration has not been run against a real database, so live isolation is unverified and any database still on 003 retains the old risk. Embeddings are fixed at 768 dimensions. `DATABASE_URL` is the retrieval account; `DATABASE_INGEST_URL` is a separate writer account; `DATABASE_MIGRATION_URL` is reserved for deliberate schema changes. Do not run migrations against production as part of this verification.

The initial local Compose script provisions reader and writer roles for a fresh local volume. Editing that script does not update an already initialized PostgreSQL volume or a production database.

## Cross-database lifecycle

The API writes MongoDB document and job metadata before extraction and vector insertion. It marks the MongoDB document `ready` only after the PostgreSQL transaction commits. Retrieval obtains allowed document IDs from MongoDB, filters the vector query by those IDs and tenant, then rechecks authorization before returning excerpts. Deletion marks the record `deleting` before removing vector chunks. Reconciliation retries bounded pending, failed, and stale jobs.

There is no distributed transaction. Run reconciliation after partial failures and monitor stale jobs. Live consistency and failure recovery have not been integration-tested.
