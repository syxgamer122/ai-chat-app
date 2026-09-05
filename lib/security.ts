import type { NextRequest } from 'next/server';

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Số proxy hop tin cậy ở trước app. Client IP thật = phần tử TRÁI NHẤT của
 * x-forwarded-for; chạy thẳng không qua proxy thì đặt TRUSTED_PROXY_HOPS=0.
 */
const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS ?? '1');

function allowedHosts(): Set<string> {
  const hosts = new Set<string>(['localhost', '127.0.0.1', '[::1]']);
  const fromEnv = (process.env.ALLOWED_ORIGIN_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of fromEnv) hosts.add(h);
  return hosts;
}

function isValidIp(v: string): boolean {
  if (!v) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return true;
  return v.includes(':') && /^[0-9a-fA-F:.\[\]]+$/.test(v);
}

/**
 * FIX BUG 1b: trước đây trả về hops[hops.length - 1] (IP của proxy)
 * => mọi user dùng chung 1 bucket rate-limit => 429 tập thể.
 */
export function getClientIp(req: NextRequest | Request): string {
  const headers = req.headers;

  /* Hardening: cf-connecting-ip / x-real-ip là header CLIENT GỬI ĐƯỢC nếu
     không đứng sau proxy tương ứng — kẻ tấn công xoay header mỗi request để
     đổi bucket rate-limit, brute-force ACCESS_CODE miễn phí. Mặc định chỉ
     tin x-forwarded-for (đã trừ hop tin cậy). Self-host sau Cloudflare:
     đặt TRUST_PROXY_IP_HEADERS=1. */
  const trustExtraIpHeaders = process.env.TRUST_PROXY_IP_HEADERS === '1';
  const direct = trustExtraIpHeaders
    ? headers.get('cf-connecting-ip') ?? headers.get('x-real-ip')
    : null;
  if (direct?.trim()) {
    const candidate = direct.split(',')[0].trim();
    if (isValidIp(candidate)) return candidate;
  }

  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) {
      // Bỏ đúng số hop proxy tin cậy tính từ PHẢI sang, lấy phần tử còn lại ngoài cùng bên phải.
      const idx = Math.max(0, hops.length - 1 - TRUSTED_PROXY_HOPS);
      const candidate = hops[idx] ?? hops[0];
      if (isValidIp(candidate)) return candidate;
      if (isValidIp(hops[0])) return hops[0];
    }
  }

  return '0.0.0.0';
}export const normalizeIp = (ip: string): string => ip;

export function checkSameOrigin(req: NextRequest | Request): boolean {
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

  if (site === 'same-origin') return true;
  if (origin) return matches(origin);
  if (site === 'cross-site') return false;
  if (!IS_PROD) return true;
  return matches(req.headers.get('referer'));
}

export const verifySameOrigin = checkSameOrigin;

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_TRACKED_KEYS = 10_000;
const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < 60_000 && buckets.size < MAX_TRACKED_KEYS) return;
  lastSweep = now;
  for (const [key, b] of buckets) {
    if (now > b.resetAt) buckets.delete(key);
  }
  if (buckets.size > MAX_TRACKED_KEYS) {
    let excess = buckets.size - MAX_TRACKED_KEYS;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (--excess <= 0) break;
    }
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** Alias của `ok`. Giữ để mọi call-site cũ dùng `{ allowed }` không âm thầm hỏng. */
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
}

function result(
  ok: boolean,
  limit: number,
  remaining: number,
  resetAt: number,
  retryAfterSec: number,
): RateLimitResult {
  return { ok, allowed: ok, limit, remaining, resetAt, retryAfterSec };
}

/**
 * Rate limit in-memory, per-isolate (Edge). KHÔNG chính xác toàn cục.
 * Dùng làm lớp chống spam nhẹ; nếu cần chính xác hãy chuyển sang Upstash Redis.
 */
export function checkRateLimit(key: string, limit = 60, windowMs = 60_000): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || now > existing.resetAt) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return result(true, limit, limit - 1, resetAt, 0);
  }

  if (existing.count >= limit) {
    return result(
      false,
      limit,
      0,
      existing.resetAt,
      Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    );
  }

  existing.count += 1;
  return result(true, limit, limit - existing.count, existing.resetAt, 0);
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  const h: Record<string, string> = {
    'X-RateLimit-Limit': String(r.limit),
    'X-RateLimit-Remaining': String(r.remaining),
    'X-RateLimit-Reset': String(Math.ceil(r.resetAt / 1000)),
  };
  if (!r.ok) h['Retry-After'] = String(r.retryAfterSec);
  return h;
}

export function timingSafeEqual(a: string, b: string): boolean {
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

export function verifyAccessAuth(req: NextRequest | Request): AuthResult {
  const expected = (process.env.ACCESS_CODE ?? '').trim();
  if (!expected) return { ok: true, authorized: true };

  const header = req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (token && timingSafeEqual(token, expected)) return { ok: true, authorized: true };

  /* Fallback hợp đồng client: useChat gửi mã qua header x-access-code
     (không phải Authorization Bearer) — chat/compact/title đều đi qua đây.
     Thiếu nhánh này, đặt ACCESS_CODE = toàn bộ route trả 401 (bug B1). */
  const alt = req.headers.get('x-access-code')?.trim() ?? '';
  if (alt && timingSafeEqual(alt, expected)) return { ok: true, authorized: true };

  if (!token && !alt) return { ok: false, authorized: false, status: 401, error: 'Thiếu mã truy cập.' };
  return { ok: false, authorized: false, status: 401, error: 'Mã truy cập (Access Code) không chính xác.' };
}

/** Định danh bucket ổn định: ưu tiên access token (đã hash) rồi mới tới IP. */
export function rateLimitIdentity(req: NextRequest | Request): string {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (token) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `u_${(h >>> 0).toString(36)}`;
  }
  return `ip_${getClientIp(req)}`;
}