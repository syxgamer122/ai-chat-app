const disabledKeys = new Map<string, number>();
let keyCursor = 0;

/**
 * Lấy danh sách toàn bộ API keys từ biến môi trường.
 * Hỗ trợ OPENAI_API_KEYS (ngăn cách bằng dấu phẩy hoặc xuống dòng)
 * hoặc OPENAI_API_KEY đơn lẻ (cũng có thể chứa dấu phẩy).
 */
export function getAllApiKeys(): string[] {
  const raw = process.env.OPENAI_API_KEYS || process.env.OPENAI_API_KEY || '';
  return raw
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/**
 * Lấy danh sách các key còn hoạt động (không bị blacklist tạm thời do hết quota/token).
 */
export function getActiveApiKeys(): string[] {
  const all = getAllApiKeys();
  const now = Date.now();
  const valid = all.filter((k) => {
    const until = disabledKeys.get(k);
    if (!until) return true;
    if (now > until) {
      disabledKeys.delete(k);
      return true;
    }
    return false;
  });
  return valid.length > 0 ? valid : all;
}

/**
 * Lấy API key tiếp theo theo thuật toán Round-Robin để chia đều tải cho các tài khoản.
 */
export function getNextApiKey(): string {
  const keys = getActiveApiKeys();
  if (!keys.length) return '';
  keyCursor = (keyCursor + 1) % keys.length;
  return keys[keyCursor];
}

/**
 * Đánh dấu một key bị lỗi quota/token limit để tạm dừng dùng trong 10 phút.
 */
export function markKeyRateLimited(key: string, durationMs = 10 * 60 * 1000): void {
  if (!key) return;
  disabledKeys.set(key, Date.now() + durationMs);
  console.warn(`[KeyManager] Key ...${key.slice(-6)} bị đánh dấu tạm ngưng dùng trong ${Math.round(durationMs / 1000)}s`);
}
