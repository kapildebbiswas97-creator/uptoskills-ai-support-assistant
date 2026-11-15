import assert from 'node:assert/strict';
import test from 'node:test';
import { configureMetricsSink, logEvent, recordMetric } from './observability';

test('metrics sink receives event counters and latency histograms without affecting callers', () => {
  const counters: Array<{ name: string; labels: Record<string, string> }> = [];
  const observations: Array<{ name: string; value: number; labels: Record<string, string> }> = [];
  configureMetricsSink({
    increment(name, labels) { counters.push({ name, labels }); },
    observe(name, value, labels) { observations.push({ name, value, labels }); },
  });
  try {
    logEvent('rag.retrieval.complete', { durationMs: 12, prompt: 'sensitive prompt' });
    recordMetric('database_probe_duration_ms', 8, { database: 'postgresql' }, 'histogram');
    assert.ok(counters.some((metric) => metric.name === 'application_events_total' && metric.labels.event === 'rag.retrieval.complete'));
    assert.ok(observations.some((metric) => metric.name === 'application_event_duration_ms' && metric.value === 12));
    assert.ok(observations.some((metric) => metric.name === 'database_probe_duration_ms' && metric.value === 8));
  } finally {
    configureMetricsSink(undefined);
  }
});
