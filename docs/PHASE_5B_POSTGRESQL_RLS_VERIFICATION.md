# Phase 5B — PostgreSQL RLS Verification

**Date:** 2026-11-15 (Asia/Kolkata)

**Starting commit:** `dd1a66a287875e2d82e058505467104789699f57`

**Final commit:** unchanged; work remains uncommitted

**Verdict:** **POSTGRESQL RLS BLOCKED**

## Outcome summary

| Area | Status | Evidence |
|---|---|---|
| Migration 004 source review | **PASS — local code/test only** | Reviewed tenant claims, key storage, function ownership/privileges, fixed search paths, role/readiness checks, FORCE RLS, and migration role assumptions. This does not prove database behavior. |
| Signed application context | **PASS — local code/test only** | `server/rls-context.ts`, `server/database.ts`, and unit/source tests bind tenant/global flags, key ID, timestamp, nonce, and signature; set GUCs transaction-locally only after database readiness check. |
| Local unit/route suite | **PASS — local code/test only** | After turn-scoped loopback network permission: 106 passed, 0 failed, 0 skipped. |
| PostgreSQL adversarial suite | **BLOCKED** | The suite was skipped because no disposable PostgreSQL service, roles, key, or guarded loopback `_integration` database was available. Added cases were typechecked but not executed. |
| PostgreSQL version and pgvector availability | **BLOCKED** | No PostgreSQL server/client or container runtime was present; version and extension state are unknown. The project includes `pg@8.23.1`, which is a client driver only. |
| Migrations 003/004 live state | **BLOCKED** | No database connection or migration was attempted. Repository contains migrations 002, 003, and 004; the Phase 5A report records 004 as unapplied. |
| Role configuration / signing key | **BLOCKED** | No roles, grants, keys, or RLS policies were inspected in a running database. No local key was generated or provisioned. |
| Production/staging | **NOT RUN** | No remote database, production secret, migration, or deployment was accessed. |

## Environment inventory

Commands/checks used:

```powershell
Get-Command docker,docker-compose,psql,postgres,initdb,pg_ctl,wsl -ErrorAction SilentlyContinue
wsl --status
node --version
npm ls pg --depth=0
```

Observed: Docker, Compose, `psql`, `postgres`, `initdb`, and `pg_ctl` are unavailable. `wsl.exe` exists, but `wsl --status` reports that WSL is not installed. Node is v24.16.0 and the installed PostgreSQL driver is `pg@8.23.1`. No software was installed. Therefore real-service execution stopped as requested.

## Static security review of migration 004

- The signed payload covers version, key ID, hex-encoded tenant ID, global-access flag, 10-digit issue time, and UUID v4 nonce. The SQL verifies HMAC-SHA256 and rejects missing/malformed values or contexts more than 300 seconds from the current statement timestamp.
- The 32-byte key is stored in `app_private.rls_context_keys`, owned by a `NOLOGIN` context-owner role. Reader/writer roles have no key-table privileges. A separate `NOLOGIN` key-admin role receives provisioning DML. The application signing key remains in the trusted Node process environment.
- `app_private.rls_context_matches(text)` and `app_private.rls_context_ready(text,text)` are `SECURITY DEFINER` functions with fixed `search_path = pg_catalog, app_private`. Public execution is revoked; the RLS helper is executable by the application roles; the HMAC primitive is granted to the context-owner role.
- The readiness check requires `session_user` to equal the expected reader or writer login; checks `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, and `NOCREATEROLE`; verifies forced RLS and the expected policy; checks the table owner is not an application role or assumed through membership; checks application roles cannot access the key table; and rejects membership in protected/privileged roles.
- Migration 004 enables and forces row security on `knowledge.document_chunks`, drops the older direct-GUC policy, and creates a policy for only the expected runtime reader/writer roles. Migration 003 remains unsafe until 004 is applied to a given database.
- `setSignedRlsContext` first calls the readiness helper, then sets all context values using `set_config(..., true)` inside the caller's transaction. Retrieval and chunk-write paths call it after `BEGIN`; connection release follows commit or rollback paths.
- The migration operator is granted membership in the no-login context-owner and key-admin roles so it can transfer ownership and provision keys. Keep that operator credential out of runtime configuration. `DATABASE_MIGRATION_URL` in the local guide points to a disposable local superuser for setup; it is never used by the runtime app.
- The nonce is not persisted as a one-use token. A signed context can be replayed within its five-minute age window but remains bound to its signed claims. The SQL uses bytea equality for HMAC comparison; a constant-time comparison guarantee was not established. A compromised application host/key can mint tenant or signed global contexts. PostgreSQL superusers and `BYPASSRLS` roles bypass RLS; migration/object-owner roles can alter policy state.
- Migration-runner ledger and advisory lock behavior are present in `server/database.ts`. No database was used to prove a clean apply, second-run skip, rollback behavior, extension placement, managed-service compatibility, or migration failure recovery.

## Adversarial test coverage prepared

`server/postgres-rls.integration.test.ts` is guarded by `APP_ENV=local-integration`, `RUN_LOCAL_POSTGRES_RLS_TESTS=true`, loopback reader/writer/migration URLs, separate usernames, and one database ending `_integration`. It contains checks for own/cross-tenant reads, insert/update/delete restrictions, absent/malformed/altered/expired context, replayed-context scope in another session, reader write denial, key/HMAC function access, protected role switching, wrong runtime identity, forced RLS metadata, signed global context, and transaction rollback/commit cleanup. It also checks the configured migration login's `SUPERUSER`/`BYPASSRLS` behavior and that a non-bypass identity without a signed reader claim sees no rows (or lacks table access).

These are **prepared, not executed**. The real suite result is **BLOCKED: 1 top-level test skipped, 0 passed/executed**. SQL adversarial results are not available. No mock was substituted for PostgreSQL.

## Application-level cross-database suite

`server/local-services.integration.test.ts` covers MongoDB/PostgreSQL ingestion lifecycle, pgvector probing, idempotency, deletion, recovery after PostgreSQL outage, Redis, scanner contract, and local OIDC when guarded loopback services are configured. `npm run test:integration:local` reported 4 skipped, 0 executed. No service was contacted.

## Commands and actual results

| Command | Actual result |
|---|---|
| `npm test` (first attempt) | **FAIL — environment:** 89 passed, 17 failed with `EACCES` connecting to each test's own loopback Express server before route assertions. |
| Request turn-scoped network permission for loopback | Granted for this turn. |
| `npm test` (after permission) | **PASS — local code/test only:** 106 passed, 0 failed, 0 skipped. Tests were unchanged. |
| `npm run lint` | **PASS:** `tsc --noEmit`, no diagnostics. |
| `npm run build` | **PASS:** Vite 8.3.8 built `dist/`. Does not compile or verify the Vercel function runtime. |
| `git diff --check` | **PASS:** no whitespace errors; normal Windows line-ending notices appeared. |
| `npm run test:integration:rls` | **BLOCKED:** 1 skipped, 0 passed/executed. |
| `npm run test:integration:local` | **BLOCKED:** 4 skipped, 0 passed/executed. |

## Windows local setup

The exact PowerShell procedure, loopback-only container binding, distinct runtime roles, disposable database identity check, safe migration/key/test sequence, and explicit cleanup confirmation are in [POSTGRES_RLS_LOCAL_SETUP_WINDOWS.md](POSTGRES_RLS_LOCAL_SETUP_WINDOWS.md). That guide is prepared but not run here. Required prerequisite: Docker Desktop with Linux containers and the `pgvector/pgvector:pg16` image; WSL is not installed in this environment.

## Exact files changed in this phase

- `docs/ARCHITECTURE.md` — new repository-derived architecture and workflow audit.
- `docs/PHASE_5B_POSTGRESQL_RLS_VERIFICATION.md` — this report.
- `docs/POSTGRES_RLS_LOCAL_SETUP_WINDOWS.md` — new local Windows procedure.
- `docs/REQUIREMENTS_TRACEABILITY_MATRIX.md` — new matrix; unspecified requirement descriptions remain blocked.
- `docs/SECURITY_AUDIT.md` — appended Phase 5B static review and limitations.
- `docs/SRS_UPTOSKILLS_AI_SUPPORT_ASSISTANT.md` — was initially a source-missing placeholder; replaced in Phase 6 with the authoritative baseline in the Phase 6 prompt, with the DOCX retained as an older supporting reference.
- `docs/TEST_REPORT.md` — appended actual Phase 5B test and SRS-source results.
- `server/postgres-rls.integration.test.ts` — added gated cases for invalid/expired signatures, replay scope, reader write denial, and HMAC function privilege.

The substantial existing uncommitted Phase 4/5 work was preserved; it is not re-listed as a change made in this Phase 5B/governance pass.

## Remaining security limitations and required live evidence

- Migration 004 has not been applied to a real database. Any database still on migration 003 retains the direct-GUC trust risk.
- No live role membership, table owner, `BYPASSRLS`, key visibility, HMAC helper, extension schema, signed tenant query, SQL injection/forgery, or pooled-connection result was observed.
- Context replay is time-bounded but not one-use. Application compromise/key disclosure remains a trust-boundary failure.
- PostgreSQL operator compatibility with role creation/membership, pgcrypto schema placement, and migration privileges is unknown.
- Real MongoDB/PostgreSQL reconciliation and recovery, OIDC issuer/JWKS, scanner efficacy, provider privacy, Redis failover, Vercel serverless/streaming, and staging remain unverified.
- At the time of this Phase 5B verification the SRS baseline was unavailable. The authoritative Phase 6 baseline was supplied afterward and transcribed; this does not change the blocked live PostgreSQL/RLS result.

**Final verdict: POSTGRESQL RLS BLOCKED.** No production migration, secret change, deployment, or remote database access occurred.
