/**
 * Hàng đợi + cửa sổ trượt cho các gateway miễn phí dùng chung (crax, Kilgore).
 * Mọi request của toàn bộ user đều ra từ IP server, nên giới hạn "mỗi IP" của
 * gateway là бюджет CHUNG — module này giữ tổng lưu lượng trong ngưỡng công bố.
 * Thuần module (không Dexie) để edge route import được. State theo isolate —
 * same caveat với rate-limit in-memory hiện có.
 */

interface Budget {
  /** tối đa trong 10s (crax: 5 — để 4 cho dư địa) */
  per10: number;
  /** tối đa trong 60s (crax: 20 — để 18) */
  per60: number;
}

const FREE_HOST_BUDGETS: Record<string, Budget> = {
  'gpt.crax.lol': { per10: 4, per60: 18 },
  'kilgoreai.freesrv.com': { per10: 1, per60: 5 },
};

function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function sharedFreeBudget(baseUrl?: string | null): Budget | null {
  if (!baseUrl) return null;
  const host = hostOfUrl(baseUrl);
  return host ? FREE_HOST_BUDGETS[host] ?? null : null;
}

/** State theo host: mảng timestamp các lượt đã chiếm (cửa sổ trượt). */
const windows = new Map<string, number[]>();

function nextWait(budget: Budget, hits: number[], now: number): number {
  const recent10 = hits.filter((t) => now - t < 10_000);
  const recent60 = hits.filter((t) => now - t < 60_000);
  if (recent10.length < budget.per10 && recent60.length < budget.per60) return 0;
  const waits: number[] = [];
  if (recent10.length >= budget.per10) waits.push(10_000 - (now - recent10[0]));
  if (recent60.length >= budget.per60) waits.push(60_000 - (now - recent60[0]));
  return Math.max(0, ...waits);
}

export type SlotResult =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

/**
 * Chiếm 1 lượt gọi gateway free. Nếu vượt ngân sách: chờ tối đa `waitMs`
 * (request giữ nguyên, user thấy "đang soạn"); quá lâu thì trả retry-after.
 */
export async function acquireUpstreamSlot(
  baseUrl: string,
  waitMs = 12_000,
  nowFn: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<SlotResult> {
  const budget = sharedFreeBudget(baseUrl);
  if (!budget) return { ok: true };
  const host = hostOfUrl(baseUrl) ?? baseUrl;
  const deadline = nowFn() + waitMs;

  for (;;) {
    const now = nowFn();
    const hits = (windows.get(host) ?? []).filter((t) => now - t < 60_000);
    const wait = nextWait(budget, hits, now);
    if (wait <= 0) {
      hits.push(now);
      windows.set(host, hits);
      return { ok: true };
    }
    if (now + wait > deadline) {
      return { ok: false, retryAfterSec: Math.ceil(wait / 1000) };
    }
    await sleep(wait + 20);
  }
}
