export type UpstreamScope = 'key-auth' | 'key-rate' | 'request' | 'transient' | 'unknown';

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
const MAX_COOLDOWN_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const AUTH_COOLDOWN_MS = 60_000;
const QUARANTINE_MS = 15 * 60_000;
const AUTH_FAILURES_BEFORE_QUARANTINE = 3;
const HEALTH_TTL_MS = 60 * 60_000;

/** Round-robin cursor: chống mọi request đồng thời dồn vào cùng một key. */
let rrCursor = 0;

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function parseKeysFromEnv(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,;]+/)
    .map((k) => k.trim().replace(/^["']|["']$/g, ''))
    .filter((k) => k.length > 0 && !k.startsWith('#'));
}

export function getAllConfiguredKeys(): string[] {
  const merged = [
    ...parseKeysFromEnv(process.env.OPENAI_API_KEYS),
    ...parseKeysFromEnv(process.env.OPENAI_API_KEY),
  ];
  return Array.from(new Set(merged));
}

function getHealth(key: string): KeyHealth {
  return (
    keyHealthMap.get(key) ?? {
      consecutiveFailures: 0,
      cooldownUntil: 0,
      authFailures: 0,
      quarantineUntil: 0,
    }
  );
}

function pruneStaleHealth(now: number): void {
  for (const [key, h] of keyHealthMap) {
    const idle = now - (h.lastFailureAt ?? 0) > HEALTH_TTL_MS;
    if (idle && h.cooldownUntil <= now && h.quarantineUntil <= now) keyHealthMap.delete(key);
  }
}

export interface KeyCandidateResult {
  keys: string[];
  /** Rỗng vì tất cả đang nghỉ: timestamp key sớm nhất sẵn sàng (cho Retry-After). */
  retryAfterMs?: number;
}

export function getKeyCandidates(scope: UpstreamScope = 'unknown'): KeyCandidateResult {
  const allKeys = getAllConfiguredKeys();
  if (!allKeys.length) return { keys: [] };

  const now = Date.now();
  pruneStaleHealth(now);

  // Lỗi do request (400/422) hoặc transient: xoay key không giúp gì, chỉ đốt quota.
  if (scope === 'request') return { keys: allKeys.slice(0, 1) };

  const available: { key: string; score: number; tie: number }[] = [];
  let earliestReady = Number.POSITIVE_INFINITY;
  let restingBest: string | null = null;

  for (const key of allKeys) {
    const health = keyHealthMap.get(key);
    if (!health) {
      available.push({ key, score: 0, tie: Math.random() });
      continue;
    }
    const readyAt = Math.max(health.quarantineUntil, health.cooldownUntil);
    if (readyAt > now) {
      if (readyAt < earliestReady) {
        earliestReady = readyAt;
        restingBest = key;
      }
      continue;
    }
    available.push({ key, score: health.consecutiveFailures, tie: Math.random() });
  }

  if (available.length > 0) {
    available.sort((a, b) => a.score - b.score || a.tie - b.tie);
    const offset = rrCursor++ % available.length;
    const rotated = [...available.slice(offset), ...available.slice(0, offset)];
    rotated.sort((a, b) => a.score - b.score);
    return { keys: rotated.map((i) => i.key) };
  }

  return {
    keys: restingBest ? [restingBest] : [],
    retryAfterMs: Number.isFinite(earliestReady) ? Math.max(0, earliestReady - now) : undefined,
  };
}

export function markKeySuccess(key: string): void {
  const current = keyHealthMap.get(key);
  if (!current) return;
  const next: KeyHealth = {
    consecutiveFailures: 0,
    cooldownUntil: 0,
    quarantineUntil: 0,
    authFailures: Math.max(0, current.authFailures - 1),
    lastFailureAt: current.lastFailureAt,
  };
  if (next.authFailures === 0) keyHealthMap.delete(key);
  else keyHealthMap.set(key, next);
}

export function markKeyFailure(
  key: string,
  statusCode?: number,
  scope: UpstreamScope = 'unknown',
): void {
  if (scope === 'request' || scope === 'transient') return;

  const now = Date.now();
  const current = getHealth(key);
  current.consecutiveFailures = Math.min(current.consecutiveFailures + 1, 16);
  current.lastStatus = statusCode;
  current.lastFailureAt = now;

  if (statusCode === 401 || statusCode === 403) {
    current.authFailures += 1;
    if (current.authFailures >= AUTH_FAILURES_BEFORE_QUARANTINE) {
      current.quarantineUntil = now + jitter(QUARANTINE_MS);
      current.cooldownUntil = current.quarantineUntil;
    } else {
      current.cooldownUntil = now + jitter(AUTH_COOLDOWN_MS);
    }
  } else if (statusCode === 429) {
    current.cooldownUntil = now + jitter(RATE_LIMIT_COOLDOWN_MS);
  } else {
    const backoff = Math.min(
      BASE_COOLDOWN_MS * 2 ** (current.consecutiveFailures - 1),
      MAX_COOLDOWN_MS,
    );
    current.cooldownUntil = now + jitter(backoff);
  }

  keyHealthMap.set(key, current);
}

export function getKeyLabel(key: string): string {
  if (!key) return 'empty';
  if (key.length < 14) return `len:${key.length}:${key.slice(-2)}`;
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

export function classifyUpstreamStatus(status?: number): UpstreamScope {
  if (!status) return 'transient';
  if (status === 401 || status === 403) return 'key-auth';
  if (status === 429) return 'key-rate';
  if (status === 400 || status === 422 || status === 404) return 'request';
  if (status >= 500) return 'transient';
  return 'unknown';
}

export function getKeyPoolSnapshot(): Array<{
  label: string;
  consecutiveFailures: number;
  cooldownRemainingMs: number;
  quarantineRemainingMs: number;
  authFailures: number;
  lastStatus?: number;
}> {
  const now = Date.now();
  const allKeys = getAllConfiguredKeys();
  return allKeys.map((key) => {
    const h = keyHealthMap.get(key);
    return {
      label: getKeyLabel(key),
      consecutiveFailures: h?.consecutiveFailures ?? 0,
      cooldownRemainingMs: Math.max(0, (h?.cooldownUntil ?? 0) - now),
      quarantineRemainingMs: Math.max(0, (h?.quarantineUntil ?? 0) - now),
      authFailures: h?.authFailures ?? 0,
      lastStatus: h?.lastStatus,
    };
  });
}