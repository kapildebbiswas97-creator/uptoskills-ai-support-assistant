# Disposable PostgreSQL + pgvector RLS Setup on Windows

This guide is for a developer-owned, disposable local integration database only. It does not apply to staging or production. The commands below were prepared but **not executed in this environment** because Docker Desktop and PostgreSQL client tools are unavailable here.

## Prerequisites

- Windows 10/11 with Docker Desktop installed, started, and using Linux containers. Docker Desktop normally uses its managed WSL2 backend; this checkout's environment has no WSL installation and Docker Desktop must be installed/enabled separately by the workstation owner.
- PowerShell 7 or Windows PowerShell 5.1.
- Node.js and npm installed; this project already depends on `pg` 8.23.1.
- Project dependencies installed with `npm ci`.
- A free local TCP port 55432.
- Permission to pull the public `pgvector/pgvector:pg16` image. Do not put production credentials or data in this test container.

Check prerequisites first:

```powershell
docker version
docker info
docker compose version
node --version
npm --version
```

## Start a uniquely named local-only container

Run the following in the project root. The generated passwords contain URL-safe characters. Keep the PowerShell session open; the values live only in that process environment and are not written into repository files.

```powershell
$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$databaseName = "uts_rls_$($stamp)_integration"
$containerName = "uts-rls-$stamp"
$volumeName = "$containerName-data"
$hostPort = 55432
$superPassword = (& node -p "require('node:crypto').randomBytes(24).toString('base64url')").Trim()
$readerPassword = (& node -p "require('node:crypto').randomBytes(24).toString('base64url')").Trim()
$writerPassword = (& node -p "require('node:crypto').randomBytes(24).toString('base64url')").Trim()

if (docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $containerName }) { throw 'Generated container name already exists; choose a new timestamp.' }
if (Get-NetTCPConnection -LocalPort $hostPort -State Listen -ErrorAction SilentlyContinue) { throw 'Port 55432 is already in use; update $hostPort and the URLs below.' }

docker pull pgvector/pgvector:pg16
if ($LASTEXITCODE -ne 0) { throw 'Could not pull the PostgreSQL + pgvector image.' }
docker run --detach --name $containerName --restart no `
  --publish "127.0.0.1:${hostPort}:5432" `
  --env "POSTGRES_USER=postgres" `
  --env "POSTGRES_PASSWORD=$superPassword" `
  --env "POSTGRES_DB=postgres" `
  --volume "${volumeName}:/var/lib/postgresql/data" `
  pgvector/pgvector:pg16
if ($LASTEXITCODE -ne 0) { throw 'Container start failed.' }

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  docker exec $containerName pg_isready -U postgres -d postgres *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'PostgreSQL did not become ready; inspect this disposable container before proceeding.' }

docker inspect --format '{{json .NetworkSettings.Ports}}' $containerName
```

Confirm the printed port mapping has host IP `127.0.0.1` and host port `$hostPort`. Do not proceed if it is bound to `0.0.0.0` or another interface.

## Create the disposable database and runtime roles

The database name is generated and constrained to lowercase letters, digits, and underscores. Role passwords are random URL-safe strings. The migration connection uses the disposable container's local `postgres` operator account; it is not an application credential.

```powershell
if ($databaseName -notmatch '^[a-z0-9_]+_integration$') { throw 'Database name failed the disposable-name guard.' }

$bootstrapSql = @"
CREATE DATABASE $databaseName;
CREATE ROLE uts_assistant_reader LOGIN PASSWORD '$readerPassword' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE uts_assistant_writer LOGIN PASSWORD '$writerPassword' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE $databaseName TO uts_assistant_reader, uts_assistant_writer;
"@
$bootstrapSql | docker exec -i -e "PGPASSWORD=$superPassword" $containerName psql -U postgres -d postgres -v ON_ERROR_STOP=1
if ($LASTEXITCODE -ne 0) { throw 'Disposable role/database bootstrap failed.' }

$identity = docker exec -e "PGPASSWORD=$superPassword" $containerName psql -U postgres -d $databaseName -At -v ON_ERROR_STOP=1 -c "SELECT current_database()"
if ($LASTEXITCODE -ne 0 -or $identity.Trim() -ne $databaseName) { throw 'Database identity did not match the generated disposable database; do not migrate.' }
docker exec -e "PGPASSWORD=$superPassword" $containerName psql -U postgres -d $databaseName -At -v ON_ERROR_STOP=1 -c "SELECT version(), current_database(), inet_server_addr(), pg_is_in_recovery()"
```

Inspect the identity output. It must name only the generated `*_integration` database in this new local container. The migrations, not manual SQL, create the `knowledge.document_chunks` schema and pgvector extension.

## Run migrations, key provisioning, and the real RLS suite

Set process-only values. The integration database URL uses loopback and the guarded `_integration` name. The app test requires distinct reader, writer, and migration usernames.

```powershell
$env:APP_ENV = 'local-integration'
$env:RUN_LOCAL_POSTGRES_RLS_TESTS = 'true'
$env:DATABASE_URL = "postgresql://uts_assistant_reader:$readerPassword@127.0.0.1:$hostPort/$databaseName?sslmode=disable"
$env:DATABASE_INGEST_URL = "postgresql://uts_assistant_writer:$writerPassword@127.0.0.1:$hostPort/$databaseName?sslmode=disable"
$env:DATABASE_MIGRATION_URL = "postgresql://postgres:$superPassword@127.0.0.1:$hostPort/$databaseName?sslmode=disable"
$env:RLS_CONTEXT_KEY_ID = "local-$stamp"
$env:RLS_CONTEXT_HMAC_KEY = (& node -p "require('node:crypto').randomBytes(32).toString('base64url')").Trim()

npm run db:postgres:migrate:local
if ($LASTEXITCODE -ne 0) { throw 'Migration failed; stop and inspect only this disposable database.' }
npm run db:postgres:provision-local-rls-key
if ($LASTEXITCODE -ne 0) { throw 'Local key provisioning failed; stop and inspect only this disposable database.' }
npm run test:integration:rls
if ($LASTEXITCODE -ne 0) { throw 'Real PostgreSQL RLS integration suite failed.' }
```

The migration helper applies migrations 002, 003, and 004 in order, records them in `public.schema_migrations`, and uses an advisory lock. The RLS test suite verifies own/cross-tenant reads and writes, missing/malformed/altered/expired context, replay scope, reader write denial, privileged key/function access, migration/runtime separation, pool cleanup, forced RLS metadata, and global-context behavior. A passing run verifies this disposable instance only; it is not staging or production evidence.

## Stop and remove only this disposable environment

Confirm the generated name before removal. This cleanup removes only the named unique container and its unique volume created above.

```powershell
docker inspect $containerName --format '{{.Name}} {{json .NetworkSettings.Ports}}'
if ($containerName -notlike 'uts-rls-*') { throw 'Unexpected container name; refusing cleanup.' }
$confirmation = Read-Host "Type the exact container name $containerName to remove this disposable integration database"
if ($confirmation -cne $containerName) { throw 'Name did not match; nothing removed.' }
docker rm --force $containerName
if ($LASTEXITCODE -ne 0) { throw 'Container removal failed; volume was left untouched.' }
docker volume inspect $volumeName
$volumeConfirmation = Read-Host "Type the exact volume name $volumeName to delete its disposable database files"
if ($volumeConfirmation -cne $volumeName -or $volumeName -notlike 'uts-rls-*-data') { throw 'Volume confirmation failed; volume was left untouched.' }
docker volume rm $volumeName
```

These commands were not run here. Never use a shared development volume or `docker compose down -v` as a substitute for the uniquely named disposable volume procedure.
