import { createHash } from 'node:crypto';
import { createClient } from 'redis';

export interface RequestRateLimiter {
  backend: 'redis' | 'memory';
  allow(ipAddress: string): Promise<boolean>;
  close(): Promise<void>;
}

export async function createRequestRateLimiter(redisUrl?: string): Promise<RequestRateLimiter> {
  let client: ReturnType<typeof createClient> | undefined;
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
    }
  }

  const redisClient = client;
  const localRequests = new Map<string, number[]>();
  const windowMs = 60_000;
  const maxRequests = 40;

  return {
    backend: redisClient ? 'redis' : 'memory',
    async allow(ipAddress) {
      const minuteKey = Math.floor(Date.now() / windowMs);
      const key = `uts:chat:${createHash('sha256').update(ipAddress).digest('hex').slice(0, 24)}:${minuteKey}`;
      if (redisClient?.isReady) {
        try {
          const count = await redisClient.incr(key);
          if (count === 1) await redisClient.expire(key, 60);
          return count <= maxRequests;
        } catch {
          // Redis is optional; continue with a per-process fallback if it drops.
        }
      }

      const now = Date.now();
      const active = (localRequests.get(key) ?? []).filter((time) => now - time < windowMs);
      if (active.length >= maxRequests) {
        localRequests.set(key, active);
        return false;
      }
      active.push(now);
      localRequests.set(key, active);
      if (localRequests.size > 10_000) localRequests.delete(localRequests.keys().next().value!);
      return true;
    },
    async close() {
      if (redisClient?.isOpen) await redisClient.quit();
    },
  };
}
