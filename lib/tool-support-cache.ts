/**
 * Negative cache "model này không hỗ trợ function calling" — tránh lặp lại
 * 1 lượt fail + retry mỗi tin nhắn với gateway/model đã biết chê tools.
 *
 * Cùng triết lý với lib/model-negative-cache nhưng tách riêng vì điều kiện
 * khác nhau (lỗi nhắc tool/function thay vì 404 unknown-model). TTL ngắn:
 * gateway có thể được nâng cấp giữa chừng — sau 10 phút thử lại.
 */

const TTL_MS = 10 * 60_000;
const entries = new Map<string, number>();

function key(base: string, model: string): string {
  return `${base || 'default'}::${model}`;
}

/** true nếu cặp base+model vừa bị đánh dấu chê tools trong TTL hiện tại. */
export function isToolUnsupported(base: string, model: string, now = Date.now()): boolean {
  const at = entries.get(key(base, model));
  if (at === undefined) return false;
  if (now - at >= TTL_MS) {
    entries.delete(key(base, model));
    return false;
  }
  return true;
}

export function markToolsUnsupported(base: string, model: string, now = Date.now()): void {
  // Chống phình: vượt 100 entry thì dọn hết các entry hết hạn.
  if (entries.size >= 100) {
    for (const [k, at] of entries) {
      if (now - at >= TTL_MS) entries.delete(k);
    }
  }
  entries.set(key(base, model), now);
}

/** Test helper. */
export function resetToolSupportCache(): void {
  entries.clear();
}
