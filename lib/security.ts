import type { NextRequest } from 'next/server';

/* ========================================================================== */
/* Cấu hình                                                                   */
/* ========================================================================== */

const IS_PROD = process.env.NODE_ENV === 'production';

/** Danh sách host tin cậy: lấy từ env, KHÔNG dùng wildcard *.vercel.app. */
function allowedHosts(): Set<string> {
  const hosts = new Set<string>(['localhost', '127.0.0.1', '[::1]', 'quyettamvmo.vercel.app']);
  const fromEnv = (process.env.ALLOWED_ORIGIN_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of fromEnv) hosts.add(h);
  for (const key of ['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL', 'VERCEL_BRANCH_URL']) {
    const v = process.env[key];
    if (v) hosts.add(v.replace(/^https?:\/\//, '').toLowerCase());
  }
  return hosts;
}

/* ========================================================================== */
/* Client IP                                                                  */
/* ========================================================================== */

/**
 * Thứ tự ưu tiên: header do PLATFORM ghi (client không giả được) trước,
 * x-forwarded-for sau cùng và lấy hop CUỐI (hop do proxy gần nhất thêm vào).
 */
export function getClientIp(req: NextRequest): string {
  const direct =
    req.headers.get('x-vercel-forwarded-for') ??
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-real-ip');
  if (direct?.trim()) return direct.split(',')[0].trim();

  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    // Hop cuối = do proxy tin cậy gần nhất ghi; hop đầu có thể do client bơm vào.
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return '0.0.0.0';
}

/* ========================================================================== */
/* Origin / CSRF                                                              */
/* ========================================================================== */

export function checkSameOrigin(req: NextRequest): boolean {
  const hosts = allowedHosts();
  const host = req.headers.get('host')?.toLowerCase() ?? null;

  const matches = (raw: string | null): boolean => {
    if (!raw) return false;
    try {
      const url = new URL(raw);
      const hostname = url.hostname.toLowerCase();
      if (host && url.host.toLowerCase() === host) return true;
      return hosts.has(hostname) || hosts.has(url.host.toLowerCase());
    } catch {
      return false;
    }
  };

  const site = req.headers.get('sec-fetch-site');
  const origin = req.headers.get('origin');

  // `same-origin` là tín hiệu đáng tin nhất (browser tự ghi, JS không sửa được).
  if (site === 'same-origin') return true;
  // `same-site` và `none` KHÔNG được coi là đủ: subdomain khác hoặc điều hướng
  // trực tiếp đều rơi vào đây.
  if (origin) return matches(origin);
  if (site === 'cross-site') return false;

  // Không có Origin: fetch không phải browser. Chỉ cho qua ngoài production.
  if (!IS_PROD) return true;
  return matches(req.headers.get('referer'));
}

export const verifySameOrigin = checkSameOrigin;

/* ========================================================================== */
/* Rate limit (in-memory, CÓ dọn rác)                                         */
/* ========================================================================== */

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_TRACKED_KEYS = 10_000;
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 30_000) return;
  lastSweep = now;
  for (const [key, b] of buckets) {
    if (now > b.resetAt) buckets.delete(key);
  }
  // Chặn tăng trưởng vô hạn: Map trong Edge isolate sống rất lâu.
  if (buckets.size > MAX_TRACKED_KEYS) {
    const excess = buckets.size - MAX_TRACKED_KEYS;
    let i = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++i >= excess) break;
    }
  }
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
}

/**
 * CẢNH BÁO: bộ đếm này nằm trong RAM của MỘT isolate. Trên Vercel Edge,
 * mỗi region/instance có bộ đếm riêng => giới hạn thực tế = limit × số instance.
 * Đây chỉ là lớp chống spam thô. Giới hạn thật cần Upstash Redis / Vercel KV.
 */
export function checkRateLimit(key: string, limit = 60, windowMs = 60_000): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || now > existing.resetAt) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { ok: true, remaining: limit - 1, resetAt, retryAfterSec: 0 };
  }

  if (existing.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      resetAt: existing.resetAt,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return {
    ok: true,
    remaining: limit - existing.count,
    resetAt: existing.resetAt,
    retryAfterSec: 0,
  };
}

/* ========================================================================== */
/* Access code                                                                */
/* ========================================================================== */

/** So sánh constant-time: chỉ lộ độ dài, không lộ nội dung qua thời gian chạy. */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export interface AuthResult {
  ok: boolean;
  authorized: boolean;
  status?: number;
  error?: string;
}

export function verifyAccessAuth(req: NextRequest): AuthResult {
  const expected = (process.env.ACCESS_CODE ?? '').trim();

  if (!expected) {
    return { ok: true, authorized: true };
  }

  const header = req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { ok: false, authorized: false, status: 401, error: 'Thiếu mã truy cập.' };
  if (timingSafeEqual(token, expected)) return { ok: true, authorized: true };

  return { ok: false, authorized: false, status: 401, error: 'Mã truy cập (Access Code) không chính xác.' };
}

/* ========================================================================== */
/* Cổng vào duy nhất cho route handler                                        */
/* ========================================================================== */

export interface GateResult {
  ok: boolean;
  response?: Response;
  ip: string;
}

export function gateRequest(
  req: NextRequest,
  opts: { limit?: number; windowMs?: number } = {},
): GateResult {
  const ip = getClientIp(req);

  const deny = (status: number, error: string, headers?: HeadersInit) => ({
    ok: false as const,
    ip,
    response: new Response(JSON.stringify({ error }), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...(headers ?? {}) },
    }),
  });

  if (!checkSameOrigin(req)) return deny(403, 'Origin không được phép.');

  const auth = verifyAccessAuth(req);
  if (!auth.ok) return deny(auth.status ?? 401, auth.error ?? 'Unauthorized');

  const rl = checkRateLimit(ip, opts.limit ?? 60, opts.windowMs ?? 60_000);
  if (!rl.ok) {
    return deny(429, 'Bạn gửi quá nhanh, vui lòng thử lại sau.', {
      'retry-after': String(rl.retryAfterSec),
      'x-ratelimit-reset': String(rl.resetAt),
    });
  }

  return { ok: true, ip };
}