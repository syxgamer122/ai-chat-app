/**
 * Pollinations.AI — tạo ảnh MIỄN PHÍ không key không signup (nguồn: danh sách
 * free-for-dev, mã nguồn mở github.com/pollinations/pollinations).
 *
 * API dạng GET-URL: chính URL là kết quả — nhúng thẳng vào markdown <img> là
 * ảnh tự sinh khi trình duyệt tải. Dùng làm LỰA CHỌN CUỐI trong /api/chat khi
 * gateway chính không trả ảnh (hết quota/không hỗ trợ): tính năng "tạo ảnh"
 * nhờ vậy luôn hoạt động.
 */

const POLLINATIONS_BASE = 'https://image.pollinations.ai';
/** Trần ký tự prompt trong URL — quá dài cả CDN lẫn model đều bỏ. */
export const POLLINATIONS_PROMPT_CHARS = 380;

export interface PollinationsOptions {
  width?: number;
  height?: number;
  /** Đổi seed để cùng prompt ra ảnh khác nhau. */
  seed?: number;
}

function clampDim(v: number | undefined, fallback: number): number {
  if (!v || !Number.isFinite(v)) return fallback;
  return Math.min(2048, Math.max(256, Math.round(v)));
}

/** Dựng URL sinh ảnh. Prompt rỗng sau khi cắt → null. */
export function pollinationsImageUrl(
  prompt: string,
  opts: PollinationsOptions = {},
): string | null {
  const clean = (prompt ?? '').trim().slice(0, POLLINATIONS_PROMPT_CHARS);
  if (!clean) return null;
  const params = new URLSearchParams({
    width: String(clampDim(opts.width, 1024)),
    height: String(clampDim(opts.height, 1024)),
    nologo: 'true',
    ...(opts.seed != null && Number.isFinite(opts.seed) ? { seed: String(Math.floor(opts.seed)) } : {}),
  });
  return `${POLLINATIONS_BASE}/prompt/${encodeURIComponent(clean)}?${params.toString()}`;
}

/** Markdown hoàn chỉnh ghi vào tin nhắn assistant; prompt rỗng → null. */
export function pollinationsMarkdown(prompt: string, modelLabel = 'pollinations-flux'): string | null {
  const url = pollinationsImageUrl(prompt);
  return url ? `\n\n![${modelLabel}](${url})\n` : null;
}
