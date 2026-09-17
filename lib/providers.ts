import { db } from '@/lib/db';
import { useAppStore, SERVER_PROVIDER_ID, type ActiveProviderSnapshot } from '@/lib/store';
import {
  validateProviderBaseUrl,
  normalizeProviderModels,
  providerNeedsApiKey,
  type ProviderModel,
} from '@/lib/provider-url';
import { resolveProviderApiKey } from '@/lib/provider-secure-key';

/**
 * Provider Presets — nhiều nhà cung cấp API chuẩn OpenAI-compatible.
 * Cấu hình lưu trong IndexedDB; snapshot nhà cung cấp đang dùng giữ trong
 * zustand (KHÔNG persist) để chat/title route gửi kèm header mỗi request.
 */

export { SERVER_PROVIDER_ID };
export type { ActiveProviderSnapshot };
export { validateProviderBaseUrl, normalizeProviderModels, providerNeedsApiKey };
export type { ProviderModel, BaseUrlCheck } from '@/lib/provider-url';
export { SECURE_KEY_MARKER, secureKeyOf, isSecureKeyPointer, resolveProviderApiKey } from '@/lib/provider-secure-key';

export interface ProviderConfig {
  id: string;
  name: string;
  /** baseURL chuẩn OpenAI, ví dụ https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  createdAt: number;
  updatedAt: number;
  models?: ProviderModel[];
  modelsFetchedAt?: number;
}

/* ------------------------------------------------------------------ */
/* CRUD — IndexedDB                                                    */
/* ------------------------------------------------------------------ */

export function newProviderId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `pv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export async function listProviders(): Promise<ProviderConfig[]> {
  const all = await db.providers.toArray();
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function upsertProvider(input: ProviderConfig): Promise<void> {
  await db.providers.put({ ...input, updatedAt: Date.now() });
}

export async function deleteProvider(id: string): Promise<void> {
  await db.providers.delete(id);
  const store = useAppStore.getState();
  if (store.activeProviderId === id) {
    store.setActiveProvider(SERVER_PROVIDER_ID);
  }
}

/**
 * Đọc provider theo id từ DB rồi ghi snapshot vào store. id = server hoặc
 * không tìm thấy → snapshot null (dùng cấu hình env của server).
 *
 * KHÔNG BAO GIỜ ném: caller gọi kiểu fire-and-forget (`void sync…()` trong
 * effect của chat-interface), nên một lỗi IndexedDB (hết quota, chế độ ẩn
 * danh, DB bị khoá vì tab khác đang nâng version) sẽ thành unhandled promise
 * rejection — nổi lên như lỗi toàn cục mà người dùng không hiểu gì.
 * Đọc DB hỏng thì rơi về provider mặc định của server: mất preset còn hơn
 * mất cả ứng dụng.
 */
export async function syncActiveProviderSnapshot(providerId: string): Promise<void> {
  const store = useAppStore.getState();
  if (providerId === SERVER_PROVIDER_ID) {
    store.setActiveProviderSnapshot(null);
    return;
  }
  try {
    const p = await db.providers.get(providerId);
    if (!p) {
      store.setActiveProvider(SERVER_PROVIDER_ID);
      return;
    }
    store.setActiveProviderSnapshot({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      /* Key có thể là CON TRỎ "@secure:" tới kho mã hoá desktop — snapshot
         (nơi mọi request lấy header x-api-key) phải mang key THẬT. */
      apiKey: await resolveProviderApiKey(p.apiKey, p.id),
      models: p.models ?? [],
    });
  } catch (err) {
    console.error('[providers] Không đọc được provider từ IndexedDB:', err);
    store.setActiveProviderSnapshot(null);
  }
}

/* ------------------------------------------------------------------ */
/* Seed — ĐÃ GỠ                                                        */
/* ------------------------------------------------------------------ */

/**
 * Tầng gateway miễn phí dùng chung (preset gateway cũ) đã gỡ hẳn khỏi seed:
 * provider chỉ đến từ người dùng tự thêm (BYOK). ensureProviderSeed giờ chỉ
 * dọn trùng lặp provider trùng baseUrl — giữ lại để caller cũ không vỡ.
 */
let seedPromise: Promise<void> | null = null;
export async function ensureProviderSeed(): Promise<void> {
  if (!seedPromise) {
    seedPromise = dedupeProviders().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

/** Dọn bản trùng baseUrl (giữ bản mới nhất, ưu tiên bản đã tải được models). */
async function dedupeProviders(): Promise<void> {
  await db.transaction('rw', [db.providers], async () => {
    const existing = await db.providers.toArray();
    const byBase = new Map<string, ProviderConfig>();
    for (const p of [...existing].sort((a, b) => a.updatedAt - b.updatedAt)) {
      const cur = byBase.get(p.baseUrl);
      if (!cur) {
        byBase.set(p.baseUrl, p);
        continue;
      }
      const curModels = cur.models?.length ?? 0;
      const pModels = p.models?.length ?? 0;
      const keep =
        pModels > curModels || (pModels === curModels && p.updatedAt >= cur.updatedAt) ? p : cur;
      const drop = keep === cur ? p : cur;
      await db.providers.delete(drop.id);
      byBase.set(p.baseUrl, keep);
    }
  });
}
