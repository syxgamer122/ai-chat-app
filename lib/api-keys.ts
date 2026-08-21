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

/** Đánh dấu một key trong pool bị lỗi với exponential backoff. Tuyệt đối không lưu custom key của user. */
export function markKeyFailure(key: string, status?: number): void {
  if (!key || !getAllApiKeys().includes(key)) return; // Bảo vệ bộ nhớ: không bao giờ blacklist key riêng của user
  const fails = (state.get(key)?.fails ?? 0) + 1;
  const base = status === 401 || status === 403 ? 3_600_000 : 60_000;
  state.set(key, {
    fails,
    failUntil: Date.now() + Math.min(base * 2 ** (fails - 1), 1_800_000),
  });
}

/** Đánh dấu key hoạt động thành công -> giải phóng cooldown. */
export function markKeySuccess(key: string): void {
  state.delete(key);
}

/** Định danh key an toàn khi ghi log server (không ghi lộ token/suffix của user). */
export function getKeyLabel(key: string): string {
  const all = getAllApiKeys();
  const idx = all.indexOf(key);
  return idx !== -1 ? `pool-key#${idx + 1}` : 'custom-key';
}
