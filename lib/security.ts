interface RateLimitBucket {
  timestamps: number[];
}

const memoryBuckets = new Map<string, RateLimitBucket>();
const MAX_MEMORY_BUCKETS = 5000;
const CLEANUP_INTERVAL = 60_000;
let lastCleanup = Date.now();

const FALLBACK_IP = '127.0.0.1';
const VERCEL_SUFFIX = '.vercel.app';

/* ------------------------------------------------------------------ */
/* IP helpers                                                          */
/* ------------------------------------------------------------------ */

export function normalizeIp(raw: string): string {
  const ip = raw.trim().toLowerCase();
  if (!ip || ip.length > 64) return FALLBACK_IP;

  const cleanIp = ip.replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '');
  if (!/^[a-f0-9:.]+$/i.test(cleanIp)) {
    return FALLBACK_IP;
  }

  if (cleanIp.includes(':')) {
    const parts = cleanIp.split(':');
    if (parts.length >= 4) {
      return `${parts.slice(0, 4).join(':')}::/64`;
    }
  }

  return cleanIp;
}

export function getClientIp(req: Request): string {
  const vercelIp = req.headers.get('x-vercel-forwarded-for');
  if (vercelIp) return normalizeIp(vercelIp.split(',')[0]);

  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp) return normalizeIp(cfIp);

  const realIp = req.headers.get('x-real-ip');
  if (realIp) return normalizeIp(realIp);

  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return normalizeIp(forwarded.split(',')[0]);

  return FALLBACK_IP;
}

/* ------------------------------------------------------------------ */
/* Same-Origin                                                         */
/* ------------------------------------------------------------------ */

export type OriginCheckCode =
  | 'OK_DEV'
  | 'OK_DISABLED'
  | 'OK_ALLOWLIST'
  | 'OK_SAME_VERCEL_PROJECT'
  | 'OK_SEC_FETCH'
  | 'OK_NO_ORIGIN'
  | 'OK_FAIL_OPEN'
  | 'BLOCK_CROSS_SITE'
  | 'BLOCK_ORIGIN_MISMATCH'
  | 'BLOCK_OPAQUE_ORIGIN';

export interface OriginCheckResult {
  allowed: boolean;
  code: OriginCheckCode;
  reason: string;
  debug: {
    origin: string | null;
    referer: string | null;
    host: string | null;
    forwardedHost: string | null;
    secFetchSite: string | null;
    allowedHosts: string[];
  };
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function envFlag(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? '').trim().toLowerCase());
}

/** Chuẩn hoá mọi dạng (URL đầy đủ, host:port, hostname) về hostname thuần, bỏ port. */
function toHostname(value?: string | null): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v || v === 'null' || v === 'undefined') return null;
  try {
    const url = v.includes('://') ? new URL(v) : new URL(`https://${v}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

function collectAllowedHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  const add = (v?: string | null) => {
    const h = toHostname(v);
    if (h) hosts.add(h);
  };

  // Domain sản xuất chính của ứng dụng
  add('quyettamvmo.vercel.app');

  add(req.headers.get('host'));
  for (const h of (req.headers.get('x-forwarded-host') ?? '').split(',')) add(h);

  // Các biến Vercel cung cấp sẵn cho runtime
  add(process.env.VERCEL_URL);
  add(process.env.VERCEL_BRANCH_URL);
  add(process.env.VERCEL_PROJECT_PRODUCTION_URL);

  // Domain tự khai báo (custom domain, staging...) — phân tách bằng dấu phẩy/space
  add(process.env.NEXT_PUBLIC_APP_URL);
  for (const item of (process.env.APP_ALLOWED_ORIGINS ?? '').split(/[\s,;]+/)) add(item);

  return hosts;
}

/**
 * Lấy "project token" từ các host *.vercel.app đã tin cậy.
 * quyettamvmo.vercel.app                  -> quyettamvmo
 * quyettamvmo-git-main-abc.vercel.app     -> quyettamvmo
 */
function vercelProjectTokens(hosts: Set<string>): Set<string> {
  const tokens = new Set<string>();
  for (const h of hosts) {
    if (!h.endsWith(VERCEL_SUFFIX)) continue;
    const token = h.slice(0, -VERCEL_SUFFIX.length).split('-')[0];
    if (token.length >= 3) tokens.add(token);
  }
  return tokens;
}

function isSameVercelProject(candidate: string | null, tokens: Set<string>): boolean {
  if (!candidate || !candidate.endsWith(VERCEL_SUFFIX) || tokens.size === 0) return false;
  const label = candidate.slice(0, -VERCEL_SUFFIX.length);
  for (const t of tokens) {
    if (label === t || label.startsWith(`${t}-`)) return true;
  }
  return false;
}

/**
 * Chống Open Proxy nhưng KHÔNG BAO GIỜ chặn nhầm domain hợp lệ.
 */
export function checkSameOrigin(req: Request): OriginCheckResult {
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  const host = req.headers.get('host');
  const forwardedHost = req.headers.get('x-forwarded-host');
  const secFetchSite = req.headers.get('sec-fetch-site');

  const allowedHosts = collectAllowedHosts(req);
  const debug = {
    origin,
    referer,
    host,
    forwardedHost,
    secFetchSite,
    allowedHosts: Array.from(allowedHosts),
  };

  if (process.env.NODE_ENV !== 'production') {
    return { allowed: true, code: 'OK_DEV', reason: 'Non-production environment.', debug };
  }

  // Van xả khẩn cấp: bật DISABLE_ORIGIN_CHECK=1 để loại trừ tầng này khi debug.
  if (envFlag('DISABLE_ORIGIN_CHECK')) {
    return { allowed: true, code: 'OK_DISABLED', reason: 'DISABLE_ORIGIN_CHECK=1.', debug };
  }

  // Không xác định được host hợp lệ nào -> fail-open (vẫn còn rate limit + access code).
  if (allowedHosts.size === 0) {
    return {
      allowed: true,
      code: 'OK_FAIL_OPEN',
      reason: 'Không xác định được host của deployment, bỏ qua kiểm tra origin.',
      debug,
    };
  }

  const originHost = toHostname(origin);
  const refererHost = toHostname(referer);
  const tokens = vercelProjectTokens(allowedHosts);

  // 1) Khớp allowlist -> cho qua bất kể sec-fetch-site.
  if (originHost && allowedHosts.has(originHost)) {
    return { allowed: true, code: 'OK_ALLOWLIST', reason: `origin=${originHost}`, debug };
  }
  if (!origin && refererHost && allowedHosts.has(refererHost)) {
    return { allowed: true, code: 'OK_ALLOWLIST', reason: `referer=${refererHost}`, debug };
  }

  // 2) Cùng project Vercel (preview deployment).
  if (isSameVercelProject(originHost, tokens) || (!origin && isSameVercelProject(refererHost, tokens))) {
    return { allowed: true, code: 'OK_SAME_VERCEL_PROJECT', reason: 'Cùng Vercel project.', debug };
  }

  // 3) Tín hiệu của trình duyệt hiện đại.
  if (secFetchSite === 'same-origin' || secFetchSite === 'none') {
    return { allowed: true, code: 'OK_SEC_FETCH', reason: `sec-fetch-site=${secFetchSite}`, debug };
  }

  // 4) Origin "null" (iframe sandbox, redirect lạ) khi không có tín hiệu nào khác.
  if (origin && !originHost) {
    return {
      allowed: false,
      code: 'BLOCK_OPAQUE_ORIGIN',
      reason: 'Origin rỗng/opaque và không khớp tín hiệu same-origin nào.',
      debug,
    };
  }

  // 5) Có origin/referer nhưng không khớp gì -> chặn.
  if (originHost || refererHost) {
    return {
      allowed: false,
      code: 'BLOCK_ORIGIN_MISMATCH',
      reason: `Origin '${originHost ?? refererHost}' không thuộc allowlist [${debug.allowedHosts.join(', ')}].`,
      debug,
    };
  }

  // 6) Không origin, không referer (curl, app native, một số webview).
  if (secFetchSite === 'cross-site') {
    return { allowed: false, code: 'BLOCK_CROSS_SITE', reason: 'sec-fetch-site=cross-site.', debug };
  }

  return {
    allowed: true,
    code: 'OK_NO_ORIGIN',
    reason: 'Client không gửi origin/referer; dựa vào rate limit + access code.',
    debug,
  };
}

/** Giữ tương thích ngược với code cũ. */
export function verifySameOrigin(req: Request): boolean {
  return checkSameOrigin(req).allowed;
}

/* ------------------------------------------------------------------ */
/* Access code                                                         */
/* ------------------------------------------------------------------ */

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function verifyAccessAuth(req: Request): {
  authorized: boolean;
  code?: 'ACCESS_CODE_MISSING' | 'ACCESS_CODE_INVALID';
  reason?: string;
} {
  const requiredPassword = process.env.APP_ACCESS_PASSWORD?.trim();
  if (!requiredPassword) return { authorized: true };

  const clientPassword =
    req.headers.get('x-access-code')?.trim() ||
    req.headers.get('x-app-password')?.trim() ||
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();

  if (!clientPassword) {
    return {
      authorized: false,
      code: 'ACCESS_CODE_MISSING',
      reason: 'App đang bật Mật khẩu truy cập nhưng client chưa gửi header x-access-code.',
    };
  }

  if (!safeEqual(clientPassword, requiredPassword)) {
    return {
      authorized: false,
      code: 'ACCESS_CODE_INVALID',
      reason: 'Mật khẩu truy cập (Access Code) không đúng.',
    };
  }

  return { authorized: true };
}

/* ------------------------------------------------------------------ */
/* Rate limit                                                          */
/* ------------------------------------------------------------------ */

export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; remaining: number; resetInSec: number }> {
  const now = Date.now();
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (upstashUrl && upstashToken) {
    try {
      const clearBefore = now - windowMs;
      const pipelineReq = await fetch(`${upstashUrl}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${upstashToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          ['ZREMRANGEBYSCORE', `rl:${key}`, 0, clearBefore],
          ['ZADD', `rl:${key}`, now, `${now}-${Math.random().toString(36).slice(2, 7)}`],
          ['ZCARD', `rl:${key}`],
          ['EXPIRE', `rl:${key}`, Math.ceil(windowMs / 1000) * 2],
        ]),
        cache: 'no-store',
      });

      if (pipelineReq.ok) {
        const results = await pipelineReq.json();
        const count = typeof results?.[2]?.result === 'number' ? results[2].result : 1;
        return {
          allowed: count <= limit,
          remaining: Math.max(0, limit - count),
          resetInSec: Math.ceil(windowMs / 1000),
        };
      }
    } catch {
      // rơi xuống in-memory
    }
  }

  if (now - lastCleanup > CLEANUP_INTERVAL) {
    lastCleanup = now;
    const threshold = now - 120_000;
    for (const [k, b] of memoryBuckets.entries()) {
      b.timestamps = b.timestamps.filter((t) => t > threshold);
      if (b.timestamps.length === 0) memoryBuckets.delete(k);
    }
  }

  let bucket = memoryBuckets.get(key);
  if (!bucket) {
    if (memoryBuckets.size >= MAX_MEMORY_BUCKETS) {
      const firstKey = memoryBuckets.keys().next().value;
      if (firstKey) memoryBuckets.delete(firstKey);
    }
    bucket = { timestamps: [] };
    memoryBuckets.set(key, bucket);
  }

  const windowStart = now - windowMs;
  bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0] ?? now;
    return {
      allowed: false,
      remaining: 0,
      resetInSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  bucket.timestamps.push(now);
  return {
    allowed: true,
    remaining: Math.max(0, limit - bucket.timestamps.length),
    resetInSec: Math.ceil(windowMs / 1000),
  };
}
