/**
 * Hàng đợi + cửa sổ trượt cho các gateway miễn phí dùng chung (crax, Kilgore).
 * Mọi request của toàn bộ user đều ra từ IP server, nên giới hạn "mỗi IP" của
 * gateway là ngân sách CHUNG — module này giữ tổng lưu lượng trong ngưỡng công bố.
 * Thuần module (không Dexie) để edge route import được. State theo isolate —
 * same caveat với rate-limit in-memory hiện có.
 */

interface Budget {
  /** tối đa trong 10s (crax công bố 5 — để 4 cho dư địa) */
  per10: number;
  /** tối đa trong 60s (crax công bố 20 — để 18) */
  per60: number;
}

/**
 * crax công bố "20 requests / 60s, 5 / 10s burst, per-IP". Tài khoản có liên
 * kết Discord được 60/min + 15 burst, nhưng app KHÔNG biết tài khoản của user
 * thuộc hạng nào — giữ ngưỡng bảo thủ theo mức nền để không bị 429 hàng loạt.
 *
 * Lưu ý: từ khi crax bắt buộc API key, giới hạn có thể tính theo tài khoản chứ
 * không còn thuần theo IP; ngân sách dùng chung ở đây vẫn đúng hướng vì mọi
 * request của một deployment đều đi ra từ cùng IP server.
 *
 * Kilgore (kilgoreai.xyz): docs chỉ nói "fair use per-user", không nêu con số
 * cụ thể. Giữ ngưỡng rất thấp (1/10s, 5/60s) như bản cũ trên freesrv.com để
 * không phá quota chung; khi người dùng có Bearer key riêng thì giới hạn sẽ
 * tính theo tài khoản họ thay vì IP server.
 */
const FREE_HOST_BUDGETS: Record<string, Budget> = {
  'gpt.crax.lol': { per10: 4, per60: 18 },
  'kilgoreai.xyz': { per10: 1, per60: 5 },
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
    const before = now;
    await sleep(wait + 20);
    // Đồng hồ không tiến sau sleep (clock giả / hệ thống treo) — thoát bằng
    // retry-after thay vì quay vô hạn trong giới hạn cũ.
    if (nowFn() <= before) {
      return { ok: false, retryAfterSec: Math.ceil(wait / 1000) };
    }
  }
}
