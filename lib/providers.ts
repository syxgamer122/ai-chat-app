import { db } from '@/lib/db';
import { useAppStore, SERVER_PROVIDER_ID, type ActiveProviderSnapshot } from '@/lib/store';
import {
  validateProviderBaseUrl,
  normalizeProviderModels,
  providerNeedsApiKey,
  type ProviderModel,
} from '@/lib/provider-url';

/**
 * Provider Presets — nhiều nhà cung cấp API chuẩn OpenAI-compatible.
 * Cấu hình lưu trong IndexedDB; snapshot nhà cung cấp đang dùng giữ trong
 * zustand (KHÔNG persist) để chat/title route gửi kèm header mỗi request.
 */

export { SERVER_PROVIDER_ID };
export type { ActiveProviderSnapshot };
export { validateProviderBaseUrl, normalizeProviderModels, providerNeedsApiKey };
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
      apiKey: p.apiKey,
      models: p.models ?? [],
    });
  } catch (err) {
    console.error('[providers] Không đọc được provider từ IndexedDB:', err);
    store.setActiveProviderSnapshot(null);
  }
}

/* ------------------------------------------------------------------ */
/* Seed 2 provider mặc định (chạy 1 lần)                               */
/* ------------------------------------------------------------------ */

// v6: KHÔNG seed API key nào kèm code. Trước đây `crax-gpt` mang sẵn
// apiKey: 'crax-gpt' — credential nằm trong repo và trong git history. User tự
// dán key qua nút Sửa; key chỉ sống trong IndexedDB của trình duyệt.
const PROVIDER_SEED_FLAG = 'providers-seeded-v6';

/** Khoá module: chống 2 effect chạy song song cùng lúc (StrictMode / 2 tab). */
let seedPromise: Promise<void> | null = null;

const DEFAULT_PROVIDER_SEEDS: Array<Pick<ProviderConfig, 'name' | 'baseUrl' | 'apiKey'>> = [
  {
    /* Từ bản cập nhật "User Accounts + API Keys", crax BẮT BUỘC key: mọi
       endpoint trả 401 auth_required kể cả với key rác. Đăng ký tài khoản
       (hoặc vào bằng guest) tại https://gpt.crax.lol rồi lấy key crk_live_…
       ở Settings → API keys. Seed vẫn để trống — không nhúng credential. */
    name: 'crax-gpt',
    baseUrl: 'https://gpt.crax.lol/v1',
    apiKey: '',
  },
  {
    /* Kilgore đã chuyển sang tên miền mới (kilgoreai.xyz) và hỗ trợ cả cookie
       lẫn Bearer API key (`sk-kilg-…`). Server proxy của app không giữ được
       cookie giữa các request nên mỗi lượt sẽ là phiên mới — mất lịch sử hội
       thoại phía gateway và có thể bị giới hạn theo IP chung. Khuyến nghị
       người dùng tạo key qua POST /v1/auth/api-keys rồi dán vào đây để có
       danh tính ổn định; ô nhập key vẫn cho phép bỏ trống nếu muốn dùng tạm. */
    name: 'KilgoreAI',
    baseUrl: 'https://kilgoreai.xyz/v1',
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
    seedPromise = seedOnce()
      .then(() => migrateKiloreDomain())
      .catch((err) => {
        seedPromise = null; // lỗi (vd 2 tab write-conflict) → cho phép thử lại lần sau
        throw err;
      });
  }
  return seedPromise;
}

/**
 * Migration Kilgore domain: freesrv.com → xyz. Chạy MỖI LẦN app khởi động
 * (idempotent), KHÔNG phụ thuộc seed flag. Nếu user đã seed từ trước khi
 * migration được thêm, seed flag đã tồn tại nên seedOnce skip — nhưng migration
 * này vẫn chạy để update preset cũ.
 */
async function migrateKiloreDomain(): Promise<void> {
  const OLD_HOST = 'kilgoreai.freesrv.com';
  const NEW_BASE = 'https://kilgoreai.xyz/v1';
  try {
    const existing = await db.providers.toArray();
    const hasNew = existing.some((p) => {
      try { return new URL(p.baseUrl).hostname.toLowerCase() === 'kilgoreai.xyz'; } catch { return false; }
    });
    if (hasNew) return; // Đã có preset mới → không cần migrate
    for (const p of existing) {
      try {
        if (new URL(p.baseUrl).hostname.toLowerCase() !== OLD_HOST) continue;
      } catch { continue; }
      await db.providers.update(p.id, { baseUrl: NEW_BASE, updatedAt: Date.now() });
    }
  } catch {
    // Migration thất bại không được chặn app khởi động.
  }
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
      // Ưu tiên bản có nhiều model đã tải; HOÀ thì giữ bản MỚI hơn —
      // trước đây hoà giữ bản cũ nhất, xoá mất sửa đổi của user trên bản mới.
      const curModels = cur.models?.length ?? 0;
      const pModels = p.models?.length ?? 0;
      const keep =
        pModels > curModels || (pModels === curModels && p.updatedAt >= cur.updatedAt) ? p : cur;
      const drop = keep === cur ? p : cur;
      await db.providers.delete(drop.id);
      byBase.set(p.baseUrl, keep);
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
