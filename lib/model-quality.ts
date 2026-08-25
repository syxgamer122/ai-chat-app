/**
 * Model quality score (EWMA) — điểm tin cậy mượt theo thời gian cho từng
 * (gateway, model), dùng SẮP XẾP MỀM chuỗi model fallback.
 *
 * Vì sao EWMA mà không đếm thô: gateway free dao động theo giờ — model tốt
 * sáng nay có thể tốn kém chiều nay. EWMA α=0.2 nghĩa là ~5 lần quan sát
 * gần nhất chiếm ~67% trọng số: trạng thái mới luôn thắng trạng thái cũ,
 * không cần TTL thủ công.
 *
 * - Thành công → kéo điểm về 1; thất bại → về 0. Cold-start = 0.5 trung tính
 *   (model chưa từng chạy không bị ưu tiên cũng không bị ghét).
 * - Sắp xếp là SOFT-PREFERENCE: chênh lệch dưới DEAD_ZONE coi như ngang —
   giữ nguyên thứ tự gốc. Nhờ vậy model chính theo thiết kế (capability/
   cost) chỉ nhường chỗ khi model kia TIN CẬY RÕ RỆT hơn, không nhảy loạn
   sau 1-2 lần may/mắn.
 *
 * Pattern port từ OmniRoute `open-sse/services/routing/quality.ts` (EWMA
 * α=0.2, neutral 0.5) — thu gọn bỏ confidence-clamp theo sample count vì
 * dead-zone đã đủ chống nhiễu ở quy mô single-user.
 */

const ALPHA = 0.2;
/** Chênh điểm nhỏ hơn ngưỡng này coi như ngang nhau khi sắp xếp. */
const DEAD_ZONE = 0.15;
/** Điểm trung tính khi chưa có dữ liệu quan sát. */
export const NEUTRAL = 0.5;
const MAX_ENTRIES = 512;

const scores = new Map<string, number>();

function scoreKey(baseUrl: string, model: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    // baseUrl không parse được — dùng nguyên giá trị.
  }
  return `${host}::${model.toLowerCase()}`;
}

export function recordModelOutcome(
  baseUrl: string,
  model: string,
  ok: boolean,
): void {
  if (!baseUrl || !model) return;
  prune();
  const key = scoreKey(baseUrl, model);
  const prev = scores.get(key) ?? NEUTRAL;
  const next = prev + ALPHA * ((ok ? 1 : 0) - prev);
  scores.set(key, next);
}

/** Điểm hiện tại; chưa từng quan sát thì trả NEUTRAL (không ghi vào map). */
export function getModelQualityScore(baseUrl: string, model: string): number {
  return scores.get(scoreKey(baseUrl, model)) ?? NEUTRAL;
}

/**
 * Sắp xếp lại chuỗi model theo điểm tin cậy (cao → thấp). Stable sort +
 * dead-zone: cặp model chênh < DEAD_ZONE giữ nguyên thứ tự khai báo.
 */
export function reorderModelsByQuality(
  baseUrl: string,
  models: readonly string[],
): string[] {
  if (!baseUrl || models.length <= 1) return [...models];
  return models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => {
      const sa = getModelQualityScore(baseUrl, a.model);
      const sb = getModelQualityScore(baseUrl, b.model);
      if (Math.abs(sa - sb) < DEAD_ZONE) return a.index - b.index;
      return sb - sa;
    })
    .map((x) => x.model);
}

function prune(): void {
  if (scores.size < MAX_ENTRIES) return;
  // Map không có timestamp per-entry — xoá lũy tiến mục chèn sớm nhất.
  while (scores.size >= MAX_ENTRIES) {
    const oldest = scores.keys().next().value;
    if (oldest === undefined) break;
    scores.delete(oldest);
  }
}

/** Dùng cho test — xoá sạch state giữa các case. */
export function resetModelQuality(): void {
  scores.clear();
}
