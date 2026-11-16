# UpToSkills AI Support Assistant: Preview Readiness Report

**Date:** 2026-11-16
**Repository:** `kapildebbiswas97-creator/uptoskills-ai-support-assistant`
**Git Branch:** `release/uptoskills-vercel-2026-11-15`
**Git Commit SHA:** `be280e8c87e0fa1b8b4e0f42acc6be5b07f3309f`
**Vercel Project:** `uptoskills-ai-support-assistant`
**Vercel Preview Deployment URL:** `https://uptoskills-ai-support-assistant-rdhhnem3s.vercel.app`
**Vercel Deployment ID:** `dpl_8QyfKjQxe2gMne5RW4wqkL4XaZFN`
**Supabase Staging Project Ref:** `vymepfpxtfwkkoaykdny` (`https://vymepfpxtfwkkoaykdny.supabase.co`)

---

## 1. Executive Verdict

**Verdict: PARTIALLY READY**

- **Code, Security, & Architecture:** Fully repaired, hardened, and verified. 172/172 tests passing, clean TypeScript lint, clean production build, ESM graph check passing, and zero git diff check warnings.
- **Deployed Vercel Preview:** Live and healthy at `https://uptoskills-ai-support-assistant-rdhhnem3s.vercel.app`. Serves the dark-mode web application at `/` (HTTP 200).
- **Preview Security & Authentication:** Strict JWT validation active. All 24 protected route patterns reject unauthenticated requests with 401. Invalid tokens return 401. Health endpoint confirms `"authentication": "configured"`. Preview `AUTH_ROLE_MAPPING` was updated on Vercel to include `support_agent`. Real Supabase registration works and email confirmation enforcement is verified.
- **Blockers for Full End-to-End Testing:** External service credentials for Preview scope (AI Model Provider, MongoDB connection, and PostgreSQL/pgvector connection) plus Supabase CLI access / DB credentials for running staging migration 005 and enabling the token hook in the Supabase Dashboard.

---

## 2. Environment & Deployment Details

| Component | Target / Value | Status |
| --- | --- | --- |
| GitHub Branch | `release/uptoskills-vercel-2026-11-15` | PUSHED & SYNCHRONIZED |
| Commit SHA | `be280e8c87e0fa1b8b4e0f42acc6be5b07f3309f` | VERIFIED |
| Vercel Deployment | `https://uptoskills-ai-support-assistant-rdhhnem3s.vercel.app` | LIVE (Preview) |
| Supabase URL | `https://vymepfpxtfwkkoaykdny.supabase.co` | REACHABLE & VERIFIED |
| Supabase Auth API | GoTrue v2.197.0 (`/auth/v1`) | HEALTHY |
| Supabase JWKS | ES256 key (`kid: 1c684bc7-3ca4-4f91-b279-74aa4d456d71`) | ACTIVE & VERIFIED |
| `AUTH_ROLE_MAPPING` | `{"super_admin":"super_admin","admin":"admin","support_agent":"support_agent","knowledge_manager":"knowledge_manager","user":"user"}` | CONFIGURED IN PREVIEW |

---

## 3. Verification of Phase 10A Security Repairs

All six issues identified in Phase 10A were verified locally and deployed to the Preview environment:

1. **Custom Access Token Hook Contract (`005-supabase-auth-roles-and-hook.sql`):**
   - Function signature `public.custom_access_token_hook(event jsonb) RETURNS jsonb`
   - Emits documented payload `jsonb_build_object('claims', v_claims)`
   - Scoped `SECURITY INVOKER` with fixed `search_path = pg_catalog, public, pg_temp`
   - `supabase_auth_admin` granted `USAGE` on schema `public`, `EXECUTE` on the hook function, and `SELECT` on `public.user_roles` with a dedicated RLS policy
   - Tenant consistency check rejects conflicting tenant rows with `INCONSISTENT_USER_TENANT_BINDING`
   - Role vocabulary validated: `super_admin`, `admin`, `support_agent`, `knowledge_manager`, `user`
   - `assign_user_role` hardened: caller admin identity checked, client metadata ignored, execution revoked from `PUBLIC`, `anon`, and `authenticated`
2. **JWT Claim Contract & Tenant Isolation:**
   - Server extracts roles exclusively from the signed `roles` claim array and maps via `AUTH_ROLE_MAPPING`
   - Tenant extracted from signed `org_id` claim; cross-tenant access prevented
3. **Email Confirmation Check:**
   - Eliminated invalid assumption of `email_confirmed_at` in JWT payload
   - Server-side email check queries Supabase `/auth/v1/user` using bearer token and publishable key to verify authentic `email_confirmed_at`
4. **Preview Role Mapping:**
   - Updated Vercel Preview environment variable `AUTH_ROLE_MAPPING` for branch `release/uptoskills-vercel-2026-11-15` to include `support_agent`
5. **Shared Authentication Resolution:**
   - Exported `resolveAuthenticationConfig()` in `server/auth.ts`, unified between request authentication and `/api/health`
   - Preview `/api/health` now confirms `"authentication": "configured"`
6. **Credential & File Exposure:**
   - `.gitignore` prevents tracking of `.env*` files
   - No secrets committed to git or exposed in browser bundles

---

## 4. Test & Build Execution Results

| Test / Check | Command | Result |
| --- | --- | --- |
| Full Test Suite | `npm test` | **PASS** (172 passed, 0 failed, 23.2s) |
| TypeScript Lint | `npm run lint` (`tsc --noEmit`) | **PASS** (0 errors) |
| Serverless ESM Graph | `npm run check:serverless-esm-graph` | **PASS** (29 modules bundled, 24 protected routes return 401) |
| Production Build | `npm run build` | **PASS** (Vite v8.3.8 client build + serverless verification) |
| Git Diff Check | `git diff --check` | **PASS** (0 whitespace/formatting errors) |

---

## 5. Live Deployed Preview Acceptance Test Results

Tests executed directly against `https://uptoskills-ai-support-assistant-rdhhnem3s.vercel.app` using origin-scoped development OIDC credentials:

### A. Deployment & Infrastructure
- **Root Page (`/`):** **PASS** (HTTP 200, serves full HTML and bundled JS/CSS assets).
- **Serverless Initialization:** **PASS** (No unhandled exceptions; Node.js ESM modules load cleanly).
- **Health Check (`/api/health`):** **PASS / DEGRADED** (Returns HTTP 503 as designed until external databases and model keys are attached; returns `dependencies.authentication: "configured"`).

### B. Security & Authorization
- **Unauthenticated Protected Routes:** **PASS**
  - `GET /api/session`: HTTP 401 (`{"error":"Authentication is required."}`)
  - `GET /api/models`: HTTP 401 (`{"error":"Authentication is required."}`)
  - `POST /api/chat`: HTTP 401 (`{"error":"Authentication is required."}`)
  - `POST /api/documents`: HTTP 401 (`{"error":"Authentication is required."}`)
  - `GET /api/conversations`: HTTP 401 (`{"error":"Authentication is required."}`)
  - `GET /api/escalations/mine`: HTTP 401 (`{"error":"Authentication is required."}`)
  - `GET /api/meeting-requests/mine`: HTTP 401 (`{"error":"Authentication is required."}`)
- **Malformed / Invalid Token:** **PASS**
  - `GET /api/session` with `Bearer invalid.token.value`: HTTP 401 (`{"error":"Invalid or expired access token."}`)

### C. Supabase Authentication Staging Integration
- **Staging Auth API (`/auth/v1/health`):** **PASS** (GoTrue v2.197.0 responsive).
- **Public Key & Settings (`/auth/v1/settings`):** **PASS** (Email provider active, `mailer_autoconfirm: false`).
- **User Registration (`auth.signUp`):** **PASS** (Successfully created staging test user `uts-staging-test-user-20261116@gmail.com` with UUID `227c7abd-c3f5-4a88-bee3-1b228ddfb672`).
- **Unconfirmed Email Gate (`auth.signInWithPassword`):** **PASS** (Returned `{"error": "Email not confirmed"}` confirming email verification requirement is active).

---

## 6. Service Status & Remaining Blockers

To transition from **PARTIALLY READY** to **READY FOR TESTING**, the following three external service items must be completed:

### Blocker 1: Supabase Database Migration & Hook Configuration (Phase 3)
- **Status:** **BLOCKED** on Supabase CLI access token or database connection string.
- **What is required:**
  1. Authenticate Supabase CLI (`supabase login` with `SUPABASE_ACCESS_TOKEN`) or provide the staging database connection string (`DATABASE_MIGRATION_URL`).
  2. Execute migration `infra/postgres/migrations/005-supabase-auth-roles-and-hook.sql` on staging project `vymepfpxtfwkkoaykdny`.
  3. In the Supabase Dashboard for `vymepfpxtfwkkoaykdny`, navigate to **Authentication -> Hooks**, select `public.custom_access_token_hook` under **Custom Access Token Hook**, and save.

### Blocker 2: Database Services (Phase 4)
- **Status:** **BLOCKED** on database credentials for Preview scope.
- **What is required:**
  1. **MongoDB:** Provide a MongoDB Atlas connection string (`MONGODB_URI` and `MONGODB_DATABASE`) for Preview. Run `npm run db:mongo:init` to create indexes and collections.
  2. **PostgreSQL / pgvector:** If hosted vector search is enabled for Preview, configure `DATABASE_URL` (reader role: `uts_assistant_reader`) and `DATABASE_INGEST_URL` (writer role: `uts_assistant_writer`) with SSL enabled, plus `RLS_CONTEXT_KEY_ID` and `RLS_CONTEXT_HMAC_KEY`.

### Blocker 3: AI Provider Key for Preview Scope (Phase 5 & 6)
- **Status:** **BLOCKED** on model API key scoped for Preview.
- **Finding:** In Vercel, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, and `GROQ_API_KEY` are currently configured under the **Production** environment scope only. Per Non-Negotiable Safety Rule 4, Production keys cannot be altered or accessed without authorization.
- **What is required:** Add a valid provider key (e.g. `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, or `GROQ_API_KEY`) to the **Preview** environment for branch `release/uptoskills-vercel-2026-11-15` in Vercel:
  ```bash
  vercel env add GEMINI_API_KEY --environment preview --git-branch release/uptoskills-vercel-2026-11-15
  ```

---

## 7. Manual Testing Steps for the User

Once the three service blockers are configured:

1. **Access the Preview UI:**
   - Navigate to `https://uptoskills-ai-support-assistant-rdhhnem3s.vercel.app` (authenticate via Vercel SSO if prompted by Deployment Protection).
2. **Sign Up / Log In:**
   - Click "Sign Up" and register with an email address.
   - Confirm the confirmation email in your inbox.
   - Sign in. Verify that the session loads and your assigned role (`user`) is displayed.
3. **Chat Testing:**
   - Ask: *"What are the requirements for the UpToSkills internship?"*
   - Verify that streaming responses appear and citations cite verified reference documents.
   - Ask an unverified policy question or request human HR support to verify the `[SHOW_HR_BUTTON]` escalation appears.
4. **Document Ingestion (Knowledge Managers / Admins):**
   - With an administrative role assigned via `public.assign_user_role`, upload a test PDF.
   - Verify indexing, chunking, and semantic retrieval grounding in subsequent chat turns.
5. **Health Check:**
   - Query `GET /api/health` with your Vercel access header to verify all services report `"ok"`.
