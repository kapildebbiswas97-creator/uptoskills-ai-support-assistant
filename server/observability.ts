import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      traceId?: string;
      ragExecutionId?: string;
    }
  }
}

export interface MetricsSink {
  increment(name: string, labels: Record<string, string>): void;
  observe(name: string, value: number, labels: Record<string, string>): void;
}

let metricsSink: MetricsSink | undefined;
const requestContext = new AsyncLocalStorage<{ requestId: string; traceId: string }>();

export function configureMetricsSink(sink?: MetricsSink): void {
  metricsSink = sink;
}

export function recordMetric(name: string, value: number, labels: Record<string, string> = {}, kind: 'counter' | 'histogram' = 'counter'): void {
  try {
    if (kind === 'counter') metricsSink?.increment(name, labels);
    else metricsSink?.observe(name, value, labels);
  } catch {
    // Instrumentation must never break request handling.
  }
}

const safeUsageCounters = new Set(['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens']);

function safeFields(fields: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/(authorization|token|password|secret|api.?key|uri|url|email|query|content|prompt|filename|subject|tenant|documentId)/i.test(key) && !safeUsageCounters.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === 'boolean') safe[key] = value;
    else if (value === null && key === 'serverToolCostUsd') safe[key] = null;
    else if (typeof value === 'string' && value.length <= 200) safe[key] = value;
  }
  return safe;
}

export function logEvent(event: string, fields: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
  recordMetric('application_events_total', 1, { event, level }, 'counter');
  if (typeof fields.durationMs === 'number' && Number.isFinite(fields.durationMs)) {
    recordMetric('application_event_duration_ms', fields.durationMs, { event }, 'histogram');
  }
  const record = { timestamp: new Date().toISOString(), level, event, ...requestContext.getStore(), ...safeFields(fields) };
  const serialized = `${JSON.stringify(record)}\n`;
  if (level === 'error') process.stderr.write(serialized);
  else process.stdout.write(serialized);
}

export function requestObservabilityMiddleware(request: Request, response: Response, next: NextFunction): void {
  const supplied = request.header('x-request-id');
  const requestId = supplied && /^[A-Za-z0-9_-]{8,64}$/.test(supplied) ? supplied : randomUUID();
  const traceparent = request.header('traceparent');
  const traceId = traceparent && /^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/i.exec(traceparent)?.[1] || randomUUID().replaceAll('-', '');
  const startedAt = performance.now();
  request.requestId = requestId;
  request.traceId = traceId;
  response.setHeader('X-Request-ID', requestId);
  response.setHeader('X-Trace-ID', traceId);
  response.on('finish', () => {
    logEvent('http.request.complete', {
      requestId,
      traceId,
      method: request.method,
      route: request.route?.path || 'unmatched',
      status: response.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    }, response.statusCode >= 500 ? 'error' : 'info');
  });
  requestContext.run({ requestId, traceId }, next);
}
