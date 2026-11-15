# Observability

## Implemented

- Structured JSON logs include timestamp, level, event, request ID, trace ID on HTTP completion, and route/status/duration.
- `traceparent` is accepted only in the W3C traceparent shape; the extracted trace ID is returned as `X-Trace-ID`. `X-Request-ID` remains an independent safe correlation ID. RAG execution IDs correlate retrieval and provider work.
- Logs record model completion/failure/timeout, retrieval latency/failure, auth failures/denials, scanner/ingestion/deletion failures, health probes and Redis fallback. Secret-like and content-bearing field names are dropped.
- `MetricsSink` is an injectable interface for counters and histograms. Generic event counters/durations, DB probe latency/status and rate-limit decisions are instrumented without requiring a specific vendor.
- Health reports configured MongoDB and PostgreSQL/pgvector status and measured probe latency.

## Limits

- No metrics adapter, distributed trace exporter, dashboard, alert rule, or central log sink is configured here. `traceparent` propagation is correlation only, not a complete distributed tracing implementation.
- Health probes establish connectivity and pgvector extension presence, not schema/privilege correctness or end-to-end ingestion.
- Embedding/provider failures are logged by operation/type but dedicated vendor metrics and alerts require an injected sink and deployment setup.
- If Redis is unavailable, process-local fallback is weaker and not globally consistent across serverless instances.

Never log credentials, database URLs, uploaded content, or conversations. Set platform access controls and retention for staging/production sinks.
