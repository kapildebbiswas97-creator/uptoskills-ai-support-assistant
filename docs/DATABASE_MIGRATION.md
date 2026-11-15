# Database Migration

## MongoDB

Set `MONGODB_URI` and `MONGODB_DATABASE`, then run `npm run db:mongo:init` in a controlled environment. The initializer creates missing collections and indexes. It does not remove or rename data. Review unique-index conflicts and existing collection validators before running against populated data.

## PostgreSQL

Set `DATABASE_MIGRATION_URL` to a least-used migration account with the privileges required for schema and extension changes. Review every numbered file under `infra/postgres/migrations/`, take a backup, then run `npm run db:postgres:migrate`. The runner serializes executions with an advisory lock, records applied filenames, and runs each SQL file transactionally. It does not run on application startup.

The migrations are ordered: `002` creates the chunk table, `003` adds the historical GUC policy, and `004` replaces that policy with signed tenant context. A database that has applied 003 but not 004 remains exposed to caller-settable tenant GUCs; do not treat 003 as the final hardened state. Migration 004 creates a no-login context owner and key-admin role, grants the executing migration operator membership so it can transfer/manage private objects, verifies app roles are not privileged or members of protected roles, and fails if `pgcrypto` is installed outside the expected private schema. Use a migration operator able to create roles/extensions and `SET ROLE` to the created context/key-admin roles. Never use reader/writer application credentials for migrations.

The vector schema currently uses `vector(768)`. A dimension or embedding-model change needs a new versioned migration, re-embedding plan, and index rebuild. The initial SQL under `infra/postgres/init/` applies only to a fresh local Docker volume; it is not a production migration mechanism.

## Local signed-key provisioning

For a disposable loopback PostgreSQL database whose name ends in `_integration`, set `APP_ENV=local-integration`, `DATABASE_MIGRATION_URL`, a `DATABASE_URL` reader login targeting the same database, `RLS_CONTEXT_KEY_ID`, and `RLS_CONTEXT_HMAC_KEY` from a local secret store, then run:

```powershell
npm run db:postgres:provision-local-rls-key
```

This local-only command uses parameterized SQL, never prints the key, refuses non-loopback hosts and other database names, and verifies readiness through the actual reader login. It does not apply migrations. For staging, provision through the approved operator/secret-management process using bound parameters; do not run this local-only command or copy production secrets into a local environment. The database and application need the same key. To rotate, provision a new key ID, roll application configuration, wait at least five minutes, then disable the previous DB key through the operator process.

For local integration migrations, use `npm run db:postgres:migrate:local`. It requires `APP_ENV=local-integration`, a loopback `DATABASE_MIGRATION_URL`, and a database name ending `_integration`; the existing `db:postgres:migrate` command remains the general operator command and has no local-target guard.

No migration, key provisioning, or database connection was run during Phase 5A.
