import { db } from '@/lib/db';
import { useAppStore, SERVER_PROVIDER_ID, type ActiveProviderSnapshot } from '@/lib/store';
import { validateProviderBaseUrl, normalizeProviderModels, type ProviderModel } from '@/lib/provider-url';

/**
 * Provider Presets — nhiều nhà cung cấp API chuẩn OpenAI-compatible.
 * Cấu hình lưu trong IndexedDB; snapshot nhà cung cấp đang dùng giữ trong
 * zustand (KHÔNG persist) để chat/title route gửi kèm header mỗi request.
 */

export { SERVER_PROVIDER_ID };
export type { ActiveProviderSnapshot };
export { validateProviderBaseUrl, normalizeProviderModels };
export type { ProviderModel, BaseUrlCheck } from '@/lib/provider-url';

export interface ProviderConfig {
  id: string;
  name: string;
  /** baseURL chuẩn OpenAI, ví dụ https://gpt.crax.lol/v1 */
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
 */
export async function syncActiveProviderSnapshot(providerId: string): Promise<void> {
  const store = useAppStore.getState();
  if (providerId === SERVER_PROVIDER_ID) {
    store.setActiveProviderSnapshot(null);
    return;
  }
  const p = await db.providers.get(providerId);
  if (!p) {
    store.setActiveProvider(SERVER_PROVIDER_ID);
    return;
  }
  store.setActiveProviderSnapshot({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    models: p.models ?? [],
  });
}
