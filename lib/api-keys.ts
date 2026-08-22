/**
 * Quản lý pool API key + phân loại lỗi upstream.
 *
 * Thay đổi cốt lõi so với bản cũ:
 *  - Không còn "án tử vĩnh viễn": key bị auth-fail chỉ vào quarantine có thời hạn.
 *  - 404 KHÔNG còn là permanent error (nhiều proxy trả 404 cho "model chưa được
 *    cấp quyền trên key này" -> phải failover sang key khác).
 *  - Có snapshot để debug qua endpoint chẩn đoán.
 */

export type UpstreamScope = 'key' | 'request' | 'transient' | 'unknown';

interface KeyHealth {
  consecutiveFailures: number;
  cooldownUntil: number;
  authFailures: number;
  quarantineUntil: number;
  lastStatus?: number;
  lastFailureAt?: number;
}

const keyHealthMap = new Map<string, KeyHealth>();

const BASE_COOLDOWN_MS = 15_000;
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const AUTH_COOLDOWN_MS = 60_000;
const QUARANTINE_MS = 15 * 60_000; // 15 phút, KHÔNG vĩnh viễn
const AUTH_FAILURES_BEFORE_QUARANTINE = 3;

function parseKeysFromEnv(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,;]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && !k.startsWith('#'));
}

export function getAllConfiguredKeys(): string[] {
  const envKeys = process.env.OPENAI_API_KEYS || process.env.OPENAI_API_KEY;
  return parseKeysFromEnv(envKeys);
}

function getHealth(key: string): KeyHealth {
  return (
    keyHealthMap.get(key) || {
      consecutiveFailures: 0,
      cooldownUntil: 0,
      authFailures: 0,
      quarantineUntil: 0,
    }
  );
}

/**
 * Trả về danh sách key theo thứ tự ưu tiên.
 * Nếu TẤT CẢ key đều đang cooldown/quarantine, vẫn trả về danh sách "last resort"
 * (sắp xếp theo thời điểm hết cooldown gần nhất) thay vì trả mảng rỗng -> tránh
 * việc app trả 503 chỉ vì state in-memory của một lambda instance bị bẩn.
 */
export function getKeyCandidates(): string[] {
  const allKeys = getAllConfiguredKeys();
  if (!allKeys.length) return [];

  const now = Date.now();
  const available: { key: string; score: number }[] = [];
  const resting: { key: string; readyAt: number }[] = [];

  for (const key of allKeys) {
    const health = keyHealthMap.get(key);
    if (!health) {
      available.push({ key, score: 0 });
      continue;
    }
    if (health.quarantineUntil > now || health.cooldownUntil > now) {
      resting.push({ key, readyAt: Math.max(health.quarantineUntil, health.cooldownUntil) });
      continue;
    }
    available.push({ key, score: health.consecutiveFailures });
  }

  if (available.length > 0) {
    available.sort((a, b) => a.score - b.score);
    return available.map((i) => i.key);
  }

  resting.sort((a, b) => a.readyAt - b.readyAt);
  return resting.map((i) => i.key);
}

export function markKeySuccess(key: string): void {
  keyHealthMap.delete(key);
}

export function markKeyFailure(key: string, statusCode?: number, scope: UpstreamScope = 'unknown'): void {
  const now = Date.now();
  const current = getHealth(key);

  current.consecutiveFailures += 1;
  current.lastStatus = statusCode;
  current.lastFailureAt = now;

  if (statusCode === 401 || statusCode === 403 || statusCode === 402) {
    current.authFailures += 1;
    current.cooldownUntil = now + AUTH_COOLDOWN_MS * Math.min(5, current.authFailures);
    if (current.authFailures >= AUTH_FAILURES_BEFORE_QUARANTINE) {
      current.quarantineUntil = now + QUARANTINE_MS;
    }
  } else if (statusCode === 429) {
    current.cooldownUntil = now + RATE_LIMIT_COOLDOWN_MS;
  } else if (scope === 'request') {
    // Lỗi do payload của request, không phải lỗi của key -> không phạt key.
    current.consecutiveFailures = Math.max(0, current.consecutiveFailures - 1);
  } else {
    current.cooldownUntil = now + BASE_COOLDOWN_MS;
  }

  keyHealthMap.set(key, current);
}

export function getKeyLabel(key: string): string {
  if (key.length <= 8) return 'key-***';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/** Ảnh chụp trạng thái pool để phục vụ endpoint chẩn đoán. */
export function getKeyPoolSnapshot() {
  const now = Date.now();
  return getAllConfiguredKeys().map((key) => {
    const h = keyHealthMap.get(key);
    return {
      label: getKeyLabel(key),
      healthy: !h || (h.cooldownUntil <= now && h.quarantineUntil <= now),
      lastStatus: h?.lastStatus,
      authFailures: h?.authFailures ?? 0,
      cooldownRemainingSec: h ? Math.max(0, Math.ceil((h.cooldownUntil - now) / 1000)) : 0,
      quarantineRemainingSec: h ? Math.max(0, Math.ceil((h.quarantineUntil - now) / 1000)) : 0,
    };
  });
}

export function resetAllKeyHealth(): void {
  keyHealthMap.clear();
}

/**
 * Phân loại status code upstream.
 *  - 'request'  : lỗi do chính payload -> đổi key cũng vô ích -> DỪNG failover.
 *  - 'key'      : lỗi gắn với key/quyền -> THỬ key tiếp theo.
 *  - 'transient': lỗi tạm thời (5xx, network, 429) -> THỬ key tiếp theo.
 */
export function classifyUpstreamStatus(status?: number): UpstreamScope {
  if (status === undefined) return 'transient'; // network error / timeout
  if (status === 400 || status === 422) return 'request';
  if (status === 401 || status === 402 || status === 403 || status === 404) return 'key';
  if (status === 429) return 'transient';
  if (status >= 500) return 'transient';
  return 'unknown';
}

/** Chỉ dừng failover khi lỗi thuộc về chính request. 404 đã được loại khỏi danh sách này. */
export function isPermanentClientError(status?: number): boolean {
  return classifyUpstreamStatus(status) === 'request';
}
