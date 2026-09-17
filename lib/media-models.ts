/**
 * Nhận diện model sinh ảnh / video trong danh sách model của một nhà cung cấp.
 * Module thuần (không import gì) để dùng được cả ở client và edge route.
 */

export type MediaKind = 'image' | 'video';

/** Đặt trước IMAGE_RE khi kiểm tra: "…-video…" luôn là video dù có chữ "image". */
const VIDEO_RE = /(^|[^a-z])(video|t2v|kling|seedance|sora|veo\d?|hailuo|vidu|jimeng|wan2?[-.]?\d*[-.]?t2v)/i;

const IMAGE_RE =
  /(^|[^a-z])(image|images|t2i|flux|dall-?e|imagen|sdxl|stable-?diffusion|seedream|imggen|midjourney|grok-imagine)/i;

/** VL/OCR là model đọc ảnh (vision), không phải model tạo ảnh — loại sớm. */
const VISION_RE = /(^|[^a-z])(vl|vision|ocr)(\b|[^a-z])/i;

export function detectMediaKind(...parts: Array<string | undefined>): MediaKind | undefined {
  const text = parts.filter(Boolean).join(' ');
  if (!text) return undefined;
  if (VIDEO_RE.test(text)) return 'video';
  if (VISION_RE.test(text)) return undefined;
  if (IMAGE_RE.test(text)) return 'image';
  return undefined;
}

export function isRetiredMediaOption(m: { id: string; label: string; media?: MediaKind }): boolean {
  return Boolean(m.media ?? detectMediaKind(m.id, m.label));
}
