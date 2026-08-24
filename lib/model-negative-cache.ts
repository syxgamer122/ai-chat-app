/**
 * Negative cache (upstream, model) — nhớ "gateway X không có model Y" trong
 * một khoảng TTL ngắn.
 *
 * Không có cái này, mỗi tin nhắn đều phải lặp lại lượt thử chết: crax trả
 * 404/400 "unknown model" cho tên gốc (vd `gpt-5.6-sol` khi họ chỉ có bản
 * gạch), route fallback sang tên kế — nhưng tin nhắn SAU lại bắt đầu từ tên
 * gốc và đốt thêm một request oan. Với cache này, request sau bỏ qua tên đã
 * biết là chết ngay từ đầu dựng chain.
 *
 * Ý tưởng port từ Free-Claude-Gateway (negative-capability cache):
 * "gateway thiếu model" là thông tin THEO MODEL, tách khỏi sức khoẻ KEY
 * (lib/api-keys.ts) — một gateway thiếu model A vẫn khoẻ mạnh với model B.
 * Hết TTL thì xoá ghi chú: nếu gateway bổ sung model sẽ tự được dùng lại.
 *
 * Module-level Map, sống theo isolate của Edge runtime — cùng cấp độ bền với
 * keyHealthMap của api-keys. State mất khi isolate tái khởi động: chấp nhận,
 * vì đây chỉ là tối ưu bỏ qua, không phải nguồn sự thật.
 */

const MODEL_UNSUPPORTED_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 512;

/** key chuẩn hoá -> thời điểm (epoch ms) ghi chú hết hạn. */
const unsupportedUntil = new Map<string, number>();

export function modelCacheKey(baseUrl: string, model: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    // baseUrl không parse được — dùng nguyên giá trị, vẫn nhất quán giữa mark/check.
  }
  return `${host}::${model.toLowerCase()}`;
}

export function markModelUnsupported(
  baseUrl: string,
  model: string,
  ttlMs: number = MODEL_UNSUPPORTED_TTL_MS,
  now: number = Date.now(),
): void {
  if (!baseUrl || !model) return;
  if (unsupportedUntil.size >= MAX_ENTRIES) {
    const nowMs = now;
    for (const [key, until] of unsupportedUntil) {
      if (until <= nowMs) unsupportedUntil.delete(key); // dọn hết mục hết hạn trước
    }
    while (unsupportedUntil.size >= MAX_ENTRIES) {
      // Map giữ thứ tự chèn — xoá mục cũ nhất.
      const oldest = unsupportedUntil.keys().next().value;
      if (oldest === undefined) break;
      unsupportedUntil.delete(oldest);
    }
  }
  unsupportedUntil.set(modelCacheKey(baseUrl, model), now + ttlMs);
}

export function isModelUnsupported(
  baseUrl: string,
  model: string,
  now: number = Date.now(),
): boolean {
  if (!baseUrl || !model) return false;
  const key = modelCacheKey(baseUrl, model);
  const until = unsupportedUntil.get(key);
  if (until === undefined) return false;
  if (until <= now) {
    unsupportedUntil.delete(key);
    return false;
  }
  return true;
}

/**
 * Lọc chuỗi model, bỏ những tên đang bị đánh dấu chết trên `baseUrl`.
 * Nếu lọc sạch (sẽ không còn gì để thử) thì trả nguyên chuỗi gốc — vẫn phải
 * thử lại để có cơ hội phục hồi và để người dùng nhận được lỗi thật thay vì
 * lỗi "không còn model".
 */
export function filterSupportedModels(
  baseUrl: string,
  models: readonly string[],
  now: number = Date.now(),
): string[] {
  if (!baseUrl || models.length <= 1) return [...models];
  const alive = models.filter((m) => !isModelUnsupported(baseUrl, m, now));
  return alive.length ? alive : [...models];
}

/** Dùng cho test — xoá sạch state giữa các case. */
export function resetModelNegativeCache(): void {
  unsupportedUntil.clear();
}
