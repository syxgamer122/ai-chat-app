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

// v5: thêm OrcaRouter + Tokenin (không kèm key — user tự dán API key cá nhân
// qua nút Sửa, key không bao giờ nằm trong code/repo).
const PROVIDER_SEED_FLAG = 'providers-seeded-v5';

/** Khoá module: chống 2 effect chạy song song cùng lúc (StrictMode / 2 tab). */
let seedPromise: Promise<void> | null = null;

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
  {
    // Key cá nhân tại https://orcarouter.ai — 191 model mọi hãng, có model
    // `orcarouter/free` chạy miễn phí; model trả phí cần nạp credit.
    name: 'OrcaRouter (key cá nhân)',
    baseUrl: 'https://api.orcarouter.ai/v1',
    apiKey: '',
  },
  {
    // Key cá nhân tại dashboard tokenin.my.id — 82 model `myt/*`, nhiều model
    // free (-free) + API tạo video (Kling/Seedance/Grok Imagine).
    name: 'Tokenin (key cá nhân)',
    baseUrl: 'https://tokenin.my.id/v1',
    apiKey: '',
  },
];

/** Thêm sẵn các nhà cung cấp user định dùng + dọn trùng lặp — chỉ chạy lần đầu. */
export async function ensureProviderSeed(): Promise<void> {
  if (!seedPromise) {
    seedPromise = seedOnce().catch((err) => {
      seedPromise = null; // lỗi (vd 2 tab write-conflict) → cho phép thử lại lần sau
      throw err;
    });
  }
  return seedPromise;
}

async function seedOnce(): Promise<void> {
  const flag = await db.kv.get(PROVIDER_SEED_FLAG);
  if (flag) return;
  await db.transaction('rw', [db.providers, db.kv], async () => {
    const existing = await db.providers.toArray();

    // Dọn bản trùng baseUrl (giữ bản mới nhất, ưu tiên bản đã tải được models).
    const byBase = new Map<string, ProviderConfig>();
    for (const p of [...existing].sort((a, b) => a.updatedAt - b.updatedAt)) {
      const cur = byBase.get(p.baseUrl);
      if (!cur) {
        byBase.set(p.baseUrl, p);
        continue;
      }
      const keepNewer = (cur.models?.length ?? 0) >= (p.models?.length ?? 0) ? cur : p;
      const drop = keepNewer === cur ? p : cur;
      await db.providers.delete(drop.id);
      byBase.set(p.baseUrl, keepNewer);
    }

    const knownBases = new Set([...byBase.keys()]);
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
  });
}
