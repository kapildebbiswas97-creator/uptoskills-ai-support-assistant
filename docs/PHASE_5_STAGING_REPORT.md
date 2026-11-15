# Phase 5 — Isolated Staging Integration and End-to-End Verification

Date: 2026-11-15 (Asia/Kolkata)  
Verdict: **STAGING BLOCKED**

## 1. Starting point and final checkout

- Starting Git commit: `dd1a66a287875e2d82e058505467104789699f57`.
- Final Git commit: `dd1a66a287875e2d82e058505467104789699f57` (the existing Phase 4 and Phase 5 changes remain uncommitted; no commit was created).
- Work continued in the existing `work/source-archive` checkout. Existing Phase 4 work was preserved.
- No deployment, production migration, production database connection, secret change, or paid resource creation occurred.

## 2. Changed files

The complete working-tree manifest relative to the starting commit is recorded at the end of this report. It includes the inherited Phase 4 implementation and documentation as well as Phase 5 auth policy, upload-limit, and reporting changes.

## 3. Commands and actual results

| Command | Result | Evidence / scope |
|---|---|---|
| `npm test` | **PASS — local** | 100 passed, 0 failed, 0 skipped. Existing loopback HTTP/SSE tests ran after temporary network permission was granted for local sockets only. No external service was contacted. |
| `npm run lint` | **PASS — local** | `tsc --noEmit` completed with no diagnostics. |
| `npm run build` | **PASS — local** | Vite 8.3.8 generated `dist/`. This does not compile or execute the Vercel serverless entrypoint. |
| `git diff --check` | **PASS — local** | No whitespace errors; Git emitted Windows LF-to-CRLF notices. |
| `npm run env:validate:staging` | **BLOCKED — prerequisites absent** | Exited 1 and listed missing `MONGODB_URI`, `MONGODB_DATABASE`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `DATABASE_URL`, `DATABASE_INGEST_URL`, `AUTH_ROLE_MAPPING`, `MALWARE_SCANNER_URL`, `MALWARE_SCANNER_TOKEN`, a Gemini embedding key, and a supported AI provider key. It performs no service connection. |

## 4. Real isolated services and staging configuration

**No real services were connected.** A metadata-only parse of the existing `.env` emitted only presence and sanitized endpoint metadata. It found no `APP_ENV`/`NODE_ENV`/`VERCEL_ENV` staging designation, no configured MongoDB/PostgreSQL/Redis/scanner/OIDC endpoint, and no configured credential variable. Secret values were not printed. There was therefore no endpoint whose host, database name, and staging designation could be verified before connecting.

MongoDB Atlas, PostgreSQL/pgvector, Redis, OIDC issuer/JWKS, malware scanner, AI provider, and Vercel are **BLOCKED** pending isolated staging credentials and infrastructure. The local Compose services were not started because they are development services, not explicitly designated staging. Mocks and fault-injection adapters are local evidence only, not evidence that integrations work against real services.

## 5. Dual-database architecture and migration status

Source inspection confirms MongoDB owns document metadata, permissions, lifecycle/jobs, conversations, and operational records; PostgreSQL stores document chunks and embeddings for hybrid retrieval. Stable IDs, retries, idempotency, deletion propagation, and reconciliation are implemented and covered by fake-adapter failure-injection tests. This remains **PARTIAL** until real service connectivity, role grants, concurrent operations, and recovery are exercised against isolated staging databases.

PostgreSQL migrations `002-document-chunks.sql` and `003-document-chunk-rls.sql` were read and reviewed but **not run**. There was no staging hostname/database identity or migration credential. MongoDB initialization was not run.

### RLS source review and manual staging procedure

**Historical Phase 5 finding, superseded by the code remediation in Phase 5A:** the previous manual procedure below only discussed migration 003 and explicitly recorded its caller-settable GUC limitation. Do not use that procedure as final RLS acceptance. Phase 5A adds migration 004 and documents the current secure rollout/test procedure in `PHASE_5A_SECURITY_AND_INTEGRATION_REPORT.md`; migration 004 is still unapplied, so this database-level risk remains open until verified.

Migration `003-document-chunk-rls.sql` enables and forces RLS on `knowledge.document_chunks`. Its `USING` predicate permits the application-provided `app.tenant_id` to match a row, with an `app.allow_all_tenants=true` exception; its `WITH CHECK` predicate always requires a matching tenant context for writes. An absent tenant setting returns no rows. An explicitly empty setting maps to SQL `NULL` and can see only rows whose `tenant_id` is `NULL`; an invalid non-empty tenant sees no rows unless it exactly matches a row tenant. The reader/writer roles created by the local SQL setup are `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, and `NOINHERIT`; real role flags have not been checked.

The custom PostgreSQL settings are caller-settable by the same session role. A compromised application DB credential or arbitrary SQL execution could set `app.allow_all_tenants=true`; these policies are defense in depth, not an independent identity boundary. This remains an open risk for production approval.

Only after the staging secret manager and owner identify the endpoint as disposable staging, perform this sequence with a least-privilege staging migration role:

1. Verify the host, database name, and staging designation from the staging inventory **before connecting**. Stop if any identifier could refer to production.
2. Connect read-only first and inspect identity and roles:

   ```sql
   SELECT current_database() AS database_name, current_user AS role_name, inet_server_addr() AS server_address;
   SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
   FROM pg_roles
   WHERE rolname IN ('uts_assistant_reader', 'uts_assistant_writer');
   ```

   Confirm the database name/host against the staging inventory and require `rolsuper=false`, `rolbypassrls=false` for both application roles.
3. Review the migration file in the same checkout, then apply only to the confirmed disposable staging database: `psql -v ON_ERROR_STOP=1 -f infra/postgres/migrations/003-document-chunk-rls.sql`.
4. Verify `relrowsecurity` and `relforcerowsecurity` in `pg_class`, and inspect `pg_policies` for `document_chunks_tenant_isolation`.
5. With synthetic staging documents for two tenants and one null-tenant record, use the real reader/writer logins to verify tenant A sees only A, tenant B sees only B, absent context sees no rows, empty context sees only null-tenant rows, invalid context sees no rows, authorized writes remain inside the selected tenant, and cross-tenant reads/deletes/writes are denied. Run these checks in a transaction and roll fixtures back. Also test all-tenant behavior separately and record the accepted GUC limitation.

No SQL above was executed in this task.

## 6. OIDC

Local generated-key tests pass for RS256/ES256 allowlisting, signature, issuer, audience, `exp`, `nbf`, required subject/issued-at, role mapping, and missing/invalid tokens. The staging app now requires an authenticated principal on `/api/models`, `/api/chat`, and `/api/chat/stream` when `APP_ENV=staging`, `NODE_ENV=staging`, or `VERCEL_ENV=preview`; the new route test verifies anonymous requests stop before retrieval and provider invocation. **Real OIDC is BLOCKED**: no issuer, JWKS URL, audience, staging client, or identity-provider role/tenant claim configuration was available. Key rotation, real tenant denial, revocation, and organization membership were not tested against an issuer.

## 7. Malware scanning and document ingestion

Scanner adapter mocks cover clean, infected, missing/unavailable, and malformed verdict behavior; ingestion fails closed when a clean scanner result is unavailable. Parser and archive tests exercise file-signature, DOCX expansion/path, and worker bounds. No scanner is configured; no EICAR fixture was sent; no real malicious file was used. Scanner health, timeout, quarantine, retry, and data handling are **BLOCKED** pending a staging scanner. The upload raw-file cap is now 3 MiB with a 4.2 MiB JSON parser cap to keep base64 requests within Vercel's documented payload ceiling.

## 8. Redis and rate limiting

Local memory fallback and unit behavior pass. `REDIS_URL` is not configured. Shared limits, expiry in a real server, reconnect/failover, and multi-instance behavior are **BLOCKED**. A per-process fallback is explicitly not distributed rate limiting and logs a warning.

## 9. AI provider integration

Provider adapters and model catalogs have mock-based tests. No provider key was configured and no provider request was made. Real authentication, model discovery, generation/streaming, timeout/cancellation, usage reporting, costs, retention, and training settings are **BLOCKED**. Do not send personal data until provider terms and retention settings are reviewed.

## 10. Full end-to-end journey

The full staging journey is **BLOCKED**. No real user authentication, organization resolution, upload scanning, Mongo persistence, PostgreSQL indexing, authorization, provider RAG, conversation persistence, deletion, audit event, or recovery-after-failure was executed end to end. Local HTTP tests verify `/api/models`, `/api/chat`, `/api/chat/stream`, `/api/health`, SSE headers, output validation, timeout, and client disconnect behavior using stubs/local knowledge only. Browser and deployed Vercel SSE are unverified.

## 11. Anonymous-chat decision

Before this phase, non-staging local chat was anonymous by default. Anonymous users could query the bundled knowledge and attach a temporary PDF for provider processing; turns were not persisted, document upload/history routes required authentication, and vector retrieval returned no tenant documents without a principal. Health/model metadata were public in that behavior; rate limiting depended on configured Redis and otherwise fell back to per-process memory.

Staging and Vercel Preview now deny anonymous access to model/chat routes by default. The staging validator permits an explicit override only when both `ALLOW_ANONYMOUS_CHAT=true` and `ANONYMOUS_CHAT_APPROVED=true` are present. No product approval was provided or configured. Non-staging behavior was preserved.

## 12. Vercel configuration

Source inspection finds a catch-all `api/[...path].ts` Node serverless handler, 60-second `maxDuration`, included `knowledge.yaml` and `docs/**`, and a local Vite build output at `dist/`. The future Preview project should use the `work/source-archive` directory as root, `npm ci`, `npm run build`, `dist`, and an explicitly selected/tested Node.js major. Use only Preview-scoped staging environment values and place the function near the data region after residency review. The local runtime is Node.js `v24.16.0`; typings are `@types/node` 22.x, and the project has no runtime engine pin. Vercel documents Node.js 24.x as its current default and 22.x as supported; see the [official versions page](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions). Vercel CLI and `.vercel/project.json` are absent, so no linked project configuration was inspectable.

Vercel documents 4.5 MB request and response body limits; the code now uses 3 MiB raw uploads and a 4.2 MiB JSON parser limit. [Official function limits](https://vercel.com/docs/functions/limitations). The local Vite build does not validate serverless bundling, worker-thread support, Vercel routing, project settings, Preview environment-variable scopes, function logs, or proxy SSE. Vercel access and Preview deployment were unavailable; no deployment was attempted.

## 13. Open security and privacy risks

- RLS GUC values are settable by the application DB role; this does not stop a compromised DB session from setting all-tenant access.
- Output screening is heuristic; it is not DLP, semantic citation entailment, or a complete prompt-injection defense.
- Parser workers are not OS/container sandboxes; native parser resource use and dependency vulnerabilities need separate review.
- Real scanner efficacy, provider retention/training terms, backups/restore, deletion retention, revocation, audit sink, and incident monitoring are unverified.
- Anonymous chat remains enabled by default outside staging to preserve existing behavior; production product policy is not confirmed.
- The 3 MiB cap may be a product limit; larger files need a separately reviewed direct-upload design or platform that accepts larger payloads.

## 14. Missing prerequisites

Staging validation identified these missing variables by name only: `MONGODB_URI`, `MONGODB_DATABASE`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `DATABASE_URL`, `DATABASE_INGEST_URL`, `AUTH_ROLE_MAPPING`, `MALWARE_SCANNER_URL`, `MALWARE_SCANNER_TOKEN`, a Gemini embedding key (`GEMINI_API_KEY` or `GOOGLE_API_KEY`), and one supported chat-provider key. No explicit staging environment label or endpoint was present. Redis is optional but required for a distributed-rate-limit test. Vercel project access is required for preview build/runtime/SSE verification.

## 15. Next steps before production approval

1. Create/use only isolated staging service endpoints and secrets; record verified host, database, and staging designation before any DB connection.
2. Run the RLS migration and two-tenant role tests only on a disposable staging database; resolve or formally accept the caller-settable GUC risk.
3. Configure a test OIDC issuer and verify actual JWKS rotation, audience/issuer claims, roles, organizations, and revocation.
4. Configure the staging scanner and run the safe EICAR test fixture plus timeout/unavailable tests; retain no real malware.
5. Configure Redis and a budget-approved AI provider; verify multi-instance limits, provider behavior, and data-processing settings.
6. Execute the full staging upload-to-citation-to-delete/recovery journey with tenant/ownership denial fixtures.
7. Create a Vercel Preview deployment with staging-only scopes; test the serverless bundle, upload boundary, health, `/api/models`, chat, SSE timeout/disconnect, browser behavior, and logs.
8. Review backups, restore drills, audit/metrics sinks, data retention/deletion, and dependency/security scans.
9. Re-run the acceptance commands and update this report with real-service evidence before any production approval. Production deployment and production migrations remain separate actions and were not authorized here.

## Exact changed-file manifest relative to `dd1a66a`

```text
.env.example
README.md
api/[...path].ts
compose.yaml
docs/DATABASE_ARCHITECTURE.md
docs/DATABASE_MIGRATION.md
docs/DATABASE_RECOVERY.md
docs/DATABASE_SECURITY.md
docs/DEPLOYMENT_GUIDE.md
docs/ENVIRONMENT_VARIABLES.md
docs/INITIAL_TECHNICAL_AUDIT.md
docs/OBSERVABILITY.md
docs/PHASE_5_STAGING_REPORT.md
docs/PRODUCTION_ARCHITECTURE.md
docs/RAG_ARCHITECTURE.md
docs/SECURITY_AUDIT.md
docs/TEST_REPORT.md
infra/postgres/init/001-knowledge.sql
infra/postgres/migrations/002-document-chunks.sql
infra/postgres/migrations/003-document-chunk-rls.sql
package-lock.json
package.json
server/ai-provider.test.ts
server/ai-provider.ts
server/app.test.ts
server/app.ts
server/auth.test.ts
server/auth.ts
server/database.test.ts
server/database.ts
server/document-ingestion.failure.test.ts
server/document-ingestion.test.ts
server/document-ingestion.ts
server/embeddings.ts
server/environment.test.ts
server/environment.ts
server/gemini.ts
server/health.test.ts
server/health.ts
server/index.ts
server/initialize-mongodb.ts
server/mongodb.ts
server/observability.test.ts
server/observability.ts
server/rag.test.ts
server/rag.ts
server/rate-limit.ts
server/reconcile-documents.ts
src/App.tsx
```
