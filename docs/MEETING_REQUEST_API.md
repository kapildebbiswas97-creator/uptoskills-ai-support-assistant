# Meeting Request API

**Status:** Implemented in source; live OIDC/browser and MongoDB integration are not verified. The queue-first lifecycle remains subject to D-07 stakeholder approval.

All endpoints are mounted under `/api`. They require a verified bearer token through the existing OIDC middleware. Requester identity and tenant are taken from the verified server principal; client-supplied identity, role, tenant, actor, or confirmation timestamp fields are rejected. HR routes require the existing mapped `support_agent` role; generic administrator bypass is disabled. HR records are filtered by tenant.

## Requester routes

### `POST /api/meeting-requests`

Creates a meeting request. Required header: `Idempotency-Key` matching 16–128 ASCII letters, digits, `_` or `-`.

```json
{
  "subject": "Discuss internship onboarding",
  "purpose": "I need help understanding the onboarding steps and required documents.",
  "timeZone": "Asia/Kolkata",
  "preferredTimes": [
    { "startAt": "2026-12-01T09:00:00+05:30", "endAt": "2026-12-01T09:30:00+05:30" }
  ],
  "conversationId": "optional-owned-conversation-id"
}
```

Subject is 5–120 characters; purpose is 10–2000. Provide 1–3 preferred ranges. Timestamps must be valid ISO 8601 date-times with `Z` or an explicit offset, must be in the future, and end must follow start. Timezone must be a valid IANA identifier. No duration policy is inferred. Optional conversation IDs must refer to an active conversation owned by the requester in their tenant.

On first successful durable creation, returns `201` and `{ "request": ... }`; an identical retry with the same key returns `200`, the original request, and `Idempotency-Replayed: true`. Reusing the key with materially different data returns `409`. A request is created as `pending` only after request and audit writes succeed.

### `GET /api/meeting-requests/mine?page=1&pageSize=20`

Lists only the verified requester's records. Page range is 1–10000; page size is 1–50.

### `GET /api/meeting-requests/mine/:requestId`

Returns an owned request or `404`. Requester DTOs contain request details, preferred times, status history (without actor IDs/roles), confirmed schedule/timezone/location/time if confirmed, and rejection explanation if rejected. They omit tenant, requester identity, HR actor, audit metadata, idempotency key/hash, and internal notes.

### `POST /api/meeting-requests/mine/:requestId/cancel`

Cancels only a pending request owned by the requester. Body: `{ "expectedVersion": 1 }`. Cancellation is an audited status transition; the record is not deleted. Stale version or non-pending state returns `409`.

## HR routes

Every HR route requires verified `support_agent` role and tenant scope.

- `GET /api/admin/meeting-requests?page=1&pageSize=20&status=pending` — paginated queue; optional status is `pending`, `confirmed`, `rejected`, or `cancelled`.
- `GET /api/admin/meeting-requests/:requestId` — HR view including permitted requester/tenant identifiers and full status actor history.
- `POST /api/admin/meeting-requests/:requestId/confirm` — explicit manual confirmation.
- `POST /api/admin/meeting-requests/:requestId/reject` — rejection with requester-visible explanation.

Confirmation body:

```json
{
  "expectedVersion": 1,
  "startAt": "2026-12-01T09:00:00+05:30",
  "endAt": "2026-12-01T09:30:00+05:30",
  "timeZone": "Asia/Kolkata",
  "location": "Optional actually confirmed location or joining details"
}
```

The schedule must be actual, explicit, valid, future, and ordered. Timezone is IANA validated; location is optional and limited to 500 characters. The service sets `confirmedAt` using server time, `confirmedBy` from the verified principal, and `source: "hr_manual"`. Client actor/time/source fields are not accepted. Confirmation does not create an external calendar event or send an invitation.

Rejection body: `{ "expectedVersion": 1, "reason": "A brief explanation for the requester." }`; reason length is 3–1000 characters.

Confirm/reject are allowed only from `pending` and require the current version. Successful changes and their audit events are written in one Mongo transaction. Conflicting/repeated/stale decisions return `409`.

## Status lifecycle

`pending` is the only creation status. Allowed transitions are `pending → confirmed`, `pending → rejected`, and requester-owned `pending → cancelled`. There are no transitions out of a terminal state. This is an implemented technical proposal, not an approved UpToSkills policy until D-07 is resolved.

## Errors

- `400`: invalid body, fields, date/time, timezone, range, page, reason, or missing/invalid idempotency key.
- `401`: no valid authenticated principal.
- `403`: authenticated caller is not authorized HR for an HR route.
- `404`: request is not found in caller's permitted owner/tenant scope.
- `409`: idempotency conflict, stale version, or invalid/repeated transition.
- `429`: meeting submission rate limit exceeded.
- `503`: database, transaction, or service failure. No success response is returned if persistence/audit fails.

## Persistence, audit, and integration boundary

MongoDB `meeting_requests` records include internal ID, random `UTM-` reference, requester and tenant, optional conversation ID, subject/purpose, preferred times and IANA timezone, status/version/history, confirmation or rejection data, idempotency key/hash, and timestamps. Indexes cover unique reference, tenant/requester/time, tenant/status/time, and tenant/requester/idempotency. Audit events contain trusted actor/action/resource/time/request ID, tenant, status transition and (on confirmation) `hr_manual` source; ordinary logs do not include purpose or full request body.

Mongo sessions/transactions are used in source for request+audit and transition+audit atomicity. Real transaction behavior requires a replica set and has not yet been verified; the gated disposable integration test was skipped. No calendar adapter interface, provider, calendar event, invitation, email, SMS, or notification call exists. Any future provider requires separate stakeholder approval, credentials, and integration testing.
