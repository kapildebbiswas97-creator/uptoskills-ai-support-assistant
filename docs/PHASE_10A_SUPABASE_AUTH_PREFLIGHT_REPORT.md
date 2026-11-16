# Phase 10A — Supabase Authentication Security Preflight

**Date:** 2026-11-16
**Repository:** `kapildebbas97-creator/uptoskills-ai-support-assistant`
**Expected branch / commit:** `release/uptoskills-vercel-2026-11-15` / `5e4226ac363aef9107b167a21799d631096000a4`
**Supabase target:** staging project `uptoskills-staging` (`vymepfpxtfwkkoaykdny`)
**Scope:** local source audit and local repairs only. No SQL was run against Supabase; no remote settings, deployments, or Git remotes were changed.

## Status summary

| Area | Status | Finding |
| --- | --- | --- |
| Repository identity | PASS | Git root, branch, and commit match the requested values. The branch was clean and 9 commits ahead of its configured remote before these repairs. |
| Migration 005 and hook | FIXED | Corrected the hook response, grants, RLS access, tenant consistency check, and role-assignment exposure locally. No live database execution was performed. |
| JWT claim contract | FIXED | The backend and hook use the signed `roles` array and `org_id` tenant claim. `knowledge_manager` is supported in both SQL and application routes. |
| Email confirmation | FIXED | Removed the incorrect assumption that `email_confirmed_at` is a Supabase JWT claim. Supabase-backed requests now confirm the user through `/auth/v1/user`. |
| Preview role mapping | FIXED LOCALLY | The sample mapping now includes `support_agent`; the exact corrected value is shown below. The remote Vercel variable was not read or changed. |
| Health configuration | FIXED | Health and JWT verification use one resolved authentication configuration, including derived Supabase settings and required role mapping. |
| `.env` / deployment exposure | PASS LOCALLY; NOT TESTED REMOTELY | Local ignore/tracking and build artifacts show no `src/.env`; the historical Preview manifest mentioned in the request was not available locally for independent verification. |
| Staging migrations and dashboard state | NOT TESTED | Ordered plan is below. No migration or Supabase dashboard change was made. |
| Local verification | PASS | 172 tests, lint, build, and the build's ESM graph check passed. See exact results below. |

## 1. Repository and commit verification

- Git root: `C:\Users\SAMSUNG USER\Documents\Codex\2026-11-14\complete-the-uptoskills-ai-support-assistant\work\source-archive`
- Branch: `release/uptoskills-vercel-2026-11-15`
- HEAD: `5e4226ac363aef9107b167a21799d631096000a4`
- Initial status: clean; branch ahead of `origin/release/uptoskills-vercel-2026-11-15` by 9 commits.
- No reset, cleanup, remote operation, or commit was performed. Changes listed in Section 9 are uncommitted local edits.

## 2. Migration 005 and Supabase hook audit

### Table and constraints

`public.user_roles` contains `id`, `user_id`, `role`, `tenant_id`, `assigned_by`, `created_at`, and `updated_at`. `role` is constrained to `super_admin`, `admin`, `support_agent`, `knowledge_manager`, or `user`; `(user_id, role)` is unique. The Phase 10 report already names `assigned_by`, `created_at`, and `updated_at` correctly.

RLS is both enabled and forced. Authenticated users retain only a SELECT policy for their own rows; no client insert/update/delete policy exists. The table revokes broad access from `PUBLIC` and `anon`, while `authenticated` gets SELECT only. The local migration repair adds a SELECT grant and narrow-to-the-hook policy for `supabase_auth_admin`, as required for the invoker hook to read the forced-RLS table.

### Hook contract and access

- The function has the required `public.custom_access_token_hook(event jsonb) RETURNS jsonb` signature.
- It preserves the incoming claims, overwrites only server-controlled `roles`, and writes/removes `org_id` based on `user_roles`. It does not read `user_metadata`.
- It returns `jsonb_build_object('claims', v_claims)`, matching the documented hook response shape.
- The hook is `SECURITY INVOKER`, with a fixed `pg_catalog, public, pg_temp` search path. Supabase recommends explicit permissions and RLS over a broadly privileged definer hook.
- `supabase_auth_admin` receives `USAGE` on `public`, `EXECUTE` on the hook, and `SELECT` on `user_roles`, with a role-specific RLS policy. This internal role's policy permits SELECT; the hook query itself filters by the UUID from `event.user_id`. Conflicting tenant bindings fail token issuance rather than selecting an arbitrary tenant. Supabase documents the hook role, schema/function grants, response contract, and RLS requirement in its [Auth Hooks guide](https://supabase.com/docs/guides/auth/auth-hooks).
- Hook execution is revoked from `PUBLIC`, `anon`, and `authenticated`; there is no service-role hook grant. The internal Auth role is the only added execution grantee.
- The signup trigger inserts the literal least-privilege `user` role with `ON CONFLICT DO NOTHING`. It never reads client metadata. Its `SECURITY DEFINER` is retained only for the trigger's write under forced RLS, and its search path is hardened.
- `assign_user_role` uses a fixed search path, validates the role vocabulary, rejects a missing authenticated user identity, and is no longer executable by ordinary authenticated users. It remains available to `service_role` and trusted database operators; its definer privilege is needed for the controlled write and Auth-user existence check.

The actual Supabase role membership, grants, policies, function owner, Auth hook selection, and successful execution remain **NOT TESTED** until an approved staging migration and dashboard review.

## 3. JWT claim contract and roles

The hook emits:

```json
{
  "roles": ["user"],
  "org_id": "<server-assigned tenant, when present>"
}
```

The backend reads the configured `roles` array, maps each exact string through `AUTH_ROLE_MAPPING`, and reads the tenant from `org_id` by default. It does not authorize from the standard Supabase Postgres `role: "authenticated"` claim or from `user_metadata`. Missing, empty, malformed, or unmapped role claims fail closed. `admin` and `super_admin` only arrive from trusted `user_roles` assignments and cannot be sourced from client metadata.

The application uses `support_agent` for HR escalation and meeting routes, and uses `knowledge_manager` in its document authorization code. Both are deliberately supported in the table constraint, application role type, and mapping. New users receive `user` only.

Corrected mapping for the current hook claim vocabulary:

```text
{"super_admin":"super_admin","admin":"admin","support_agent":"support_agent","knowledge_manager":"knowledge_manager","user":"user"}
```

Only use the `support_agent` entry when the hook assigns that role following the approved HR provisioning process. The remote Vercel `AUTH_ROLE_MAPPING` value remains unchanged pending staging review.

## 4. Email confirmation and JWT verification

The old verifier checked for `email_confirmed_at` in the signed token, and the old tests minted that field themselves. Supabase's [access-token claim reference](https://supabase.com/docs/guides/auth/jwt-fields) does not list `email_confirmed_at` among the standard claims, while its [user reference](https://supabase.com/docs/guides/auth/users) documents it on the Auth user object. Treating the nonstandard token field as proof was therefore invalid.

The local repair now verifies the JWT signature, issuer, audience, required claims, expiry, not-before, and maximum token age as before, then queries the trusted Supabase `/auth/v1/user` endpoint with the same bearer token and public API key. Supabase describes `getUser()` as an Auth-server network request whose result is authentic and suitable for authorization ([reference](https://supabase.com/docs/reference/javascript/auth-getuser)). The repair requires the returned user ID to match the JWT subject and a nonempty `email_confirmed_at`; a missing/unconfirmed user fails closed, while Auth endpoint unavailability returns 503. The public API key may be supplied as `SUPABASE_PUBLISHABLE_KEY` or the existing `VITE_SUPABASE_PUBLISHABLE_KEY`; it is not a server secret.

The project's actual **Confirm email** dashboard setting and the deployed Preview behavior are **NOT TESTED**. Keep Confirm email enabled. Supabase documents that unverified email users cannot sign in when this setting is enabled; backend verification provides an additional check before protected APIs accept the user.

JWT validation continues to permit RS256 and ES256 only. JWKS is derived from `SUPABASE_URL` as `/auth/v1/.well-known/jwks.json`, with bounded retrieval/cache behavior from `jose` and refresh on unknown key IDs. Live key rotation against the staging issuer is **NOT TESTED**.

## 5. Health and environment configuration

`/api/health` previously required explicit `AUTH_ISSUER`, `AUTH_AUDIENCE`, and `AUTH_ROLE_MAPPING`, while authentication itself derived issuer, audience, and JWKS from `SUPABASE_URL`. That mismatch explains a `not_configured` health result when only `SUPABASE_URL` was set.

The local repair exports `resolveAuthenticationConfig`; both request verification and health readiness now use that resolver. It validates safe issuer/JWKS URLs, derives Supabase issuer/audience/JWKS, requires a nonempty valid role mapping, and requires a publishable key when Supabase email verification is enabled. The health check no longer reports ready merely because a URL exists.

Browser values remain `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Server-only values such as provider keys, database URLs, the RLS HMAC key, and scanner credentials remain outside browser-prefixed variables.

## 6. `.env` deployment concern

- `.gitignore` contains `.env*` and re-includes only `.env.example`; Git reports the local `.env` and `.env.local` as ignored and untracked. `.env.example` contains placeholders and local-only development defaults, not production credentials.
- `src/.env` is absent from this checkout and is ignored by the same pattern.
- The locally available `.vercel/output` build tree contains the static assets and serverless function bundle, but no `src/.env` file. The saved local deployment diagnostics manifest does not contain a `src/.env` entry.
- A marker-only scan of the browser build found no server-only variable names for `AUTH_ROLE_MAPPING`, model-provider keys, database URLs, or `RLS_CONTEXT_HMAC_KEY`. The public Supabase project URL marker can appear in client code and is not a secret.
- The specific historical remote Preview file manifest cited in the request was not present as a local artifact. No Vercel API/dashboard inspection was performed, so whether that deployment exposed the path is **NOT TESTED**. No secret contents were opened, copied, or recorded.
- No evidence in this checkout shows a real secret committed to Git. If Vercel confirms that a built or publicly served `src/.env` contained real values, rotate the affected provider keys, database credentials, HMAC key, or scanner token based on its contents without reproducing them in logs or reports. Do not rewrite history or rotate automatically.

## 7. Ordered staging migration plan

The project has two PostgreSQL use cases: Supabase Auth roles/hooks and optional application vector/RAG storage. Conversations, documents, escalation, and meeting workflows primarily use MongoDB. `server/database.ts` uses PostgreSQL `knowledge.document_chunks` for vector and lexical retrieval only when configured.

1. **Decide the PostgreSQL target.** Confirm whether `DATABASE_URL` and `DATABASE_INGEST_URL` will point to Supabase Postgres or to a separate PostgreSQL service. Keep `DATABASE_MIGRATION_URL` out of deployed function scope. Before running the migration runner, verify its target matches the intended project.
2. **Do not run `infra/postgres/init/001-knowledge.sql` on hosted Supabase.** It is a Docker fresh-volume initializer using `psql` meta-commands, a hard-coded `uptoskills` database, and local LOGIN-role passwords. It is only for the local Compose database.
3. **If PostgreSQL RAG is enabled**, provision the least-privilege `uts_assistant_reader` and `uts_assistant_writer` LOGIN roles through the approved operator path, and verify required pgvector/pgcrypto support. Apply `002-document-chunks.sql` for the `knowledge.document_chunks` table and indexes.
4. Apply `003-document-chunk-rls.sql` followed immediately by `004-signed-tenant-rls.sql` as one controlled migration window. Do not send application traffic while the older caller-settable-GUC policy from 003 remains active. Migration 004 requires the app roles and creates the private signed-context roles, key table, functions, and final policy.
5. After 004, generate a unique 32-byte staging HMAC key in the approved secret manager and provision the matching row using the operator workflow. Verify the reader/writer session identity, RLS readiness function, policy, and key match before enabling PostgreSQL runtime traffic. Do not place a key in a migration.
6. **For Supabase Auth**, apply the corrected `005-supabase-auth-roles-and-hook.sql` only to the intended Supabase staging project. If vector/RAG is not hosted there, the Auth migration can be handled separately from 002–004. The local migration runner now skips 005 unless `SUPABASE_URL` is explicitly configured; still verify the migration URL target before applying it.
7. Review grants, policies, trigger, hook function owner, `user_roles` data, and a normal user's `user` role in staging. Only then select `public.custom_access_token_hook` in Auth > Hooks, verify Confirm email is enabled, and test user/support-agent/admin claim issuance and protected route behavior. Do not use Production or promote a Preview.

No part of this sequence has been executed.

## 8. Exact local test and build results

| Command | Result |
| --- | --- |
| `npm test` | PASS — 172 tests passed, 0 failed. |
| `npm run lint` | PASS — `tsc --noEmit` completed with no errors. |
| `npm run build` | PASS — ESM graph check, lint, and Vite production build completed. Vite emitted the existing advisory that the minified client chunk is larger than 500 kB. |
| `npm run check:serverless-esm-graph` | PASS within `npm run build`: 29 source modules bundled to Node 26 ESM; runtime v24.16.0 loaded output; missing Preview integrations returned health 503; 24 protected route patterns returned 401. A standalone invocation in the read-only sandbox initially failed while creating its temporary directory. |
| `git diff --check` | PASS — no whitespace errors. Git emitted only line-ending normalization warnings for edited files. |

The test suite and build used local generated artifacts only. No test contacted Supabase, Vercel, or a remote database.

## 9. Files changed and why

- `infra/postgres/migrations/005-supabase-auth-roles-and-hook.sql` — narrow hook table access, add explicit Auth schema/function grants and RLS policy, return claims in the supported response shape, reject inconsistent tenant rows, harden paths, and restrict role assignment to trusted operators.
- `server/auth.ts` — add shared resolved auth configuration; verify email status with Supabase Auth rather than invented JWT fields; retain fail-closed role extraction and classify Auth outages.
- `server/app.ts` — use resolved auth configuration for health readiness.
- `server/database.ts` — skip the Supabase-only migration for generic PostgreSQL targets unless `SUPABASE_URL` explicitly signals Supabase setup.
- `server/supabase-auth.test.ts`, `server/database.test.ts`, `server/health.test.ts` — cover realistic Supabase JWT claims, every supported role, invalid/missing claims, email verification, migration privilege assumptions, migration applicability, and shared health configuration.
- `.env.example`, `docs/ENVIRONMENT_VARIABLES.md`, `docs/PHASE_10_SUPABASE_AUTHENTICATION_REPORT.md` — document the supported role mapping and correct server-side email verification flow.
- `docs/PHASE_10A_SUPABASE_AUTH_PREFLIGHT_REPORT.md` — this audit and staging plan.

## 10. Remaining manual Supabase/Vercel review

After this report is reviewed, the operator should inspect the staging project's Auth confirmation setting and role definitions, confirm the migration target, apply the corrected migration in staging, verify the hook grants/RLS and output, then enable the hook. The Vercel Preview `AUTH_ROLE_MAPPING` should be updated to the exact value in Section 3 only after verifying the role issuance policy. The historical deployment file manifest should also be rechecked through Vercel; if it confirms actual secret exposure, rotate affected credentials separately. These actions are pending review and were not performed here.
