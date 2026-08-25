/**
 * Cache capability suy luận (baseUrl → metadata /v1/models) cho route chat.
 *
 * Khi user chọn mức thinking trên provider override KHÔNG phải crax, route
 * cần biết model đó có hỗ trợ `reasoning_effort` không — thông tin nằm trong
 * metadata kiểu OpenRouter của chính gateway. Fetch /v1/models LƯỜI theo TTL:
 * chỉ xảy ra khi có thinkingLevel được gửi + gateway không phải crax; cache
 * theo isolate để các request sau trong cùng warm window không fetch lại.
 *
 * Module-level Map, sống theo isolate Edge — cùng cấp độ bền với negative
 * cache và keyHealthMap: chỉ là tối ưu, không phải nguồn sự thật.
 */

import { parseModelReasoning, type ReasoningCapability } from '@/lib/reasoning-capability';

const CAPABILITY_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 6_000;

interface CacheEntry {
  fetchedAt: number;
  /** modelId (lowercase) -> capability | null (null = khai báo không có). */
  caps: Map<string, ReasoningCapability | null>;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function baseKey(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return baseUrl.toLowerCase();
  }
}

async function fetchCapabilities(baseUrl: string): Promise<CacheEntry> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const json: unknown = await res.json().catch(() => null);
    const data = (json as { data?: unknown } | null)?.data;
    const caps = new Map<string, ReasoningCapability | null>();
    if (Array.isArray(data)) {
      for (const item of data) {
        const id = (item as { id?: unknown })?.id;
        if (typeof id !== 'string' || !id.trim()) continue;
        caps.set(id.trim().toLowerCase(), parseModelReasoning(item));
      }
    }
    return { fetchedAt: Date.now(), caps };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tra capability của `modelId` trên gateway. Không fetch được / metadata lỗi
 * thời → trả null (caller giữ hành vi cũ: bỏ qua reasoningEffort).
 */
export async function getReasoningCapability(
  baseUrl: string,
  modelId: string,
): Promise<ReasoningCapability | null> {
  const key = baseKey(baseUrl);
  if (!key || !modelId) return null;

  let entry = cache.get(key);
  if (!entry || Date.now() - entry.fetchedAt > CAPABILITY_TTL_MS) {
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchCapabilities(baseUrl)
        .then((e) => {
          cache.set(key, e);
          return e;
        })
        .catch(() => {
          // Gateway chặn/lỗi → ghi entry rỗng để không retry mỗi token:
          // TTL vẫn hết hạn như thường, request hiện tại bỏ qua tham số.
          const empty: CacheEntry = { fetchedAt: Date.now(), caps: new Map() };
          cache.set(key, empty);
          return empty;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    entry = await pending;
  }

  return entry.caps.get(modelId.trim().toLowerCase()) ?? null;
}

/** Dùng cho test — xoá sạch state giữa các case. */
export function resetModelReasoningCache(): void {
  cache.clear();
  inflight.clear();
}
