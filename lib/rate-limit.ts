/**
 * In-memory sliding window rate limiter cho Edge / Serverless functions.
 * Giúp ngăn chặn việc lạm dụng hoặc rút cạn bể API key.
 */
interface RateLimitBucket {
  count: number;
  resetTime: number;
}

const ipBuckets = new Map<string, RateLimitBucket>();
const CLEANUP_INTERVAL = 60_000;
let lastCleanup = Date.now();

export function checkRateLimit(
  ip: string,
  limit = 30,
  windowMs = 60_000,
): { allowed: boolean; remaining: number; resetInSec: number } {
  const now = Date.now();

  // Dọn dẹp bucket hết hạn để tránh leak memory
  if (now - lastCleanup > CLEANUP_INTERVAL) {
    for (const [key, bucket] of ipBuckets.entries()) {
      if (bucket.resetTime <= now) ipBuckets.delete(key);
    }
    lastCleanup = now;
  }

  const bucket = ipBuckets.get(ip);
  if (!bucket || bucket.resetTime <= now) {
    ipBuckets.set(ip, { count: 1, resetTime: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetInSec: Math.ceil(windowMs / 1000) };
  }

  const resetInSec = Math.max(1, Math.ceil((bucket.resetTime - now) / 1000));

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetInSec };
  }

  bucket.count++;
  return { allowed: true, remaining: limit - bucket.count, resetInSec };
}

export function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    '127.0.0.1'
  );
}
