# Environment Variables and Staging Setup

## Phase 9.1 Vercel release readiness snapshot (2026-11-15)

The latest source reads these Vercel-relevant variable names. No values were retrieved. The Vercel CLI/project binding was unavailable in the local checkout, so the project's current variable names could not be re-listed. The supplied prior Production listing named `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, and `NVIDIA_API_KEY`, and reported no MongoDB, PostgreSQL, or OIDC variables; treat this as a prior snapshot, not a reverified current state.

| Variable name | Purpose / affected workflow | Required target | Vercel status evidence |
|---|---|---|---|
| `MONGODB_URI`, `MONGODB_DATABASE` | Operational source of truth for conversations, documents, escalation, meetings and audit; requires Atlas TLS and replica-set/sharded transaction support for atomic audit. | Preview and Production | Prior Vercel listing reported these absent; current listing not rechecked. |
| `DATABASE_URL` | PostgreSQL reader for authorized retrieval/RAG. | Preview and Production | Prior listing reported PostgreSQL configuration absent; current listing not rechecked. |
| `DATABASE_INGEST_URL` | PostgreSQL writer for document chunks/embeddings. | Preview and Production | Prior listing reported PostgreSQL configuration absent; current listing not rechecked. |
| `RLS_CONTEXT_KEY_ID`, `RLS_CONTEXT_HMAC_KEY` | Signed tenant context used by migration 004; key ID plus 32 random bytes encoded as base64url. | Preview and Production when PostgreSQL runtime is enabled | Not listed in the supplied snapshot; current listing not rechecked. |
| `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_ROLE_MAPPING` | OIDC token validation and trusted application-role mapping. | Preview and Production for authenticated user and HR flows | Prior listing reported OIDC configuration absent; current listing not rechecked. |
| `AUTH_JWKS_URL` | Optional explicit JWKS URL; otherwise derived from issuer. | Preview/Production only if issuer discovery is unsuitable | Not listed in supplied snapshot; optional. |
| `AUTH_ROLES_CLAIM`, `AUTH_TENANT_CLAIM` | Optional signed role and tenant claim names; defaults are `roles` and `org_id`. | As dictated by the selected OIDC issuer | Not listed in supplied snapshot; optional overrides. |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini embedding calls; `GEMINI_API_KEY` also supports Gemini chat. | Preview and Production for current vector ingestion/retrieval | `GEMINI_API_KEY` was listed in the prior snapshot; values and validity were not checked. |
| `AI_PROVIDER` and selected provider key (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `NVIDIA_API_KEY`, etc.) | Chat provider/model selection and responses. | Preview and Production for live AI chat | Several provider key names were listed previously; selected provider/config and value validity not verified. |
| `MALWARE_SCANNER_URL`, `MALWARE_SCANNER_TOKEN` | Fail-closed document malware scanning. | Preview and Production before document ingestion is enabled | Not listed in supplied snapshot; current listing not rechecked. |
| `REDIS_URL` | Shared distributed rate limiting; optional process-memory fallback does not coordinate serverless instances. | Recommended Preview/Production | Not listed in supplied snapshot; current listing not rechecked. |
| `DATABASE_MIGRATION_URL` | Separate operator-only schema migration identity; not used by request handlers. | Do not place in deployed function scope unless an approved workflow requires it | Not listed in supplied snapshot. |

Additional optional controls include `AI_MODEL`, `GEMINI_MODEL`, `GEMINI_EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_VERSION`, `CHAT_TIMEOUT_MS`, `DOCUMENT_PARSE_TIMEOUT_MS`, `APP_ENV`, `ALLOW_ANONYMOUS_CHAT`, and `ANONYMOUS_CHAT_APPROVED`. Do not set anonymous chat true in production; production API chat remains authenticated.

No browser OIDC client/callback/session flow is present in the current React app, so adding the backend OIDC variables alone does not complete browser sign-in. No new database, scanner, browser-auth, or calendar secrets should be pasted into chat; enter approved values directly in the Vercel dashboard/secret manager.

Use only isolated staging credentials and endpoints. `.env.example` contains names and blank values; it does not contain real credentials. The validation commands report missing/invalid variable names without echoing secret values:

```powershell
npm run env:validate
npm run env:validate:staging
```

The staging validator requires MongoDB, OIDC, PostgreSQL reader/writer URLs, an embedding provider key, a chat provider key, explicit trusted role mapping, and a malware scanner. Redis remains optional and its process-local fallback is not globally consistent.

At runtime, `APP_ENV=staging`, `NODE_ENV=staging`, or Vercel's `VERCEL_ENV=preview` makes the model catalog and chat endpoints require a verified principal by default. `ALLOW_ANONYMOUS_CHAT` is optional and accepts only `true` or `false`; staging validation accepts `true` only when `ANONYMOUS_CHAT_APPROVED=true` is also set. No such product approval is configured for this verification. Non-staging defaults remain unchanged.

## Supabase Authentication Configuration

### 1. Browser (Public) Environment Variables

These variables are built into the client bundle and are visible to users. Never place service-role keys, database passwords, or OAuth client secrets in these variables.

- `VITE_SUPABASE_URL`: The project URL found in the Supabase Dashboard (`https://<project-ref>.supabase.co`).
- `VITE_SUPABASE_PUBLISHABLE_KEY`: The public API key (anon key or publishable key) intended for browser client use.

### 2. Server-Side Environment Variables (Protected & Server-Only)

These variables are consumed by the Express backend and Vercel Serverless Functions. They are never delivered to the client.

- `SUPABASE_URL`: The project URL (`https://<project-ref>.supabase.co`). When set, automatically derives:
  - `AUTH_ISSUER`: `https://<project-ref>.supabase.co/auth/v1`
  - `AUTH_AUDIENCE`: `authenticated`
  - `AUTH_JWKS_URL`: `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`
- `AUTH_ISSUER`: Explicit issuer override if custom auth domain is used.
- `AUTH_AUDIENCE`: Explicit audience override (default `authenticated`).
- `AUTH_JWKS_URL`: Explicit JWKS endpoint override.
- `AUTH_ROLES_CLAIM`: Name of the signed claim containing assigned application roles (default `roles`).
- `AUTH_TENANT_CLAIM`: Name of the signed claim containing trusted tenant ID (default `org_id`).
- `AUTH_ROLE_MAPPING`: JSON mapping from identity-provider role strings to application roles (`super_admin`, `admin`, `support_agent`, `knowledge_manager`, `user`).
- `REQUIRE_VERIFIED_EMAIL`: When `true`, rejects JWTs without confirmed email (`email_confirmed_at`). Default `true` when Supabase is configured.

### 3. Supabase Dashboard Setup Checklist

1. **Authentication Settings**:
   - Under **Authentication -> URL Configuration**:
     - Set **Site URL** to your canonical site or preview URL (e.g. `https://<preview-domain>.vercel.app`).
     - Under **Redirect URLs**, add:
       - `https://<preview-domain>.vercel.app/**`
       - `https://<production-domain>.com/**`
       - `http://localhost:3000/**` (for local development)
   - Under **Authentication -> Email**:
     - Keep **Confirm email** enabled.
     - Configure password reset redirect path to point to `/` or the application root.

2. **Google Provider Setup**:
   - In Google Cloud Console:
     - Create a Web Application OAuth 2.0 Client ID.
     - Add authorized JavaScript origins:
       - `https://<project-ref>.supabase.co`
       - `https://<preview-domain>.vercel.app`
     - Add authorized redirect URI (from Supabase Dashboard):
       - `https://<project-ref>.supabase.co/auth/v1/callback`
   - In Supabase Dashboard:
     - Navigate to **Authentication -> Providers -> Google**.
     - Enable Google.
     - Enter Client ID and Client Secret from Google Cloud Console.

3. **Custom Access Token Hook**:
   - Run migration `infra/postgres/migrations/005-supabase-auth-roles-and-hook.sql`.
   - In Supabase Dashboard -> **Authentication -> Hooks**:
     - Under **Custom Access Token Hook**, select `public.custom_access_token_hook`.
     - Save. This ensures all minted JWTs contain server-controlled `roles` and `org_id` from `public.user_roles`, ignoring untrusted client metadata.

4. **Role Provisioning Procedure**:
   - By default, all new sign-ups are assigned the least-privileged `user` role via the `on_auth_user_created` trigger.
   - To elevate an existing verified user to `support_agent` or `admin`, an authorized administrator executes:
     ```sql
     SELECT public.assign_user_role('target-user-uuid'::uuid, 'support_agent');
     ```
   - Generic administrators do not receive implicit HR privileges; only explicit `support_agent` assignment grants access to HR escalation and meeting queues.

## OIDC contract

- `AUTH_ISSUER`: exact issuer URL expected in the signed `iss` claim; HTTPS outside local development.
- `AUTH_AUDIENCE`: exact API audience expected in the signed `aud` claim.
- `AUTH_JWKS_URL`: optional explicit HTTPS JWKS endpoint; otherwise `/.well-known/jwks.json` is derived from the issuer.
- `AUTH_ROLES_CLAIM`: signed claim containing an array of identity-provider role/group names (default `roles`).
- `AUTH_TENANT_CLAIM`: signed tenant claim (default `org_id`). Client-supplied roles/tenant IDs are ignored.
- `AUTH_ROLE_MAPPING`: JSON object mapping exact provider role names to one of `super_admin`, `admin`, `support_agent`, `knowledge_manager`, or `user`. Example shape: `{"group:admins":"admin","group:km":"knowledge_manager"}`. Do not map broad or user-controlled groups to privileged roles.

The verifier accepts RS256 or ES256 only, checks signature, exact issuer/audience, `exp`, `nbf` when present, required `sub`/`iat`, and a maximum token age of 12 hours. `jose` remote JWKS handles bounded retrieval/cache behavior and refresh on unknown key IDs. Local tests use generated keys; provider key rotation and claim mapping must be validated against the actual staging issuer.

## Staging service variables

- `MONGODB_URI`, `MONGODB_DATABASE` — isolated Atlas staging cluster/database; use TLS and a least-privilege application account.
- `DATABASE_URL` — PostgreSQL login must be exactly `uts_assistant_reader`, used for read-only retrieval.
- `DATABASE_INGEST_URL` — PostgreSQL login must be exactly `uts_assistant_writer`, restricted to chunk operations.
- `DATABASE_MIGRATION_URL` — optional separate operator account; never required by request handlers and keep out of the deployed app environment where possible.
- `RLS_CONTEXT_KEY_ID` — non-secret key identifier (1–40 letters/digits/underscore/hyphen) used by the signed PostgreSQL RLS context.
- `RLS_CONTEXT_HMAC_KEY` — 32 random bytes encoded as canonical base64url. The app signs tenant/privilege context; an operator provisions the identical bytes in PostgreSQL's private key table. This key is required whenever runtime PostgreSQL access is configured and is never logged or committed.
- `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_VERSION` — schema currently requires 768 dimensions.
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) — embedding provider.
- `AI_PROVIDER`, `AI_MODEL` and one server-side provider key such as `OPENROUTER_API_KEY` — model provider.
- `MALWARE_SCANNER_URL`, `MALWARE_SCANNER_TOKEN` — scanner endpoint/token. The service expects an HTTPS POST of raw file bytes with a JSON response whose `status` is `clean` or `infected`; any timeout, error, malformed response, or missing scanner blocks ingestion. Scanner integration is not live-tested here.
- `DOCUMENT_PARSE_TIMEOUT_MS` — parser worker limit, clamped to 1–30 seconds; worker V8 heap is capped at 128 MiB (young generation 32 MiB).
- `REDIS_URL` — optional shared Redis rate limiting. Startup/operation failure falls back to per-process memory and emits a warning; this does not give global limits.
- `ALLOW_ANONYMOUS_CHAT` and `ANONYMOUS_CHAT_APPROVED` — optional explicit anonymous-chat policy controls. Keep unset/false in staging; only configure both as `true` after a product decision.
- `APP_ENV` — application environment label; use `staging` for a non-Vercel staging runtime. Vercel Preview deployments are detected through its built-in `VERCEL_ENV=preview` value.

The JSON body parser is capped at 4.2 MiB, and document and chat-PDF raw files are capped at 3 MiB. Base64 encoding increases payload size; this leaves headroom below Vercel's documented 4.5 MB function request/response payload limit. Larger uploads require a separately approved upload/storage design.

## PostgreSQL signed RLS key

Migration `004-signed-tenant-rls.sql` replaces the older caller-settable GUC-only policy. Runtime reader/writer roles can set PostgreSQL custom settings but cannot forge the signature without the HMAC key. Keep the application secret and DB key row synchronized; contexts expire after five minutes. The application host remains trusted, and migration/superuser/BYPASSRLS roles are outside the RLS boundary. Do not enable runtime PostgreSQL access until migration 004 and the matching key are verified in the target database.

For local integration only, the helper `npm run db:postgres:provision-local-rls-key` refuses non-loopback PostgreSQL URLs and database names not ending in `_integration`. It requires `APP_ENV=local-integration`, a migrated disposable DB, an operator `DATABASE_MIGRATION_URL`, a matching reader `DATABASE_URL`, and the two RLS key variables. Staging provisioning must use the approved secret manager and a separate operator workflow; never reuse local or production keys across environments.

## Secret handling

Never put actual values into docs, commits, logs, client environment variables, or support prompts. Configure values in a staging secret manager. Do not copy production credentials or point tests at production databases. `npm run env:validate:staging` checks shape and required names, not credentials, network reachability, permissions, or service health.
