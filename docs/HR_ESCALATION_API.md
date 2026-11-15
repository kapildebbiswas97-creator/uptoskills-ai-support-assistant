# HR Escalation API

This document describes the current Phase 7 implementation. It is not confirmation of an approved HR destination or retention policy. All routes below require a verified bearer token. A browser OIDC client is not present in this checkout, so the requester and HR UI must report authentication unavailable and must not create anonymous tickets.

## Authentication and roles

The API uses the existing server-side OIDC verifier in `server/auth.ts`. Tokens must have a trusted issuer, the configured audience, a valid RS256 or ES256 signature, `sub`, `iat`, and `exp`, and valid time claims. The verifier retrieves keys from configured HTTPS JWKS (HTTP loopback is allowed only outside production); `jose` caches keys and refreshes on unknown key IDs with a cooldown. Missing credentials return 401. Invalid or expired credentials return 401. A supplied token when auth configuration or JWKS is unavailable returns 503.

Application roles are created only by mapping signed IdP claim values through `AUTH_ROLE_MAPPING`. There is no default `support_agent`/HR mapping. Configure a specific trusted HR group claim to `support_agent` only after D-05 approval. Generic `admin` and `super_admin` claims do not grant HR escalation access. The HR endpoints check the authenticated principal on every request. Tenant scope comes from a signed configured claim (`AUTH_TENANT_CLAIM`, default `org_id`).

## Requester routes

Base path: `/api/escalations`

### `POST /api/escalations`

Creates a ticket for the verified principal. The `Idempotency-Key` header is required and must be 16–128 URL-safe characters. Request JSON permits only:

```json
{
  "subject": "Help with my application",
  "description": "I need help understanding the next step in my application.",
  "category": "Application process",
  "conversationId": "optional-owned-conversation-id",
  "consent": { "accepted": true, "version": "hr-escalation-v1" }
}
```

`category` and `conversationId` are optional. Subject length is 5–120 characters; description length is 10–10,000 characters. Any supplied conversation must be active and owned by the same verified subject and tenant. Consent must match the current version. The server stores the consent wording and server timestamp. Client-supplied identity, role, tenant, status, actor, timestamps, notes, and unknown fields are rejected.

First successful create returns `201` with a requester DTO. A same-request retry with the same authenticated requester, tenant and key, and the same normalized payload returns the original ticket with `200` and `Idempotency-Replayed: true`. Reusing a key with changed material input returns `409`. Responses do not expose requester/tenant identifiers, consent internals, internal notes, or audit records.

### `GET /api/escalations/mine?page=1&pageSize=20`

Lists only the authenticated requester's tickets, scoped by requester subject and tenant. Page size is 1–50. Returns ticket summaries and pagination metadata.

### `GET /api/escalations/mine/:ticketId`

Returns a requester detail DTO only if the ticket belongs to that subject and tenant. Other owners and tenants receive the same `404` response as a missing ticket. The DTO excludes internal notes and privileged actor/tenant/audit fields.

## HR routes

All HR routes require the explicitly mapped `support_agent` role and tenant scope from the verified principal. A normal user or generic platform administrator receives `403`; an unauthenticated caller receives `401`.

### `GET /api/escalations/admin/escalations?page=1&pageSize=20&status=open`

Returns a tenant-scoped queue. `status` is optional and must be `open`, `in_progress`, `resolved`, or `closed`. Page size is 1–50.

### `GET /api/escalations/admin/escalations/:ticketId`

Returns the HR DTO, including the ticket description, consent record, requester/tenant scope, status history, and internal notes, only to an authorized HR principal in the ticket tenant.

### `PATCH /api/escalations/admin/escalations/:ticketId`

Request JSON contains only `status` and `expectedVersion`. Supported transitions are `open → in_progress → resolved → closed`. The backend enforces transitions and updates only if the expected version matches. Stale writes return `409`; client actor and timestamp fields are not accepted.

### `POST /api/escalations/admin/escalations/:ticketId/notes`

Request JSON contains only `content` (1–5,000 trimmed characters) and `expectedVersion`. Notes are stored as internal HR notes and appear only in HR DTOs. They are not copied into audit metadata or application log events.

## Persistence and audit

MongoDB is the source of truth for tickets. `npm run db:mongo:init` creates the collection validator and indexes: unique non-guessable reference, tenant/requester/time lookup, tenant/status/time queue lookup, and tenant/requester/idempotency uniqueness. Index initialization must be run before serving traffic and must not be run against production as part of this phase.

Ticket creation and its `escalation.created` audit event run in one MongoDB transaction. Status and internal-note changes and their audit events also share a transaction. The MongoDB deployment must support multi-document transactions: use a replica set or sharded cluster; a standalone server is insufficient. Transaction support has not been exercised against a live database in this phase. An unavailable/unsupported transaction fails the operation; the code does not silently write an unaudited ticket.

Audit records use server-derived actor subject, mapped role, tenant, action, ticket ID, request ID, timestamp, and status transition metadata. Note contents and full ticket descriptions are omitted. Denied HR requests generate redacted structured security events; requester APIs cannot access audit logs.

## Error behavior

| Status | Meaning |
|---|---|
| 201 | Ticket created or HR note added |
| 200 | Read/update succeeded or idempotent create replayed |
| 400 | Invalid request, missing consent, invalid key, status, pagination, or note |
| 401 | Missing, invalid, or expired authentication |
| 403 | Authenticated principal lacks the mapped HR permission |
| 404 | Ticket/conversation missing or outside the caller's scope |
| 409 | Idempotency payload mismatch, stale version, or invalid transition |
| 429 | Submission rate limit reached |
| 503 | Auth/JWKS service unavailable or persistence/transaction failure |

The frontend displays a ticket reference only after an API success response. On network/database failure it keeps the idempotency key for a safe retry. No HR response SLA or external destination is promised or configured.
