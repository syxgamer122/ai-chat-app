/**
 * Helper thuần cho provider presets — KHÔNG import gì (dùng được cả
 * client lẫn edge server route). Tách riêng để route không kéo Dexie.
 */

export interface ProviderModel {
  id: string;
  name?: string;
  contextLength?: number;
}

export type BaseUrlCheck =
  | { ok: true; url: string }
  | { ok: false; error: string };

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\.0\.0\.0$/,
  /\.local$/i,
  /^\[::1\]$/,
];

/**
 * Chấp nhận https:// bất kỳ (trừ hostname nội bộ) — và http://localhost
 * riêng cho dev. Trả về URL đã strip slash cuối để nối `/chat/completions`.
 */
export function validateProviderBaseUrl(input: string): BaseUrlCheck {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, error: 'Thiếu địa chỉ nhà cung cấp.' };
  if (raw.length > 300) return { ok: false, error: 'Địa chỉ quá dài.' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'Địa chỉ không hợp lệ (ví dụ: https://host/v1).' };
  }

  const isLocalHttp = url.protocol === 'http:' && /^localhost$/i.test(url.hostname);
  if (url.protocol !== 'https:' && !isLocalHttp) {
    return { ok: false, error: 'Chỉ chấp nhận https:// (http://localhost cho dev).' };
  }
  if (!isLocalHttp && PRIVATE_HOST_PATTERNS.some((p) => p.test(url.hostname))) {
    return { ok: false, error: 'Không cho phép địa chỉ mạng nội bộ.' };
  }

  return { ok: true, url: url.origin + url.pathname.replace(/\/+$/, '') };
}

/**
 * Mức suy luận crax nhận qua `reasoning_effort` (alias `thinking_level`).
 * Chỉ crax dịch giá trị này xuống backend; gateway khác bỏ qua hoặc trả 400.
 */
export const THINKING_LEVELS = ['low', 'medium', 'high', 'max'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Model Notion-backed của crax mặc định 'high' khi request không gửi gì. */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'high';

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** true khi baseUrl trỏ tới gateway crax — nơi duy nhất đổi được mức suy luận. */
export function supportsThinkingLevel(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return /(^|\.)crax\.lol$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * true khi gateway có sẵn model sinh ảnh/video built-in (crax: qwen-image-*,
 * qwen-video). Gateway khác vẫn dùng được nếu /v1/models của họ liệt kê model
 * media — phần đó phát hiện qua tên model, không qua hàm này.
 */
export function supportsMediaGeneration(baseUrl: string | null | undefined): boolean {
  return supportsThinkingLevel(baseUrl);
}

/**
 * Gateway miễn phí KHÔNG kiểm tra API key — xác thực bằng IP, không bằng key.
 * Kiểm chứng thực tế: `GET /v1/models` và `POST /v1/chat/completions` của
 * gpt.crax.lol trả 200 với key bất kỳ, key rác, hoặc không có header
 * Authorization; giới hạn tốc độ áp theo IP (bắn 8 request với 8 key khác nhau
 * vẫn nhận 429 từ request thứ 6). Kilgore hành xử giống vậy.
 *
 * Hệ quả UX: bắt người dùng dán key cho 2 host này là gây hiểu nhầm — họ tưởng
 * thiếu key nên mới bị 429, trong khi key không liên quan. Ô nhập key bị ẩn cho
 * các host này, và ngân sách dùng chung được quản ở `lib/upstream-queue.ts`.
 */
const NO_AUTH_HOSTS: readonly string[] = Object.freeze([
  'gpt.crax.lol',
  'kilgoreai.freesrv.com',
]);

/**
 * false = gateway không cần API key (miễn phí, chặn theo IP). Dùng để ẩn ô nhập
 * key trong Settings và để cho phép gọi thẳng từ trình duyệt dù không có key.
 */
export function providerNeedsApiKey(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return true;
  try {
    return !NO_AUTH_HOSTS.includes(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return true;
  }
}

/** Chuẩn hoá danh sách model từ GET /v1/models (dung sai nhiều dạng). */
export function normalizeProviderModels(json: unknown): ProviderModel[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: ProviderModel[] = [];
  for (const item of data) {
    const m = item as { id?: unknown; name?: unknown; context_length?: unknown; contextLength?: unknown };
    const id = typeof m?.id === 'string' ? m.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ctxRaw = (m.context_length ?? m.contextLength) as unknown;
    out.push({
      id,
      ...(typeof m.name === 'string' && m.name ? { name: m.name } : {}),
      ...(typeof ctxRaw === 'number' && ctxRaw > 0 ? { contextLength: ctxRaw } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
