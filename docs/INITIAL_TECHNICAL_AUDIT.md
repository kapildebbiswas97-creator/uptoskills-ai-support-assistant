# Technical Audit and Phase 4 Status

Audit date: 2026-11-15. The engineering work continued in the existing modified checkout at the supplied baseline commit `dd1a66a`; it did not create a new project. This file supersedes the stale initial-gap summary that previously described MongoDB/auth/retrieval as absent.

## Repository and runtime

- Repository root: `work/source-archive` in the `complete-the-uptoskills-ai-support-assistant` checkout.
- Frontend: React + TypeScript + Vite. API: Express in `server/app.ts`; local entrypoint `server/index.ts`; Vercel catch-all `api/[...path].ts`.
- `vercel.json` targets `api/[...path].ts`, configures a 60-second max function duration, and includes `knowledge.yaml` plus `docs/**`.
- The Vercel code path initializes PDF/local knowledge, rate limiting, PostgreSQL retrieval, document service, and database health checks. The Vite production build does not validate Vercel bundling or deployment settings.
- No deploy, production migration, or secret modification was performed.

## Acceptance status

| Area | Status | Evidence / remaining limit |
|---|---|---|
| Continue existing changes | PASS | Work is on top of supplied `dd1a66a`; no implementation was restarted. |
| Local unit and HTTP suite | PASS | `npm test`: 100 passed, 0 failed; loopback route, staging anonymous-chat denial, buffered SSE, cancellation, and database fault-injection tests ran. |
| Lint and client build | PASS | `npm run lint`; `npm run build`; `git diff --check`. |
| Authentication and authorization | PARTIAL | OIDC JWT/JWKS verification includes `nbf`, signature/issuer/audience checks and explicit role claim mapping; local negative tests pass. No live issuer or DB-backed authorization integration. |
| Cross-database durability/reconciliation | PARTIAL | MongoDB operational state, deterministic/idempotent jobs, transactional vectors, cleanup/retry/orphan/missing-vector reconciliation and health probes implemented. Fake-adapter failure injection passes; live DB/failure-injection and concurrent DB behavior need staging tests. |
| RAG retrieval and citations | PARTIAL | PostgreSQL hybrid vector/full-text retrieval, reciprocal-rank fusion, lexical reranking/deduplication, source metadata, embedding model/version checks, and citation filtering implemented and unit-tested. Claim entailment, semantic reranking, and full live retrieval remain unverified. |
| RAG security | PARTIAL | Output is buffered before SSE delivery, pattern-screened for secrets/internal prompt leaks, and ungrounded URLs/citations are removed. Authorization surrounds retrieval. Screening is heuristic and no comprehensive adversarial suite or claim entailment is provided. Staging/Preview now blocks anonymous chat before provider and retrieval calls by default; local route test passes. |
| Document processing | PARTIAL | Scanner adapter fails closed when unconfigured; DOCX archive limits and bounded PDF/DOCX/HTML parser workers exist. Scanner is not configured/live-tested and worker threads are not OS sandboxes. |
| Observability | PARTIAL | Structured event logs, request/trace/RAG IDs, injectable metrics sink, latency events, DB health probes and Redis fallback warnings exist. No production metrics adapter/alerts/central sink or live telemetry. |
| API/SSE routes | PASS (local) | `/api/models`, `/api/chat`, `/api/chat/stream`, buffered review, timeout and trace ID behavior covered with loopback tests. Actual provider calls, proxy buffering, browser disconnect, and Vercel runtime behavior are unverified. |
| Staging environment validation | BLOCKED (prerequisites missing) | `npm run env:validate:staging` exits 1 and lists missing MongoDB, OIDC, PostgreSQL, role mapping, scanner, Gemini embedding, and AI provider variables. It does not attempt connectivity. |
| Production readiness | BLOCKED | Vercel project root/settings, provider and OIDC config, live databases, Redis, logs, backups and staging behavior are unavailable. Do not deploy based only on local checks. |

## Integration procedure

In an isolated staging environment only, configure test OIDC issuer/audience/JWKS claims, MongoDB Atlas and PostgreSQL with pgvector/RLS and least-privilege reader/writer/migration accounts, Redis if desired, embedding/provider keys, and an HTTPS scanner implementing the documented scan contract. Run `npm run env:validate:staging`. Apply migrations only to disposable/staging data after review. Run auth/tenant/ownership and RLS tests against service-backed fixtures, kill processes during Mongo job creation/vector commit/deletion and run reconciliation, verify health and query provenance, then exercise buffered SSE via the deployed staging proxy with disconnect/timeouts. Record provider/network behavior and restore from a backup. Production migration/deployment is a separate approved operation.

The detailed commands and exact local results are in `TEST_REPORT.md`; limitations and open vulnerabilities are in `SECURITY_AUDIT.md`.

## Phase 5 staging verdict

**STAGING BLOCKED.** No explicitly identified isolated staging endpoints or credentials were available; only local checks ran. The local full test suite passed 100/100 after loopback access was granted for the existing HTTP tests. Local lint/build/diff checks pass. Anonymous access now defaults off for staging and Vercel Preview. Vercel's payload ceiling required reducing base64 JSON uploads to 3 MiB. No real database migration, OIDC, scanner, Redis, provider, or Vercel integration was attempted. See `PHASE_5_STAGING_REPORT.md` for the evidence and prerequisites.
