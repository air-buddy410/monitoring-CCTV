export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}
export interface RateLimiter {
  /** Count one attempt for `key`; blocked once more than `max` attempts fall in the window. */
  hit(key: string, max: number): RateLimitResult;
  size(): number;
}

/**
 * Fixed-window in-memory limiter. Single process only (a multi-instance deployment needs a shared
 * store). Memory is bounded: expired windows are swept, then the oldest keys are evicted.
 */
export function createRateLimiter(opts: {
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const sweep = (t: number) => {
    for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
    for (const k of buckets.keys()) {
      if (buckets.size < maxKeys) break;
      buckets.delete(k);
    }
  };

  return {
    hit(key, max) {
      const t = now();
      let b = buckets.get(key);
      if (!b || b.resetAt <= t) {
        if (buckets.size >= maxKeys) sweep(t);
        b = { count: 0, resetAt: t + opts.windowMs };
        buckets.set(key, b);
      }
      b.count++;
      const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - t) / 1000));
      return { allowed: b.count <= max, retryAfterSec };
    },
    size: () => buckets.size,
  };
}
