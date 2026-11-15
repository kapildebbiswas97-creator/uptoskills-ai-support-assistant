# Production Architecture

Status: implementation in progress; production deployment and external services have not been verified.

## Request path

The Vercel catch-all and local Express server share `server/app.ts`. The API validates bearer JWTs against a configured issuer, audience, and JWKS endpoint. Public chat continues to support curated YAML and local document retrieval. PostgreSQL retrieval is enabled only for an authenticated principal and is filtered through MongoDB document ownership, permission, tenant, and lifecycle records.

## Data ownership

- MongoDB Atlas is the operational metadata store for documents, ingestion jobs, permissions, and audit records.
- PostgreSQL/pgvector stores document chunks and embeddings. The document table uses 768-dimensional vectors.
- A document remains unavailable to retrieval until its MongoDB record is marked `ready` after vector indexing succeeds.
- Failed and stale ingestion jobs can be retried by `npm run db:documents:reconcile`.

## Limits

Authentication depends on an external OIDC issuer; this repository does not implement local passwords or a login UI. Authenticated chat turns are persisted to MongoDB, with owner-scoped conversation list/history endpoints; unauthenticated demo history stays browser-side. Retrieval combines cosine and full-text results using reciprocal-rank fusion. Reranking and citation validation are not implemented. No production credentials, database connection, Vercel configuration, or deployment were verified.
