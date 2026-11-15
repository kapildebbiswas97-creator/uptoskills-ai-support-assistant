# Proposed Implementation Roadmap

**Status:** Proposed engineering sequence; not stakeholder-approved scope changes.  
**Baseline:** SRS v1.0 remains a draft pending stakeholder approval. Current architecture is React + Node.js, MongoDB Atlas for operational records, and PostgreSQL + pgvector for retrieval. No production work is authorized by this roadmap.

The requirements and actual code gaps are mapped in [REQUIREMENTS_TRACEABILITY_MATRIX.md](REQUIREMENTS_TRACEABILITY_MATRIX.md). Workstream names preserve P0–P8 from the SRS. Sequence dependencies are intentional: agree contracts and decisions before building persistent workflows, then verify them in isolated services.

## P0 — Requirements and contracts

- **Deliverables:** Approve the transcribed SRS; confirm D-01–D-10; define API schemas, record ownership, status transitions, authorization boundaries, and service contracts.
- **Owner:** P0 project lead/system coordinator, with P2/P3/P4/P5/P6/P7 input.
- **Current status:** PARTIALLY IMPLEMENTED — full source SRS and trace matrix are now present; stakeholder approval and decisions remain open.
- **Dependencies:** HR, content, privacy, identity, provider, calendar, hosting, and operations stakeholders.
- **Acceptance test:** Every FR/NFR/UC/AC is linked in the matrix, decisions have recorded owners/outcomes, and API/data contracts have reviewed examples and error cases.
- **Blocking decisions/services:** All D-01–D-10 pending stakeholder confirmation; formal architecture/operational ownership sign-off.
- **Sequence:** Start here; gate new cross-team workflow implementation on agreed contracts.

## P1 — Reliable chat and RAG

- **Deliverables:** Approved knowledge corpus, authorized hybrid retrieval, grounded responses, page/section citations, safe fallback, authenticated conversation history, safe SSE, and a curated RAG evaluation set.
- **Owner:** P1 frontend, P2 API, P4 RAG/AI, P5 data/access, P8 QA.
- **Current status:** PARTIALLY IMPLEMENTED — chat, local guidance, PostgreSQL retrieval code, citation filtering, and mocked/local tests exist; live services and quality evaluation do not.
- **Dependencies:** P0 contracts, D-02 knowledge sources, D-03 provider privacy choice, P5 RLS verification.
- **Acceptance test:** Approved-question set yields grounded answers and valid citations; unsupported prompts abstain without citations; tenant/ownership tests prove retrieved context is authorized; stream disconnect/timeout tests pass.
- **Blocking decisions/services:** Approved content, provider terms/credentials, disposable PostgreSQL, MongoDB, OIDC and isolated LLM credentials.
- **Sequence:** After P0 contract decisions; use test corpus before production documents.

## P2 — Document lifecycle

- **Deliverables:** Secure PDF upload and status, approval/ownership state, duplicate handling, versioning, deactivation/replacement, admin list/detail, deletion propagation, retries and reconciliation.
- **Owner:** P2 API, P3 ingestion, P5 database/access, P1 admin UI, P8 tests.
- **Current status:** PARTIALLY IMPLEMENTED — scanner-gated ingestion, text extraction, Mongo jobs, PostgreSQL chunks, idempotency/recovery code and delete propagation exist; approval, versions, deactivation, and a full admin screen are absent.
- **Dependencies:** P0 source lifecycle contract; P5 stable document ID and ownership; P4 embedding version contract.
- **Acceptance test:** Upload a valid approved PDF; verify extracted/page metadata, status, searchable chunks, duplicate behavior, replacement/version, deactivation exclusion, and deletion in both stores; inject partial failures and prove recovery.
- **Blocking decisions/services:** D-02 approved-source owner; D-08 OCR scope; local MongoDB, PostgreSQL + pgvector, scanner and embedding endpoint.
- **Sequence:** Implement lifecycle schema and cross-store transitions before UI polish; verify against disposable local services.

## P3 — HR escalation

- **Deliverables:** Consent and minimal-contact form, persistent ticket/reference, safe retry/idempotency, HR-only queue/detail/status updates, audit events, and clear submission/failure responses.
- **Owner:** P6 escalation pair, P2 API, P5 data/access, P1 frontend, P8 tests.
- **Current status:** IMPLEMENTED NOT FULLY VERIFIED — consent-backed requester form/list/detail, Mongo ticket model, idempotent create, HR-scoped queue/detail/status/internal notes, and transactional audit code are present. Local generated-key HTTP tests pass; Mongo uses mocked transaction tests only. Browser sign-in and live identity/database integration are unavailable.
- **Dependencies:** D-01 browser authentication/anonymous policy; D-05 trusted HR claim mapping; D-06 destination, reviewers, SLA, and contact requirements; D-09 retention/privacy; disposable MongoDB replica set.
- **Acceptance test:** User consent creates one durable ticket/reference; retry does not duplicate; HR-authorized role can review/update; ordinary users cannot list/read/update another ticket; failures never show false success.
- **Blocking decisions/services:** Actual HR destination, delivery/acknowledgement process, named reviewers, SLA, minimal contact fields, consent and retention decisions; approved browser login and isolated MongoDB replica set.
- **Sequence:** Finish the remaining decisions and verify the existing workflow against isolated identity, database, and browser integration before staging review.

## P4 sequence — Meeting requests (SRS workstream P7)

- **Deliverables:** Meeting request form, durable request record, pending/rejected/confirmed lifecycle, HR review, time-zone/conflict handling, and optional approved calendar adapter.
- **Owner:** P7 scheduling, P2 API, P5 data, P1 frontend, P8 QA.
- **Current status:** PARTIALLY IMPLEMENTED — requester form/history, Mongo-backed service/schema/indexes, authenticated requester APIs, support-agent HR queue/decision APIs, pending-first transitions, idempotency, transactional audit source, and manual confirmation UI are implemented. Local generated-key route/unit tests pass; disposable Mongo integration is skipped.
- **Dependencies:** D-07 confirmation of queue-first workflow, authorized reviewer/tenant policy, D-09 retention, browser OIDC setup, and a disposable MongoDB replica set.
- **Acceptance evidence:** New requests return `pending`; only explicit HR confirmation with actual future schedule/timezone sets `confirmed`; rejection/cancellation and stale conflicts remain truthful and are audited. See `docs/MEETING_REQUEST_API.md` and `docs/PHASE_8_MEETING_REQUEST_REPORT.md`.
- **Blocking decisions/services:** Stakeholder approval of who may review/confirm/reject; real identity provider/session, replica-set Mongo, retention policy, and optional calendar provider approval/credentials.
- **Sequence:** Implemented internal workflow is ready for policy review and isolated integration verification. Any calendar adapter/provider is a separate future scope and remains absent/disabled until approved.

## P5 — Feedback and observability

- **Deliverables:** Helpful/not-helpful submission linked to a message, abuse controls, structured operational logs, request/RAG IDs, health checks, metrics, error reporting, retention/deletion and alert rules.
- **Owner:** P1 feedback UI, P2 API/observability, P5 data lifecycle, P8 operations/QA.
- **Current status:** PARTIALLY IMPLEMENTED — structured logs, local metrics/health probes, and rate-limit adapters exist; no feedback workflow or production sink/alerts/retention policy.
- **Dependencies:** P0 privacy and retention decisions; P2 API; production-like isolated logging/metrics services.
- **Acceptance test:** Feedback is associated to the correct message, tenant-scoped and reportable; failure does not expose content; log tests confirm secrets/prompts are absent; staging probes and alerts detect dependency failure.
- **Blocking decisions/services:** D-09 retention, data minimization policy, monitoring sink and alert ownership.
- **Sequence:** Define fields/retention before collecting feedback or enabling durable audit data.

## P6 — Security verification

- **Deliverables:** Apply migration 004 to a disposable PostgreSQL + pgvector instance; verify roles, key scope, signed context, RLS adversarial cases, pool cleanup, tenant isolation, auth/ownership, upload and prompt-injection controls.
- **Owner:** P5 database/access and P8 security/QA; P2/P3/P4 support.
- **Current status:** BLOCKED BY DEPENDENCY — source review and gated tests exist, but Docker/PostgreSQL tools/WSL were unavailable; the real suite skipped.
- **Dependencies:** P0 access model; isolated local PostgreSQL + pgvector, MongoDB, scanner, OIDC test issuer, local non-production signing key.
- **Acceptance test:** Real disposable DB runs migrations 002–004; SQL and application adversarial tests pass; reader/writer/migration roles and key access match policy; cross-tenant reads/writes fail; transaction reuse leaves no stale context.
- **Blocking decisions/services:** Docker Desktop or local PostgreSQL/pgvector, isolated service credentials. Never use production credentials or target.
- **Sequence:** Complete the documented [Windows local PostgreSQL setup](POSTGRES_RLS_LOCAL_SETUP_WINDOWS.md), then run `npm run test:integration:rls` and the local-service suite.

## P7 — Staging readiness

- **Deliverables:** Isolated MongoDB, PostgreSQL + pgvector, OIDC, scanner, Redis where global rate limits are required, approved LLM/embedding provider, Vercel Preview, integrated E2E and operational recovery evidence.
- **Owner:** P8 deployment/QA with P2/P3/P4/P5 and P6 workflow owners.
- **Current status:** BLOCKED BY DEPENDENCY — no verified staging services or Vercel project are available.
- **Dependencies:** P0 decisions; P1–P6 complete enough for integrated journeys; credentials explicitly designated as isolated staging.
- **Acceptance test:** Preview exercises `/api/models`, chat/SSE, health, uploads, all implemented workflows, role/tenant denial, backups/recovery, and alerts using non-production data; no skipped test is counted as passing.
- **Blocking decisions/services:** Staging credentials/services, Vercel access, approved provider/privacy terms and region.
- **Sequence:** Start only after relevant local tests pass; never point these checks at production.

## P8 — Production readiness review

- **Deliverables:** Evidence-based go/no-go review, approved SRS and decisions, complete traceability, security sign-off, operational ownership, SLOs, tested backups/restore, secret scopes, deployment/runtime/streaming checks, and rollback plan.
- **Owner:** P0 accountable lead and P8 QA/security/deployment; each workstream supplies evidence.
- **Current status:** NOT READY — local tests/build pass, but real RLS, staging, workflows and Vercel runtime remain unverified.
- **Dependencies:** P0–P7 acceptance evidence and explicit production approval.
- **Acceptance test:** Every critical/high acceptance criterion has repeatable passing evidence; no open critical security issue or unverified required integration remains; stakeholders approve release checklist.
- **Blocking decisions/services:** Stakeholder approvals, tested staging, real database roles/RLS, provider/identity/scanner and hosting evidence.
- **Sequence:** Review only after staging acceptance. This roadmap does not authorize production migration or deployment.

## Current engineering order

1. Obtain stakeholder review of the SRS and confirm D-01–D-10 without changing the stated architecture.
2. Define stable API and data contracts for document lifecycle, escalation, meetings and feedback.
3. Complete disposable PostgreSQL + pgvector/RLS verification while building local end-to-end test infrastructure.
4. Implement approved document lifecycle and complete chat/RAG evaluation.
5. Complete isolated integration/policy review for the implemented HR escalation and meeting workflows; then implement remaining feedback according to confirmed decisions.
6. Run isolated staging integration, operational recovery, and Vercel Preview verification.
7. Conduct a separate production readiness review; do not deploy until explicitly approved.
