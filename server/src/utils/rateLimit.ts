import { Request, Response, NextFunction } from 'express';

interface Bucket { count: number; resetAt: number; }

/**
 * Tiny in-memory fixed-window rate limiter. Good enough for a single-node event server.
 * `key` decides who shares a bucket (defaults to client IP).
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  message?: string;
  key?: (req: Request) => string;
}) {
  const buckets = new Map<string, Bucket>();

  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, Math.max(opts.windowMs, 30_000)).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const k = opts.key ? opts.key(req) : (req.ip || 'unknown');
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(k, b);
    }
    b.count++;
    if (b.count > opts.max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: opts.message || `Too many requests. Try again in ${retry}s.` });
    }
    next();
  };
}

/** Per-key cooldown (e.g. one submission every N seconds per team). Returns seconds to wait, or 0. */
export class Cooldown {
  private last = new Map<string, number>();
  constructor(private ms: number) {}
  check(key: string, overrideMs?: number): number {
    const now = Date.now();
    const gap = overrideMs ?? this.ms;
    const prev = this.last.get(key) ?? 0;
    const wait = prev + gap - now;
    if (wait > 0) return Math.ceil(wait / 1000);
    this.last.set(key, now);
    return 0;
  }
}
