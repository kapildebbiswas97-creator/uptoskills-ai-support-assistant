import { createHash } from 'node:crypto';
import { createClient } from 'redis';
import { logEvent, recordMetric } from './observability.js';

export interface RequestRateLimiter {
  backend: 'redis' | 'memory';
  allow(ipAddress: string): Promise<boolean>;
  close(): Promise<void>;
}

export async function createRequestRateLimiter(redisUrl?: string): Promise<RequestRateLimiter> {
  let client: ReturnType<typeof createClient> | undefined;
  let redisFallbackActive = false;
  let redisFailureLogged = false;
  if (redisUrl) {
    client = createClient({
      url: redisUrl,
      socket: { connectTimeout: 1000, reconnectStrategy: false },
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch {
      client = undefined;
      redisFallbackActive = true;
      logEvent('security.rate_limit_redis_unavailable', { reason: 'connect_failed' }, 'warn');
    }
  }

  const redisClient = client;
  const localRequests = new Map<string, number[]>();
  const windowMs = 60_000;
  const maxRequests = 40;

  return {
    get backend() { return redisClient?.isReady && !redisFallbackActive ? 'redis' : 'memory'; },
    async allow(ipAddress) {
      const minuteKey = Math.floor(Date.now() / windowMs);
      const key = `uts:chat:${createHash('sha256').update(ipAddress).digest('hex').slice(0, 24)}:${minuteKey}`;
      if (redisClient?.isReady) {
        try {
          const count = await redisClient.incr(key);
          if (count === 1) await redisClient.expire(key, 60);
          redisFallbackActive = false;
          recordMetric('rate_limit_decisions_total', 1, { backend: 'redis', decision: count <= maxRequests ? 'allow' : 'deny' });
          return count <= maxRequests;
        } catch {
          // Redis is optional; continue with a per-process fallback if it drops.
          redisFallbackActive = true;
          if (!redisFailureLogged) {
            redisFailureLogged = true;
            logEvent('security.rate_limit_redis_fallback', { reason: 'operation_failed' }, 'warn');
          }
        }
      }

      const now = Date.now();
      const active = (localRequests.get(key) ?? []).filter((time) => now - time < windowMs);
      if (active.length >= maxRequests) {
        localRequests.set(key, active);
        recordMetric('rate_limit_decisions_total', 1, { backend: 'memory', decision: 'deny' });
        return false;
      }
      active.push(now);
      localRequests.set(key, active);
      if (localRequests.size > 10_000) localRequests.delete(localRequests.keys().next().value!);
      recordMetric('rate_limit_decisions_total', 1, { backend: 'memory', decision: 'allow' });
      return true;
    },
    async close() {
      if (redisClient?.isOpen) await redisClient.quit();
    },
  };
}
