# Phase 4 Security Audit

## Phase 9.1 serverless readiness and authentication (2026-11-15)

- The Vercel function imports use explicit `.js` relative specifiers through the server-side graph. A build-time esbuild check and bundled-handler smoke test cover the resolved source graph and fail on extensionless local runtime imports.
- Missing Preview integrations no longer abort route initialization. `/api/health` returns 503/degraded when required MongoDB, PostgreSQL, model, or OIDC configuration is unavailable; route-level authentication remains fail-closed and test-smokes at 401.
- Production and Preview chat require authentication by default, including when `ALLOW_ANONYMOUS_CHAT=true`. This does not provide a browser sign-in UI; that integration remains a release blocker.
- The runtime regression uses no external provider/database credentials and is not live service evidence. The locally installed runtime is Node 24.16.0; the bundle target is Node 26. Actual Vercel Node 26 output/logs remain unverified.

## Phase 8 meeting request workflow (2026-11-15)

- Requester routes use the server-verified OIDC principal. Requester and tenant IDs are derived from that principal, and repository filters scope list/detail/cancel reads and writes. Optional conversation references are accepted only after owner/tenant validation.
- HR routes use the existing trusted `support_agent` mapping, with generic administrator bypass disabled. The API independently checks the role on each request; hiding the UI is not the security boundary. HR query/update operations are tenant-scoped.
- Requester DTOs are explicit projections and omit HR actor identity, tenant, audit records and idempotency hashes. HR has a separate view. There is no internal note field/endpoint in this workflow.
- Confirmation requires a pending request, expected version, explicit valid future schedule and IANA timezone. Actor and confirmation time come from verified principal/server clock. Audit metadata records status transition and `hr_manual` source without purpose or full request body.
- Create and transition code use Mongo sessions and write the audit event in the same transaction; source and mocked transaction/fault tests pass. Actual transaction support is not verified: the disposable Mongo replica-set test was skipped because no integration DB was configured.
- Generated-key OIDC loopback API tests cover anonymous/role denial, ownership, tenant isolation, spoofed actor/timestamp rejection, decision conflicts and requester DTO secrecy. Real identity-provider claims, browser session, database tenant isolation, retention, log access and deployed function behavior remain unverified.
- No external calendar, email, SMS, or notification call is made. D-07 approval of reviewer authority and queue policy remains open.

## Phase 7 HR escalation continuation update (2026-11-15)

This continuation review inspected the current code and ran generated-key HTTP route tests. It is not a live identity-provider/database assessment.

| Control | Current finding | Evidence boundary |
|---|---|---|
| OIDC validation and JWKS | Exact configured issuer/audience, RS256/ES256, `sub`/`iat`/`exp`, `nbf`, 12-hour maximum token age, bounded subject, and configured HTTPS JWKS in production. `jose` remote JWKS caching supports refresh/rotation on unknown key IDs. Missing credentials receive 401; malformed/invalid/expired tokens receive 401; a supplied token with unavailable auth configuration/JWKS receives 503. | Generated signing-key tests cover signature, issuer, audience, expiry, not-before, malformed token and claim mapping. No real issuer or rotation run. |
| HR claim mapping | Only validated signed role claims mapped through `AUTH_ROLE_MAPPING` create application roles. HR requires mapped `support_agent` with administrator bypass disabled. Neither this checkout's `.env` nor `.env.example` has an HR mapping; a specific trusted HR group must be configured explicitly. | HTTP test proves mapped group access and requester/generic admin denial. The actual IdP group and role policy remain D-05. |
| Requester identity/tenant | Requester/tenant are derived from the verified principal. Ticket filters scope by both values; conversation references must match owner/tenant. Client role/user/tenant/status fields are rejected. | Route tests prove owner and cross-tenant denial with an in-memory service; real Mongo authorization remains unverified. |
| Requester data projection | Requester DTOs are explicit allowlists and omit internal notes, requester/tenant IDs, consent internals and audit records. HR has a separate DTO and tenant gate. | HTTP response assertions cover note and identity-field non-disclosure. |
| HR actions and audit | Every queue/detail/status/note route rechecks the authenticated role. Status updates use allowed transitions and expected versions. Create/status/note persistence and audit records share Mongo transactions; denial logs include trusted actor ID, role mapping and request correlation context, without ticket body/note content. | Mock transaction rollback and HTTP denial/success tests pass. Live Mongo transaction support, write concern, log sink/retention, and actual HR access are unverified. |
| Browser authentication | No browser OIDC client/session integration exists. UI uses a same-origin fetch but the backend expects a verified bearer principal. Anonymous ticket create is denied and UI explains sign-in is unavailable. | Vite build only; no browser/component integration test. |

MongoDB must run as a replica set or sharded cluster for the ticket/audit multi-document transaction. A standalone deployment is unsupported and should fail the operation. No database was connected in this phase. D-01 remains open for authentication/anonymous policy; D-06 remains open for HR destination, reviewers, SLA, and contact-data requirements; D-09 retention remains open. Production readiness remains **NOT READY**.

Review date: 2026-11-15. This is a source review plus local unit/HTTP tests, not a penetration test or production certification.

## Status

| Control | Status | Evidence and limitation |
|---|---|---|
| OIDC issuer/audience/signature/algorithm/expiry/not-before/subject | PARTIAL | `jose` checks exact issuer/audience, RS256/ES256, required `sub`/`exp`/`iat`, `nbf` when present, and 12-hour max token age. Local generated-key tests cover wrong signature, issuer, audience, expiry and not-before. No real issuer or JWKS rotation/revocation test. |
| Role and tenant claim mapping | PARTIAL | Roles map from a signed claim through `AUTH_ROLE_MAPPING`; tenant comes only from a signed configurable claim. Client role/tenant fields are ignored. Live issuer claim configuration and membership lifecycle are unverified. |
| MongoDB ownership and tenant scope | PARTIAL | Conversation reads remain owner/tenant scoped; document status/delete scopes enforce owner/tenant or manager access; retrieval permission checks use MongoDB before and after vector search. No live IDOR or cross-tenant tests. |
| PostgreSQL tenant isolation | PARTIAL | Migration 004 and application code replace the caller-trusted GUC policy with a five-minute HMAC-signed transaction context, a private signing-key table, fixed-search-path `SECURITY DEFINER` verification, expected `session_user` checks for reader/writer connections, least-privilege role checks, and transaction-local settings. The migration has not been applied to any database and the real PostgreSQL adversarial suite was gated/skipped, so the currently deployed database state and actual isolation are unverified. Until 004 is applied, migration 003 remains vulnerable to caller-settable tenant/global-access settings. |
| Buffered output review | PARTIAL | Streamed answers are buffered before exposure, secret-like credential patterns and selected prompt disclosure patterns block the answer, and ungrounded URLs/citations are removed. Heuristic screening is not DLP and cannot detect every sensitive fact or system-prompt paraphrase. |
| Document scanning and parser controls | PARTIAL | Uploads fail closed unless a scanner is configured and returns `clean`. DOCX ZIP expansion/path checks are present. PDF/DOCX parse in a worker with timeout and V8 heap bounds. No scanner is configured or live-tested; worker threads are not an OS/container sandbox. |
| Citation and prompt-injection controls | PARTIAL | Model citations are discarded and server citations come from retrieved source headers. Prompt instructions treat user/retrieved content as untrusted. No claim-level semantic entailment or full adversarial corpus. |
| Logs, metrics, and rate limits | PARTIAL | Structured events omit sensitive field keys; request and trace IDs, an injectable metrics sink, latency events, and security counters are present. Redis is shared when configured; fallback is per-process and emits a warning. No production sink/alerts or live Redis test. |
| Anonymous chat | PASS (local policy) | `APP_ENV=staging`, `NODE_ENV=staging`, and Vercel `VERCEL_ENV=preview` require authentication for `/api/models`, `/api/chat`, and `/api/chat/stream` by default. Staging validation accepts anonymous chat only when both `ALLOW_ANONYMOUS_CHAT=true` and `ANONYMOUS_CHAT_APPROVED=true` are set. No product approval is configured here. Local tests prove unauthenticated requests stop before provider or retrieval calls. |

## Remaining risks

- Output scanning is pattern-based. It can miss secrets, sensitive personal data, or paraphrases of internal instructions. Streaming is buffered to form a validation boundary, so token-level progressive output is not preserved.
- The configured model provider receives user history and authorized source content; provider retention and data-processing terms were not reviewed.
- The external scanner adapter is not itself a malware engine. Without configured scanner URL/token, upload ingestion is blocked. Scanner correctness, false negatives, data handling, and network availability remain staging dependencies.
- Worker thread resource limits are not a secure OS sandbox, and native parser memory use may exceed V8 limits. Container/process CPU and memory controls and dependency/CVE review remain necessary.
- No live DB, OIDC, scanner, provider, or Redis tests were run in Phase 5A. The signed RLS design blocks arbitrary GUC tampering only after migration 004 and key provisioning; the app process and key are still trusted, while PostgreSQL superuser/BYPASSRLS/migration roles can bypass or change policy. Deployment roles must remain least privilege and SQL parameterized.
- Non-staging behavior still permits anonymous chat by default to preserve existing behavior. Anonymous users can reach health/model metadata and general chat, including temporary PDF attachments processed by the configured provider; those turns are not persisted, and vector retrieval returns no tenant documents without a verified principal. Document upload, conversation history, and tenant document operations require authentication and role checks. Anonymous usage is limited per client address, but without Redis that limit is per process. Staging/Preview now requires authentication by default.
- Retention/deletion, encryption-at-rest, backup restoration, emergency access, token revocation and account disablement have not been verified.

## Before production

Use isolated staging services. Validate issuer claims/JWKS rotation and role mapping, cross-tenant and owner denial against real databases, RLS role grants, scanner behavior, hostile files, prompt injection, provider data handling, Redis failover, backups/restores, and SSE proxy behavior. Review all heuristic output-screening limits. No deployment, production migration, or production-secret change was performed.

## Phase 5 staging update

No real staging identity provider, database, scanner, Redis, AI provider, or Vercel deployment was configured or contacted. The local `.env` metadata check found no staging designation or configured service endpoint. RLS migration `003-document-chunk-rls.sql` was reviewed but not applied. Its custom `app.tenant_id` and `app.allow_all_tenants` settings are caller-settable by the application DB role, so RLS is defense in depth and not a separate identity boundary. Live role, policy, ownership, and tenant-isolation verification remains BLOCKED. See `PHASE_5_STAGING_REPORT.md` for the exact procedure and risks.

## Phase 5A RLS remediation update

The additive migration `004-signed-tenant-rls.sql`, signed-context helper, local-only key-provisioning command, and explicitly gated local PostgreSQL/service test suites are now in the checkout. Static TypeScript checks and unit tests verify signing and fail-closed setup. Docker, Docker Compose, and `psql` are unavailable, so no real database was started, migrated, provisioned, or queried. Both integration commands skipped all live checks under their documented gates. Therefore the code remediation is **PARTIAL**, and database security remains **BLOCKED** until the migration/key setup is exercised on an isolated integration DB and then deliberately applied to staging. See `PHASE_5A_SECURITY_AND_INTEGRATION_REPORT.md`.

## Phase 5B verification update (2026-11-15)

The Phase 5B source review confirms that migration 004 intends to replace caller-trusted GUC policies with HMAC-signed tenant/global claims, five-minute context age, a private key table, fixed-search-path `SECURITY DEFINER` checks, exact `session_user` role binding, and forced RLS on `knowledge.document_chunks`. The application connection helper checks readiness before setting transaction-local GUCs. Runtime roles are denied key-table access and checked for privileged attributes/memberships in SQL. This is source-level evidence only.

The gated SQL integration suite now contains cases for altered and expired contexts, replayed context scope, reader write denial, HMAC function access, key visibility, privileged role switching, cross-tenant operations, pooled-connection cleanup, forced-RLS metadata, and the configured migration login's `SUPERUSER`/`BYPASSRLS` visibility behavior. No case ran against PostgreSQL. This environment has no Docker, PostgreSQL client/server binaries, or installed WSL. The tests were not treated as passed. The old direct-GUC policy in migration 003 remains an open database-side risk wherever migration 004 has not been applied.

The signature nonce is unique but not tracked as a one-use token. A valid context is replayable within its five-minute age window; its signed tenant and global-access claims cannot be changed without the key. Replay-scope coverage is prepared but unverified against PostgreSQL. The application process and HMAC secret are trusted; compromise permits minting contexts. PostgreSQL superusers, `BYPASSRLS`, and migration/operator identities remain privileged trust roots. The SQL compares computed and supplied HMAC byte strings with PostgreSQL equality; no live timing behavior or constant-time guarantee was verified.

The local Express suite initially failed 17 tests with `EACCES` on test-owned `127.0.0.1` connections, then passed unchanged 106/106 after turn-scoped network permission. That sandbox issue is separate from RLS evidence. See `PHASE_5B_POSTGRESQL_RLS_VERIFICATION.md` for exact commands, status, and limitations.
