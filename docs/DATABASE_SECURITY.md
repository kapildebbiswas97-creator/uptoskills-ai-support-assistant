# Database Security

## Implemented

- Database credentials are server-side environment variables; no database URL is used by the frontend.
- MongoDB uses bounded pools, timeouts, retryable driver operations, schema validators, and indexes.
- PostgreSQL access uses parameterized queries, bounded pool settings, query timeouts, a read-only retrieval URL, and a separate ingestion URL.
- Migration `003-document-chunk-rls.sql` is the historical policy and trusts caller-settable GUCs. It is not an adequate tenant boundary on its own.
- Additive migration `004-signed-tenant-rls.sql` replaces that policy with a signed, transaction-local HMAC context. It binds tenant ID, global-access flag, key ID, issue time, and nonce; PostgreSQL checks the signature through a `SECURITY DEFINER` function with a fixed search path. Runtime readiness also requires the PostgreSQL login to match the expected reader or writer role, so an admin/migration URL fails closed. Runtime roles cannot read the private key table and fail closed if the secure function or key is unavailable.
- Vector retrieval requires a verified bearer JWT and checks ownership, tenant, document permissions, and `ready` state against MongoDB before returning excerpts.
- Document upload enforces extension/MIME pairs, a 3 MiB cap, safe filenames, PDF/DOCX signatures and DOCX archive bounds. The smaller raw-file cap keeps base64 JSON uploads below Vercel's documented 4.5 MB function payload limit. It blocks ingestion unless the configured malware scanner returns a clean verdict. PDF/DOCX parsers run in resource-limited worker threads.
- Deletion hides the MongoDB record from retrieval before propagating to PostgreSQL.

## Signed RLS context and limits

Set `RLS_CONTEXT_KEY_ID` and a canonical base64url encoding of 32 random bytes in the application secret manager. An operator provisions the same key ID and secret into `app_private.rls_context_keys`; use a new key ID for rotation, deploy the application with the new key, wait at least five minutes for old contexts to expire, then disable the old key. Never put a key in migrations, source control, logs, or the runtime database role. `npm run db:postgres:provision-local-rls-key` is deliberately limited to loopback `_integration` databases; it is not a staging/production provisioning command.

The application process remains a trusted signer: a compromised application host or leaked signing key can mint any tenant context, including signed global access. PostgreSQL superusers and `BYPASSRLS` roles bypass RLS, and table/schema migration owners can change policies; keep these out of runtime credentials. Application reader/writer roles must not own the chunk table, have `BYPASSRLS`/`CREATEROLE`, or be members of privileged, context-owner, key-admin, or table-owner roles. Migration `004` checks this configuration and `rls_context_ready` repeats relevant checks before the app sets context.

**Deployment state:** migration `004` and the application changes are present in this checkout but were not applied to a real PostgreSQL database. Until a disposable integration database verifies it and the target staging database has the reviewed migration applied, the historical `003` caller-settable-GUC vulnerability remains active in that database. No live RLS guarantee is claimed.

## Configuration and limits

JWT validation supports RS256/ES256 with issuer, audience, required claims, expiration, not-before when present, and maximum age checks. Roles map from provider claim values through `AUTH_ROLE_MAPPING`; tenant claims come only from the configured trusted issuer. Configure role issuance and revocation in that identity provider. The application has no password login, refresh token, or session cookie implementation.

The 768-dimension vector schema is fixed; changing embedding dimensions requires a reviewed migration and reindex. Database TLS is controlled by the supplied connection URI and hosted provider settings. No real credentials or infrastructure have been checked in this task; RLS behavior, scanner verdicts, and parser isolation need staging validation. This is not a penetration test.
