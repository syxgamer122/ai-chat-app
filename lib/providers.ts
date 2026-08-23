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

/* ------------------------------------------------------------------ */
/* Seed 2 provider mặc định (chạy 1 lần)                               */
/* ------------------------------------------------------------------ */

// v3: thêm OpenRouter + airforce (dự phòng khi crax/kilgore chết).
const PROVIDER_SEED_FLAG = 'providers-seeded-v3';

const DEFAULT_PROVIDER_SEEDS: Array<Pick<ProviderConfig, 'name' | 'baseUrl' | 'apiKey'>> = [
  {
    name: 'crax-gpt',
    baseUrl: 'https://gpt.crax.lol/v1',
    apiKey: 'crax-gpt',
  },
  {
    name: 'KilgoreAI',
    baseUrl: 'https://kilgoreai.freesrv.com/v1',
    apiKey: '',
  },
  {
    // Key free tại https://openrouter.ai/keys — model free có đuôi ":free".
    name: 'OpenRouter (dự phòng)',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
  },
  {
    // Key free tại https://api.airforce/signup — 1.000 lượt/ngày, model cơ bản.
    name: 'airforce (dự phòng)',
    baseUrl: 'https://api.airforce/v1',
    apiKey: '',
  },
];

/** Thêm sẵn 2 nhà cung cấp user định dùng — chỉ chạy lần đầu. */
export async function ensureProviderSeed(): Promise<void> {
  const flag = await db.kv.get(PROVIDER_SEED_FLAG);
  if (flag) return;
  const existing = await db.providers.toArray();
  const knownBases = new Set(existing.map((p) => p.baseUrl));
  const now = Date.now();
  const missing = DEFAULT_PROVIDER_SEEDS.filter((s) => !knownBases.has(s.baseUrl));
  if (missing.length) {
    await db.providers.bulkAdd(
      missing.map((s, i) => ({
        id: newProviderId(),
        ...s,
        createdAt: now + i,
        updatedAt: now + i,
      })),
    );
  }
  await db.kv.put({ key: PROVIDER_SEED_FLAG, value: true });
}
