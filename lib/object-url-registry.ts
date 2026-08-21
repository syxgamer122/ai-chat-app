interface ObjectUrlEntry {
  key: string;
  url: string;
  refCount: number;
  lastUsedAt: number;
  revokeTimer: ReturnType<typeof setTimeout> | null;
}

const registry = new Map<string, ObjectUrlEntry>();

/**
 * Delay revoke để tránh trường hợp TanStack Virtualizer
 * unmount rồi mount lại row ngay lập tức.
 */
export const OBJECT_URL_REVOKE_DELAY_MS = 30_000;
export const REVOKE_DELAY_MS = OBJECT_URL_REVOKE_DELAY_MS;

function createRegistryKey(
  attachmentId: string,
  blob: Blob,
): string {
  return [
    attachmentId,
    blob.size,
    blob.type,
  ].join(":");
}

export function retainObjectUrl(
  attachmentId: string,
  blob: Blob,
): string {
  const key = createRegistryKey(attachmentId, blob);
  const now = Date.now();

  const existing = registry.get(key);

  if (existing) {
    existing.refCount += 1;
    existing.lastUsedAt = now;

    if (existing.revokeTimer) {
      clearTimeout(existing.revokeTimer);
      existing.revokeTimer = null;
    }

    return existing.url;
  }

  const url = URL.createObjectURL(blob);

  registry.set(key, {
    key,
    url,
    refCount: 1,
    lastUsedAt: now,
    revokeTimer: null,
  });

  return url;
}

export function releaseObjectUrl(
  attachmentId: string,
  blob: Blob,
): void {
  const key = createRegistryKey(attachmentId, blob);
  const entry = registry.get(key);

  if (!entry) {
    return;
  }

  entry.refCount = Math.max(0, entry.refCount - 1);
  entry.lastUsedAt = Date.now();

  if (entry.refCount > 0 || entry.revokeTimer) {
    return;
  }

  entry.revokeTimer = setTimeout(() => {
    const latest = registry.get(key);

    if (!latest) {
      return;
    }

    if (latest.refCount > 0) {
      latest.revokeTimer = null;
      return;
    }

    URL.revokeObjectURL(latest.url);
    registry.delete(key);
  }, REVOKE_DELAY_MS);
}

export function forceGarbageCollectObjectUrls(
  maxIdleMs = 60_000,
): void {
  const now = Date.now();

  for (const [key, entry] of registry.entries()) {
    const idleTime = now - entry.lastUsedAt;

    if (entry.refCount === 0 && idleTime >= maxIdleMs) {
      if (entry.revokeTimer) {
        clearTimeout(entry.revokeTimer);
      }

      URL.revokeObjectURL(entry.url);
      registry.delete(key);
    }
  }
}

export function revokeAllObjectUrls(): void {
  for (const entry of registry.values()) {
    if (entry.revokeTimer) {
      clearTimeout(entry.revokeTimer);
    }

    URL.revokeObjectURL(entry.url);
  }

  registry.clear();
}

export function getObjectUrlRegistryStats() {
  let activeReferences = 0;

  for (const entry of registry.values()) {
    activeReferences += entry.refCount;
  }

  return {
    entries: registry.size,
    activeReferences,
  };
}
