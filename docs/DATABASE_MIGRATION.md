# Database Migration

## MongoDB

Set `MONGODB_URI` and `MONGODB_DATABASE`, then run `npm run db:mongo:init` in a controlled environment. The initializer creates missing collections and indexes. It does not remove or rename data. Review unique-index conflicts and existing collection validators before running against populated data.

## PostgreSQL

Set `DATABASE_MIGRATION_URL` to the intended database and a controlled migration operator. Review every numbered file under `infra/postgres/migrations/`, take a backup, then run `npm run db:postgres:migrate`. The runner serializes executions with an advisory lock, creates `public.schema_migrations` on first use, records applied filenames, and runs each SQL file transactionally. It does not run on application startup. The Supabase migration operator does not need superuser; it does need `CREATEROLE`, ownership of the target database to make a temporary database `CREATE` grant for schema ownership, and authorized `SET ROLE` access to both `uts_rls_context_owner` and `uts_rls_key_admin`. Migration 004 checks `MEMBER` on PostgreSQL 14–15 and the `SET` privilege on PostgreSQL 16 and later. Existing membership options are preserved; if required access cannot be established, the migration fails with instructions for an authorized role administrator. Do not use reader/writer application credentials for migrations.

The migrations are ordered: `002` creates the chunk table, `003` adds the historical GUC policy, and `004` replaces that policy with signed tenant context. Keep all application traffic disabled from the commit of 003 until 004 completes. A database that has applied 003 but not 004 remains exposed to caller-settable tenant GUCs; do not treat 003 as the final hardened state. Migration 004 creates and validates no-login context-owner and key-admin roles, grants the executing migration operator membership so it can transfer/manage private objects, and verifies app roles are not privileged or members of protected roles.

### Supabase staging procedure

Use this sequence only after reviewing the local migration diff. These are staging-only steps; Production must use its own separately reviewed process.

1. **Confirm the target and keep traffic off.** In Supabase Dashboard > Project Settings > General, confirm the project ref is `vymepfpxtfwkkoaykdny`. In the Connect panel, confirm the database is `postgres` and the migration identity is `postgres`. Keep the application’s PostgreSQL runtime disabled until migrations 002–004 complete and the signed key is provisioned.
2. **Verify extensions in the dashboard.** In Database > Extensions, confirm `vector` is enabled in `extensions` and `pgcrypto` is enabled in `extensions`. The current preflight found pgvector 0.8.2 and pgcrypto 1.3 there, with `hmac(bytea, bytea, text)` present. Migration 002 verifies the vector type and cosine operator class. Migration 004 relocates pgcrypto only when it is in `extensions`, owned by the current migration operator, and marked relocatable. It preserves pgcrypto already in `app_private`. It never creates, drops, or recreates an extension. Stop if an extension check differs; the migration reports the required operator action.
3. **Create the two app login roles before migration 002.** The current preflight found both absent. In the staging SQL Editor, create the distinct roles with these attributes (do not put passwords in migration files):

   ```sql
   CREATE ROLE uts_assistant_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
   CREATE ROLE uts_assistant_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
   GRANT CONNECT ON DATABASE postgres TO uts_assistant_reader, uts_assistant_writer;
   ```

   Set separate, unique passwords through the approved secret-management process before configuring `DATABASE_URL` and `DATABASE_INGEST_URL`. Do not grant these roles membership in each other, helper roles, `postgres`, or any role with `CREATEROLE`, `CREATEDB`, or `BYPASSRLS`.
4. **Configure the local operator environment only.** Point `DATABASE_MIGRATION_URL` to this staging database and set `SUPABASE_URL` to the same project URL so the runner includes Supabase-only migration 005. Verify both targets before running the command. `SUPABASE_URL` is used as a migration-scope selector; the runner does not infer that two URLs point to the same project.
5. **Run the reviewed migrations 002 through 005.** From the repository branch under review, run `npm run db:postgres:migrate`. On a fresh migration ledger, the runner creates `public.schema_migrations`, then applies numbered files in order and wraps each file in its own transaction. Migration 003 briefly installs the legacy GUC policy; do not enable traffic during the run. Migration 004 verifies the two app roles, creates its two separate NOLOGIN helper roles, relocates pgcrypto only after its catalog checks pass, confirms `app_private.hmac(bytea, bytea, text)`, and only then replaces the policy with signed RLS. If any migration fails, stop and inspect the exact error; the runner rolls back that file and records only committed migrations.
6. **Verify the database before runtime configuration.** As the migration operator, verify `public.schema_migrations` records 002–005; `knowledge.document_chunks` still has `vector(768)`; reader and writer have only their intended table operations and required schema usage; `app_private` is owned by `uts_rls_context_owner`; pgcrypto/hmac is in `app_private`; the four roles remain distinct; and `document_chunks_signed_tenant_context` is present while the earlier GUC policy is absent. Use the application readiness checks with the actual reader/writer logins. Do not insert an RLS HMAC key in a migration.
7. **Provision the staging HMAC key separately.** Only after the migration and grants pass review, generate a unique 32-byte key in the approved secret manager and insert the matching key ID and bytes through the trusted operator workflow. Verify the reader/writer readiness check, then configure application runtime credentials. Do not reuse local or Production keys.
8. **Handle Auth Hook configuration separately.** Migration 005 creates `public.user_roles` and its hook function. Review its grants, RLS policy, trigger, function response, and role-assignment permissions before selecting it under Authentication > Hooks. Keep Confirm email enabled. Do not enable the hook as part of the migration command.

Migration 002 requires the app roles and pre-enabled pgvector; it resolves the extension schema from `pg_extension`, verifies `USAGE`, `vector`, and `vector_cosine_ops`, then sets a transaction-local search path before declaring `vector(768)`. The application sets a corresponding runtime search path with `extensions` before `public`, which supports Supabase and local PostgreSQL installations without changing stored dimensions or data.

The vector schema currently uses `vector(768)`. A dimension or embedding-model change needs a new versioned migration, re-embedding plan, and index rebuild. The initial SQL under `infra/postgres/init/` applies only to a fresh local Docker volume; it is not a production migration mechanism.

## Local signed-key provisioning

For a disposable loopback PostgreSQL database whose name ends in `_integration`, set `APP_ENV=local-integration`, `DATABASE_MIGRATION_URL`, a `DATABASE_URL` reader login targeting the same database, `RLS_CONTEXT_KEY_ID`, and `RLS_CONTEXT_HMAC_KEY` from a local secret store, then run:

```powershell
npm run db:postgres:provision-local-rls-key
```

This local-only command uses parameterized SQL, never prints the key, refuses non-loopback hosts and other database names, and verifies readiness through the actual reader login. It does not apply migrations. For staging, provision through the approved operator/secret-management process using bound parameters; do not run this local-only command or copy production secrets into a local environment. The database and application need the same key. To rotate, provision a new key ID, roll application configuration, wait at least five minutes, then disable the previous DB key through the operator process.

For local integration migrations, use `npm run db:postgres:migrate:local`. It requires `APP_ENV=local-integration`, a loopback `DATABASE_MIGRATION_URL`, and a database name ending `_integration`; the existing `db:postgres:migrate` command remains the general operator command and has no local-target guard.

No migration, key provisioning, or database connection was run during Phase 5A.
