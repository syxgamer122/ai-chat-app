type KeyState = { failUntil: number; fails: number };
const state = new Map<string, KeyState>();
let cursor = 0;

/** Lấy danh sách toàn bộ API keys hợp lệ từ biến môi trường. */
export function getAllApiKeys(): string[] {
  const raw = process.env.OPENAI_API_KEYS || process.env.OPENAI_API_KEY || '';
  return [...new Set(raw.split(/[,\s]+/).map((k) => k.trim()).filter(Boolean))];
}

/**
 * Trả về danh sách ứng viên key để failover trong CÙNG một request.
 * Đảm bảo phân phối đều và xếp các key đang cooldown xuống cuối.
 */
export function getKeyCandidates(): string[] {
  const all = getAllApiKeys();
  if (!all.length) return [];
  const start = (cursor++) % all.length;
  const rotated = [...all.slice(start), ...all.slice(0, start)];
  const now = Date.now();
  const fresh = rotated.filter((k) => (state.get(k)?.failUntil ?? 0) <= now);
  const cooling = rotated
    .filter((k) => (state.get(k)?.failUntil ?? 0) > now)
    .sort((a, b) => state.get(a)!.failUntil - state.get(b)!.failUntil);
  return [...fresh, ...cooling];
}

/**
 * Kiểm tra xem lỗi HTTP có thể retry/failover sang key khác được không.
 */
export function isRetryableProviderStatus(status?: number): boolean {
  // Lỗi mạng hoặc HTTP status retryable
  if (status === undefined) return true;
  return (
    status === 408 || // Request Timeout
    status === 409 || // Conflict
    status === 425 || // Too Early
    status === 429 || // Rate Limit / Quota
    status === 500 || // Internal Server Error
    status === 502 || // Bad Gateway
    status === 503 || // Service Unavailable
    status === 504    // Gateway Timeout
  );
}

/**
 * Chỉ đưa key vào cooldown nếu lỗi thực sự xuất phát từ key (Auth 401/403) hoặc từ phía Provider (429/5xx).
 * Tuyệt đối không cooldown key nếu lỗi do Client (400 Bad Request, 404 Model Not Found, 422 Invalid Params).
 */
export function shouldCooldownKey(status?: number): boolean {
  if (status === undefined) return true;
  return status === 401 || status === 403 || isRetryableProviderStatus(status);
}

/**
 * Kiểm tra lỗi vĩnh viễn từ phía client (400, 404, 422) — đổi key khác cũng sẽ thất bại giống nhau.
 */
export function isPermanentClientError(status?: number): boolean {
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 408 &&
    status !== 409 &&
    status !== 425 &&
    status !== 429
  );
}

/** Đánh dấu một key trong pool bị lỗi với exponential backoff. */
export function markKeyFailure(key: string, status?: number): void {
  if (!key || !getAllApiKeys().includes(key)) return;
  if (!shouldCooldownKey(status)) return; // Bỏ qua nếu là lỗi client (400/404/422)

  const fails = (state.get(key)?.fails ?? 0) + 1;
  const isAuthError = status === 401 || status === 403;
  const base = isAuthError ? 3_600_000 : 60_000;
  const cap = isAuthError ? 21_600_000 : 1_800_000; // Auth: tối đa 6h, Rate Limit: tối đa 30m

  state.set(key, {
    fails,
    failUntil: Date.now() + Math.min(base * 2 ** (fails - 1), cap),
  });
}

/** Đánh dấu key hoạt động thành công -> giải phóng cooldown. */
export function markKeySuccess(key: string): void {
  state.delete(key);
}

/** Định danh key an toàn khi ghi log server. */
export function getKeyLabel(key: string): string {
  const all = getAllApiKeys();
  const idx = all.indexOf(key);
  return idx !== -1 ? `pool-key#${idx + 1}` : 'custom-key';
}
