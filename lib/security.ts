/**
 * Module Bảo mật, Xác thực & Rate Limiting đa tầng cho Next.js Edge Runtime.
 * Hỗ trợ:
 * 1. Chống Giả Mạo IP (IP Spoofing & IPv6 Subnet Rotation Defense)
 * 2. Xác thực Same-Origin chống Open Proxy / Hotlinking từ bên ngoài
 * 3. Kiểm tra Mật khẩu truy cập hệ thống (APP_ACCESS_PASSWORD)
 * 4. Distributed Sliding Window Rate Limiter qua Upstash Redis REST
 *    (Đồng bộ trên toàn bộ Edge Isolates & Multi-region) với fallback In-Memory an toàn.
 */

interface RateLimitBucket {
  timestamps: number[];
}

const memoryBuckets = new Map<string, RateLimitBucket>();
const MAX_MEMORY_BUCKETS = 5000; // Giới hạn kích thước bộ nhớ để chống OOM Attack
const CLEANUP_INTERVAL = 60_000;
let lastCleanup = Date.now();

const FALLBACK_IP = '127.0.0.1';

/**
 * Chuẩn hóa và làm sạch chuỗi IP.
 * Với IPv6: Gom nhóm theo /64 subnet để chống tấn công xoay dải IPv6.
 */
export function normalizeIp(raw: string): string {
  const ip = raw.trim().toLowerCase();
  if (!ip || ip.length > 64) return FALLBACK_IP;

  // Loại bỏ port nếu có dạng 1.2.3.4:5678 hoặc [::1]:5678
  const cleanIp = ip.replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '');

  // Kiểm tra ký tự hợp lệ cho IPv4 / IPv6
  if (!/^[a-f0-9:.]+$/i.test(cleanIp)) {
    return FALLBACK_IP;
  }

  // Nếu là IPv6, gom 4 nhóm đầu tiên thành /64 subnet identifier
  if (cleanIp.includes(':')) {
    const parts = cleanIp.split(':');
    if (parts.length >= 4) {
      return `${parts.slice(0, 4).join(':')}::/64`;
    }
  }

  return cleanIp;
}

/**
 * Lấy IP tin cậy nhất từ các header của hạ tầng Vercel / Cloudflare.
 * Không tin tưởng x-forwarded-for do client tùy ý gửi nếu có header của platform.
 */
export function getClientIp(req: Request): string {
  // 1. Header do Vercel Edge Server tự động gắn (Không thể bị client ghi đè)
  const vercelIp = req.headers.get('x-vercel-forwarded-for');
  if (vercelIp) {
    const first = vercelIp.split(',')[0];
    return normalizeIp(first);
  }

  // 2. Header do Cloudflare gắn
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp) return normalizeIp(cfIp);

  // 3. Header từ reverse proxy đáng tin cậy
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return normalizeIp(realIp);

  // 4. Fallback x-forwarded-for (Được làm sạch và kiểm tra chặt chẽ)
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0];
    return normalizeIp(first);
  }

  return FALLBACK_IP;
}

/**
 * Kiểm tra Same-Origin để chống việc website khác biến endpoint của bạn thành Open Proxy.
 */
export function verifySameOrigin(req: Request): boolean {
  if (process.env.NODE_ENV !== 'production') return true;

  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  const host = req.headers.get('host') || req.headers.get('x-forwarded-host');

  if (!host) return true;

  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) return false;
    } catch {
      return false;
    }
  }

  if (referer) {
    try {
      const refererHost = new URL(referer).host;
      if (refererHost !== host) return false;
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * Xác thực Mật khẩu bảo vệ hệ thống (nếu có cấu hình APP_ACCESS_PASSWORD trên Vercel).
 */
export function verifyAccessAuth(req: Request): { authorized: boolean; reason?: string } {
  const requiredPassword = process.env.APP_ACCESS_PASSWORD?.trim();

  if (!requiredPassword) {
    return { authorized: true };
  }

  const clientPassword =
    req.headers.get('x-access-code')?.trim() ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();

  if (!clientPassword || clientPassword !== requiredPassword) {
    return {
      authorized: false,
      reason: 'Cần cung cấp Mật khẩu truy cập (Access Code) hợp lệ để sử dụng AI Chat.',
    };
  }

  return { authorized: true };
}

/**
 * Thuật toán Distributed Sliding Window Rate Limiting:
 * 1. Nếu có UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN:
 *    Thực thi ZREMRANGEBYSCORE + ZADD + ZCARD + EXPIRE trên Redis REST pipeline,
 *    đảm bảo đồng bộ 100% giữa tất cả các Edge Isolates & Multi-region.
 * 2. Fallback: In-Memory Sliding Window với LRU eviction và max 5,000 buckets.
 */
export async function checkRateLimit(
  key: string,
  limit = 20,
  windowMs = 60_000,
): Promise<{ allowed: boolean; remaining: number; resetInSec: number }> {
  const now = Date.now();
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  // 1. Phân tán trên Redis REST (Sliding Window Log via Sorted Set)
  if (upstashUrl && upstashToken) {
    try {
      const redisKey = `ratelimit:${key}`;
      const windowStart = now - windowMs;
      const windowSeconds = Math.ceil(windowMs / 1000) * 2;
      const member = `${now}-${Math.random().toString(36).slice(2, 7)}`;

      const res = await fetch(`${upstashUrl}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${upstashToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          ['ZREMRANGEBYSCORE', redisKey, 0, windowStart],
          ['ZADD', redisKey, now, member],
          ['ZCARD', redisKey],
          ['EXPIRE', redisKey, windowSeconds],
        ]),
        cache: 'no-store',
      });

      if (res.ok) {
        const data = await res.json();
        const currentCount = Number(data[2]?.result ?? 1);
        const resetInSec = Math.ceil(windowMs / 1000);

        if (currentCount > limit) {
          return { allowed: false, remaining: 0, resetInSec };
        }
        return { allowed: true, remaining: Math.max(0, limit - currentCount), resetInSec };
      }
    } catch (err) {
      console.warn('[DistributedRateLimit] Upstash Redis request failed, fallback to memory:', err);
    }
  }

  // 2. In-Memory Sliding Window (Fallback)
  if (now - lastCleanup > CLEANUP_INTERVAL) {
    for (const [k, bucket] of memoryBuckets.entries()) {
      bucket.timestamps = bucket.timestamps.filter((t) => t > now - windowMs);
      if (bucket.timestamps.length === 0) memoryBuckets.delete(k);
    }
    lastCleanup = now;
  }

  if (memoryBuckets.size >= MAX_MEMORY_BUCKETS) {
    const oldestKey = memoryBuckets.keys().next().value;
    if (oldestKey) memoryBuckets.delete(oldestKey);
  }

  let bucket = memoryBuckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    memoryBuckets.set(key, bucket);
  }

  // Lọc các timestamp nằm ngoài cửa sổ trượt
  bucket.timestamps = bucket.timestamps.filter((t) => t > now - windowMs);

  const resetInSec = Math.max(
    1,
    Math.ceil(((bucket.timestamps[0] ?? now) + windowMs - now) / 1000),
  );

  if (bucket.timestamps.length >= limit) {
    return { allowed: false, remaining: 0, resetInSec };
  }

  bucket.timestamps.push(now);
  return { allowed: true, remaining: limit - bucket.timestamps.length, resetInSec };
}
