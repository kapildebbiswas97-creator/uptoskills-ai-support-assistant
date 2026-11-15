# Phase 5A — PostgreSQL RLS Security and Integration Readiness

Date: 2026-11-15 (Asia/Kolkata)
Starting commit: `dd1a66a287875e2d82e058505467104789699f57`
Final commit: `dd1a66a287875e2d82e058505467104789699f57` (all work remains uncommitted)
Verdict: **SECURITY REMEDIATION PARTIALLY VERIFIED**

| Area | Status |
|---|---|
| HMAC signer and fail-closed application wiring | PASS — local code/tests only |
| PostgreSQL migration 004 and adversarial runtime behavior | PARTIAL — migration written and source-checked; no server ran it |
| Local integration environment | PARTIAL — gated real-service suites and safe local key helper prepared; no complete container config available |
| Real MongoDB/PostgreSQL/Redis/scanner/OIDC services | BLOCKED — absent |
| Provider privacy configuration | PARTIAL — data paths inspected; provider-specific retention and training settings unknown |
| Production/Vercel readiness | BLOCKED — no Preview project/runtime verification, migration, or deployment |

## 1. Scope and preservation

Work continued in the existing `work/source-archive` checkout. Existing Phase 4/5 changes were preserved; nothing was reset, overwritten, committed, deployed, or run against production. No database migration or signing-key provisioning was run. No paid service or external provider was contacted.

## 2. RLS vulnerability and remediation design

Migration 003 places `app.tenant_id` and `app.allow_all_tenants` directly in the RLS predicate. Any caller using an application database session can set PostgreSQL custom GUCs with `set_config`; transaction-local settings do not authenticate the value. A compromised reader/writer credential or arbitrary SQL execution in that session can select another tenant's context and, for reads, enable the old all-tenant branch. Parameterized normal application code and verified OIDC claims reduce exposure but do not make the database setting itself trustworthy.

Additive migration `004-signed-tenant-rls.sql` replaces the caller-trusted predicate with a signed context. The application signs a canonical payload containing the tenant, global-access flag, key ID, issue time, and random nonce using HMAC-SHA256. PostgreSQL verifies the signature against a private key table in a hardened `SECURITY DEFINER` function with a fixed `search_path`. The key table is not readable by reader/writer roles. The readiness function binds to `session_user` and requires `DATABASE_URL` to log in as `uts_assistant_reader` and `DATABASE_INGEST_URL` as `uts_assistant_writer`; an admin/migration runtime URL fails closed even if it can bypass RLS. Context values are set with `set_config(..., true)` inside the existing transaction and expire after five minutes. The helper fails closed when migration 004 or the matching enabled key is absent.

The context owner and key-admin roles are `NOLOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, and have no database/role creation privileges. Migration 004 rejects reader/writer roles that have privileged attributes or membership in privileged/context/key-admin roles; runtime readiness also rejects application roles that own or can assume the chunk-table owner. The migration operator receives membership in the no-login context/key-admin roles to perform object ownership and key-provisioning operations. Keep that operator out of runtime credentials.

This is not protection against a compromised application host or exposed HMAC key: the trusted server can mint any tenant context, including the signed global-access context used by internal admin/reconciliation paths. PostgreSQL superusers and roles with `BYPASSRLS` bypass RLS; migration/table owners can alter the policy. The nonce makes contexts unique, but is not stored as a one-use database token; replay within the five-minute window carries only the signed claims. A SQL caller that can observe the session settings cannot change those claims without the key.

Migration 003 remains historically unsafe until 004 is actually applied. Migration 004 is in this checkout but has not been executed against any database. Therefore the remediation is not live-verified and the old database-side vulnerability remains open wherever only 003 is applied.

PostgreSQL primary references: [pgcrypto HMAC](https://www.postgresql.org/docs/current/pgcrypto.html), [CREATE FUNCTION and SECURITY DEFINER](https://www.postgresql.org/docs/current/sql-createfunction.html), [row security behavior and bypass roles](https://www.postgresql.org/docs/17/ddl-rowsecurity.html), and [SET ROLE](https://www.postgresql.org/docs/current/sql-set-role.html).

## 3. Exact Phase 5A changed files

- `.env.example`
- `docs/DATABASE_ARCHITECTURE.md`
- `docs/DATABASE_MIGRATION.md`
- `docs/DATABASE_SECURITY.md`
- `docs/DEPLOYMENT_GUIDE.md`
- `docs/ENVIRONMENT_VARIABLES.md`
- `docs/PHASE_5_STAGING_REPORT.md`
- `docs/PHASE_5A_SECURITY_AND_INTEGRATION_REPORT.md`
- `docs/SECURITY_AUDIT.md`
- `docs/TEST_REPORT.md`
- `infra/postgres/migrations/004-signed-tenant-rls.sql`
- `package.json`
- `scripts/migrate-local-postgres.ts`
- `scripts/provision-local-rls-key.ts`
- `server/database.test.ts`
- `server/database.ts`
- `server/environment.test.ts`
- `server/environment.ts`
- `server/local-services.integration.test.ts`
- `server/postgres-rls.integration.test.ts`
- `server/rls-context.test.ts`
- `server/rls-context.ts`

Other modified/untracked files in the checkout are inherited Phase 4/5 work listed in `PHASE_5_STAGING_REPORT.md`; they were not replaced by this phase.

## 4. Verification results

| Check | Result | Evidence and scope |
|---|---|---|
| `npm test` | **PASS — local code/test only** | 106 passed, 0 failed, 0 skipped. Loopback Express tests passed after temporary turn-scoped network permission was granted for the test servers. No external service was contacted. |
| `npm run lint` | **PASS — local code/test only** | `tsc --noEmit` completed without diagnostics, including gated integration sources and local key-provisioning code. |
| `npm run build` | **PASS — local code/test only** | Vite 8.3.8 built the client into `dist/`. This does not compile or execute the Vercel function. |
| `git diff --check` | **PASS — local code/test only** | No whitespace errors; Git emitted expected Windows LF-to-CRLF notices. |
| `npm run test:integration:rls` | **BLOCKED — skipped** | Test suite reports 1 skipped because `APP_ENV=local-integration`, loopback `_integration` database URLs, distinct reader/writer/migration roles, and a provisioned key are absent. No PostgreSQL connection occurred. |
| `npm run test:integration:local` | **BLOCKED — skipped** | Four gated suites skipped: MongoDB/PostgreSQL lifecycle, Redis, scanner, and local OIDC. No services were contacted. |
| Docker / Compose / `psql` availability | **BLOCKED** | `docker` and `psql` are not installed/available in this environment. No containers were started or installed. |
| Real PostgreSQL RLS behavior | **BLOCKED** | SQL has static/source checks only. No RLS migration, role setup, key provisioning, or adversarial database query was run. |
| Staging/production | **NOT RUN** | No endpoint or verified staging credentials were available. No deployment, migration, production secret change, or external AI/scanner request occurred. |

The initial `npm test` attempt before temporary loopback permission had 17 `EACCES` failures while test clients connected to their own `127.0.0.1` Express servers. The routes were not reached in that attempt. After temporary turn-scoped permission was granted, the unchanged application tests passed 106/106. The gated service test counts above remain skipped and are not counted as passes.

## 5. Local integration preparation and exact commands

No complete integration Compose stack was configured because Docker/Compose are unavailable. The existing `compose.yaml` only defines development PostgreSQL (`uptoskills`, persistent `postgres_data`) and Redis. It does not provide a disposable `_integration` database, MongoDB, a scanner implementing this app's HTTP contract, or an OIDC identity provider; it is not a valid target for the guarded integration tests.

On a machine with Docker Desktop/Compose, the only currently available partial-service command is:

```powershell
docker compose --profile infrastructure up -d postgres redis
docker compose ps
```

Those commands start only the existing development services. Do not run the integration suites against them: the database name/volume do not meet the `_integration` guard. A complete isolated setup must provide loopback-only MongoDB, PostgreSQL 16+ with pgvector and disposable DB name ending `_integration`, separate reader/writer/migration logins, Redis, a scanner exposing the documented bearer-token HTTP JSON contract, and (optionally) a local OIDC issuer/JWKS. Use non-production credentials, separate disposable volumes, and host-only port bindings. The current Compose file does not satisfy these requirements, so there is no verified single command to start the full environment yet.

Once those isolated local services and roles exist, set the following PowerShell process variables from local-only values/secret storage (do not copy staging or production credentials):

```powershell
$env:APP_ENV = 'local-integration'
$env:RUN_LOCAL_POSTGRES_RLS_TESTS = 'true'
$env:RUN_LOCAL_SERVICE_TESTS = 'true'
$env:DATABASE_URL = 'postgresql://uts_assistant_reader:<local-password>@127.0.0.1:5432/<name>_integration?sslmode=disable'
$env:DATABASE_INGEST_URL = 'postgresql://uts_assistant_writer:<local-password>@127.0.0.1:5432/<name>_integration?sslmode=disable'
$env:DATABASE_MIGRATION_URL = 'postgresql://<operator>:<local-password>@127.0.0.1:5432/<name>_integration?sslmode=disable'
$env:MONGODB_URI = 'mongodb://<local-user>:<local-password>@127.0.0.1:27017/?authSource=admin'
$env:MONGODB_DATABASE = '<name>_integration'
$env:RLS_CONTEXT_KEY_ID = 'local-' + ([guid]::NewGuid().ToString('N'))
$env:RLS_CONTEXT_HMAC_KEY = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Run migrations and provision a local key only against that disposable loopback database, then run each explicit integration suite:

```powershell
npm run db:postgres:migrate:local
npm run db:postgres:provision-local-rls-key
npm run test:integration:rls
npm run test:integration:local
```

The local migration command refuses non-loopback URLs and database names without the `_integration` suffix. The general operator migration command is not constrained to local databases.

Configure `REDIS_URL`, `MALWARE_SCANNER_URL`/`MALWARE_SCANNER_TOKEN`, and `LOCAL_OIDC_ISSUER`/`LOCAL_OIDC_JWKS_URL`/`LOCAL_OIDC_AUDIENCE`/`LOCAL_OIDC_VALID_TOKEN` only when those services are loopback-only. The tests reject remote URLs. The local dual-database suite uses a local fake embedder and scanner stub for repeatable persistence/recovery checks; separate scanner/OIDC/Redis suites exercise their local services when supplied. It never calls a paid model. `npm run db:postgres:provision-local-rls-key` refuses non-loopback hosts and database names not ending `_integration`, uses bound values, and does not print the secret.

`docker compose down` stops the partial development stack but preserves its named volume. Do not use `down -v` on an existing developer volume. A disposable integration stack should have its own unique project and volumes, and only those integration volumes should be removed after confirming the project name and targets.

## 6. Local integration coverage prepared

- PostgreSQL: signed own-tenant reads; cross-tenant reads, inserts, updates, and deletes; absent/malformed/tampered context; all-tenant signature behavior; pool commit/rollback cleanup; key-table and protected-role access; wrong reader/writer login and migration-role rejection; table-owner separation.
- MongoDB/PostgreSQL: authenticated local Mongo connection and CRUD through ingestion; pgvector dimension/extension probe; idempotent ingestion, lifecycle status, deletion propagation, and recovery after a loopback PostgreSQL writer outage.
- Redis: two independent limiter clients share the same test limit.
- Scanner: harmless fixture contract and fail-closed behavior when an endpoint is unavailable. A clean result does not prove malware-detection efficacy; no EICAR or malicious file was sent.
- OIDC: supplied test token against a loopback issuer/JWKS and invalid-token rejection. Local issuer success does not verify the intended staging identity provider.

All of the above are **prepared but BLOCKED** for real-service execution. Unit/fault-injection coverage remains local-only. No real service result is claimed.

## 7. Provider privacy and anonymous access

The selected chat provider receives the user question, recent conversation history, and authorized retrieved excerpts. Gemini chat also receives an attached PDF as inline content. Gemini embeddings receive the document chunks and retrieval query. OpenRouter web search may be invoked when configured and the request asks for current research. The code contains no provider retention, deletion, or model-training control. No API key/provider request was available or made; confirm the selected provider, account plan, retention/training terms, residency, and opt-out controls before sending sensitive data. Ollama can be configured locally, but its endpoint/host and logs still require review.

Provider request errors are returned as sanitized generic API errors; logs include provider label, request/RAG IDs, duration or error type, but not the prompt, document text, or credential. The chat route buffers generated output before citation/sensitive-output review. Timeout/disconnect behavior is covered by local mocked HTTP tests, not a live provider.

Phase 5 staging behavior keeps anonymous access disabled for staging and Vercel Preview unless the two explicit approval flags are set; no approval is configured. Private conversation/document routes remain authenticated and owner/tenant-scoped. Rate limiting falls back to per-process memory if Redis is missing or unavailable, so distributed enforcement remains unverified.

## 8. Remaining requirements and open vulnerabilities

- Apply migration 004 and provision its matching per-environment key only after a disposable real PostgreSQL run validates the SQL, role memberships, pgcrypto placement, pool cleanup, and adversarial queries. Then conduct a separate approved isolated-staging rollout. Database still on 003 retains the old GUC vulnerability.
- Validate that the target Postgres operator supports role creation, extension placement, `SET ROLE` to the no-login context/key-admin roles, and the expected pgvector/pgcrypto privileges. Managed Postgres restrictions may block migration 004.
- Validate distinct reader/writer identities and ensure no app role owns the table, can assume the owner, or inherits superuser/BYPASSRLS privileges.
- Application compromise or HMAC secret exposure enables forged tenant/global contexts. Superuser/BYPASSRLS and migration roles remain privileged trust roots. Signed GUC claims are replayable for up to five minutes within their exact scope.
- Provider privacy/retention, real OIDC/JWKS rotation, scanner efficacy, Redis failure/reconnect, live cross-database recovery, and service backups/restores are unverified.
- Vercel project root/settings, runtime selection, serverless bundle, streaming proxy, environment scopes, and deployed behavior remain unverified. `npm run build` verifies only the Vite client.
- Source files for the Vercel function (`api/[...path].ts`) and `vercel.json` exist; `vercel.json` selects that catch-all with a 60-second maximum duration and includes `knowledge.yaml`/`docs/**`. The project root must be the directory containing `package.json`, `api/`, and `src/` (this `work/source-archive` directory). Actual Vercel root/runtime/environment scopes and serverless bundle were not inspectable or verified.
- Existing heuristic output screening is not complete DLP or semantic citation entailment; parser workers are not OS/container isolation.

## 9. Production readiness

**NOT READY.** Build and local tests pass, but migration 004 is unapplied, the signed key is not provisioned, no local real-service integration suite ran, and no remote staging service or Vercel Preview was verified. No deployment, production migration, or production secret change occurred.

## 10. Next verification commands

```powershell
npm test
npm run lint
npm run build
git diff --check
npm run test:integration:rls
npm run test:integration:local
```

Run integration commands only after checking `APP_ENV=local-integration`, loopback hostnames, and `_integration` database names. Do not use production service URLs or production credentials.
