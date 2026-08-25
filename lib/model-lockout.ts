/**
 * Model lockout per key×model — khóa MỀM ô (gateway, key, model) đang hỏng
 * liên tiếp, kèm success-decay.
 *
 * Khác negative-cache (`model-negative-cache.ts`): cache đó ghi "gateway
 * KHÔNG CÓ model này" (404/unknown-model — lỗi vĩnh viễn theo TTL). Lockout
 * ở đây xử lý lỗi TẠM: 5xx, timeout, idle — model có thể chỉ chết trên một
 * key hoặc quá tải chốc lát. Không khóa cứng vĩnh viễn: mỗi lần THÀNH CÔNG
 * failureCount bị CHIA ĐÔI (decay) thay vì reset về 0 — model hay trục trặc
 * vẫn bị hạ ưu tiên tự nhiên nhưng không bao giờ mất tích hoàn toàn.
 *
 * Pattern port từ OmniRoute `accountFallback.ts::lockModel()/
 * decayModelFailureCount()` — thu gọn về in-memory Map cho single-user app,
 * cùng cấp độ bền với keyHealthMap/model-negative-cache (theo isolate).
 */

const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 10 * 60_000;
const MAX_ENTRIES = 512;

interface LockState {
  failures: number;
  /** epoch ms — hết thời điểm này thì ô được thử lại. */
  until: number;
}

/** key chuẩn hoá -> trạng thái khóa. */
const locks = new Map<string, LockState>();

function lockKey(baseUrl: string, keyLabel: string, model: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    // baseUrl không parse được — dùng nguyên giá trị, nhất quán mark/check.
  }
  return `${host}::${keyLabel}::${model.toLowerCase()}`;
}

function prune(now: number): void {
  if (locks.size < MAX_ENTRIES) return;
  for (const [key, st] of locks) {
    if (st.until <= now) locks.delete(key);
  }
  while (locks.size >= MAX_ENTRIES) {
    const oldest = locks.keys().next().value;
    if (oldest === undefined) break;
    locks.delete(oldest);
  }
}

/** Ghi một lần thất bại của ô (key×model): backoff mũ từ 1 phút, trần 10 phút. */
export function markModelFailure(
  baseUrl: string,
  keyLabel: string,
  model: string,
  now: number = Date.now(),
): void {
  if (!baseUrl || !model) return;
  const key = lockKey(baseUrl, keyLabel, model);
  const current = locks.get(key);
  const failures = Math.min((current?.failures ?? 0) + 1, 10);
  const ttl = Math.min(BASE_LOCK_MS * 2 ** (failures - 1), MAX_LOCK_MS);
  prune(now);
  locks.set(key, { failures, until: now + ttl });
}

/**
 * Ghi một lần THÀNH CÔNG: chia đôi failureCount (decay), dưới 1 thì xoá hẳn.
 * Thành công không xóa ngay toàn bộ lịch sử — model "hay trục trặc" cần vài
 * lần lành lặn liền mới được tin trở lại hoàn toàn.
 */
export function decayModelFailure(
  baseUrl: string,
  keyLabel: string,
  model: string,
): void {
  const key = lockKey(baseUrl, keyLabel, model);
  const current = locks.get(key);
  if (!current) return;
  const failures = Math.floor(current.failures / 2);
  if (failures <= 0) locks.delete(key);
  else locks.set(key, { failures, until: 0 }); // mở khóa ngay, chỉ giữ đếm
}

export function isModelLockedOut(
  baseUrl: string,
  keyLabel: string,
  model: string,
  now: number = Date.now(),
): boolean {
  if (!baseUrl || !model) return false;
  const key = lockKey(baseUrl, keyLabel, model);
  const st = locks.get(key);
  if (!st) return false;
  if (st.until <= now) {
    // Hết hạn khóa — giữ failureCount để lần fail kế tiếp backoff nhanh hơn,
    // nhưng không coi là đang khóa nữa.
    return false;
  }
  return true;
}

/**
 * Lọc chuỗi model bỏ các ô đang khóa của `keyLabel`. Nếu lọc sạch → trả chuỗi
 * gốc (phải luôn còn ít nhất MỘT cơ hội thử thật để có lỗi rõ ràng / tự phục
 * hồi — cùng triết lý filterSupportedModels).
 */
export function filterLockedModels(
  baseUrl: string,
  keyLabel: string,
  models: readonly string[],
  now: number = Date.now(),
): string[] {
  if (!baseUrl || models.length <= 1) return [...models];
  const alive = models.filter((m) => !isModelLockedOut(baseUrl, keyLabel, m, now));
  return alive.length ? alive : [...models];
}

/** Dùng cho test — xoá sạch state giữa các case. */
export function resetModelLockout(): void {
  locks.clear();
}
