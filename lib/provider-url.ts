/**
 * Helper thuần cho provider presets — KHÔNG import gì (dùng được cả
 * client lẫn edge server route). Tách riêng để route không kéo Dexie.
 */

import { parseModelReasoning, type ReasoningCapability } from '@/lib/reasoning-capability';

export type { ReasoningCapability };

export interface ProviderModel {
  id: string;
  name?: string;
  contextLength?: number;
  /** Metadata suy luận kiểu OpenRouter — có khi gateway khai báo. */
  reasoning?: ReasoningCapability;
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
  // Bổ sung defense-in-depth (khớp web-url-guard): link-local metadata của
  // cloud (169.254.169.254 = credentials!), CGNAT, IPv6 ULA/link-local,
  // IPv4-mapped IPv6 — BYOK nhập được nên phải chặn như input user.
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^\[::ffff:/i,
  /^\[f[cd]/i,
  /^\[fe[89ab]/i,
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
 * Mức suy luận một số gateway nhận qua `reasoning_effort` (alias `thinking_level`).
 * Chỉ gateway hỗ trợ mới dịch giá trị này; gateway khác bỏ qua hoặc trả 400.
 */
export const THINKING_LEVELS = ['low', 'medium', 'high', 'max'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'high';

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Tầng gateway (nơi duy nhất đổi mức suy luận bằng fast-path) đã gỡ.
 * Mức suy luận giờ chỉ tra qua metadata kiểu OpenRouter (model-reasoning-cache).
 */
export function supportsThinkingLevel(baseUrl: string | null | undefined): boolean {
  void baseUrl;
  return false;
}

/**
 * Model media built-in đã gỡ khỏi catalog — khả năng media chỉ còn đến từ
 * /v1/models của provider người dùng (phát hiện qua tên model).
 */
export function supportsMediaGeneration(baseUrl: string | null | undefined): boolean {
  void baseUrl;
  return false;
}

/**
 * Mọi provider đều cần key BYOK (ô nhập key luôn hiện). Hàm giữ lại vì
 * nhiều nơi gọi; NO_AUTH_HOSTS rỗng là mặc định an toàn.
 */
export function providerNeedsApiKey(baseUrl: string | null | undefined): boolean {
  void baseUrl;
  return true;
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
    const reasoning = parseModelReasoning(item);
    out.push({
      id,
      ...(typeof m.name === 'string' && m.name ? { name: m.name } : {}),
      ...(typeof ctxRaw === 'number' && ctxRaw > 0 ? { contextLength: ctxRaw } : {}),
      ...(reasoning ? { reasoning } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
