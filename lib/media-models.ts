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

export interface MediaModelChoice {
  id: string;
  label: string;
}

export interface MediaModelPick {
  image?: MediaModelChoice;
  video?: MediaModelChoice;
}

/**
 * Chọn 1 model ảnh + 1 model video từ danh sách của provider.
 * Ưu tiên model đứng đầu danh sách sau khi sắp xếp giảm dần theo id — id có số
 * phiên bản lớn hơn (qwen-image-3.0 > 2.0) được chọn làm mặc định.
 */
export function pickMediaModels(models: readonly MediaModelChoice[]): MediaModelPick {
  const image: MediaModelChoice[] = [];
  const video: MediaModelChoice[] = [];

  for (const m of models) {
    const kind = detectMediaKind(m.id, m.label);
    if (kind === 'video') video.push(m);
    else if (kind === 'image') image.push(m);
  }

  const best = (list: MediaModelChoice[]): MediaModelChoice | undefined =>
    [...list].sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))[0];

  return {
    ...(image.length ? { image: best(image) } : {}),
    ...(video.length ? { video: best(video) } : {}),
  };
}

/**
 * "Họ" model = token chữ đầu tiên của id, bỏ số phiên bản.
 * qwen3.8-max -> qwen | qwen-image-3.0-pro -> qwen | gpt-5.6-sol -> gpt
 * Dùng để chỉ hiện nút tạo ảnh/video khi model đang chọn cùng họ với model
 * media của gateway (crax: media do Qwen đảm nhiệm).
 */
export function modelFamily(modelId: string | null | undefined): string {
  if (!modelId) return '';
  // Bỏ tiền tố vendor kiểu OpenRouter ("qwen/qwen3-max" -> "qwen3-max").
  const tail = modelId.split('/').pop() ?? modelId;
  const token = tail.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] ?? '';
  return token.replace(/[0-9.]+$/, '');
}

/** true khi model đang chọn cùng họ với model ảnh/video khả dụng. */
export function isSameFamilyAsMedia(
  modelId: string | null | undefined,
  picked: MediaModelPick,
): boolean {
  const family = modelFamily(modelId);
  if (!family) return false;
  // Bản thân model đang chọn là model media -> luôn cho hiện nút.
  if (detectMediaKind(modelId ?? undefined)) return true;
  return [picked.image, picked.video].some(
    (m) => m !== undefined && modelFamily(m.id) === family,
  );
}
