# Database Recovery

Recovery steps are operational guidance; backup configuration was not accessible and is not verified.

## MongoDB Atlas

Enable and periodically verify Atlas backups and retention in the Atlas project. Restore to a separate cluster or point-in-time target first, verify collections and indexes, then perform a controlled application cutover. `npm run db:mongo:init` recreates missing collections and indexes after restore; it does not restore records.

## PostgreSQL

Configure provider-managed backups/PITR and test restores to an isolated database. Reapply reviewed migrations with `npm run db:postgres:migrate`. Rebuild HNSW and GIN indexes after a restore if needed. If vectors are missing or incompatible, reprocess MongoDB document content with `npm run db:documents:reconcile` and the matching embedding model/version.

## Cross-database recovery

The MongoDB job record and retained document content allow bounded retry of failed or stale ingestion. Reconciliation recreates a missing job for an orphaned pending/processing/failed MongoDB document, retries bounded jobs, and cleans deleting documents. It also removes bounded batches of PostgreSQL chunks whose MongoDB document record is missing and detects a bounded batch of MongoDB `ready` records with no PostgreSQL chunks. Verify MongoDB document statuses against PostgreSQL chunk IDs before reopening retrieval. Reconciliation is an operator command and must be scheduled/monitored by staging/production operations; the application does not run it automatically.

RPO/RTO depend on provider backup settings and have not been established. Do not claim backups exist until the Atlas and PostgreSQL configurations are inspected and a restore drill succeeds.
