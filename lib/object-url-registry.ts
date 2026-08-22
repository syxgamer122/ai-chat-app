'use client';

interface Entry {
  refCount: number;
  createdAt: number;
  owner?: string;
}

const TTL_MS = 5 * 60_000;

const registry: Map<string, Entry> =
  (globalThis as { __objUrlRegistry?: Map<string, Entry> }).__objUrlRegistry ??
  ((globalThis as { __objUrlRegistry?: Map<string, Entry> }).__objUrlRegistry = new Map());

export function createTrackedObjectUrl(blob: Blob, owner?: string): string {
  const url = URL.createObjectURL(blob);
  registry.set(url, { refCount: 1, createdAt: Date.now(), owner });
  return url;
}

export function retainObjectUrl(url: string): void {
  const e = registry.get(url);
  if (e) e.refCount += 1;
}

export function releaseObjectUrl(url: string): void {
  const e = registry.get(url);
  if (!e) return;
  e.refCount = Math.max(0, e.refCount - 1);
  e.createdAt = Date.now();
}

function revoke(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } finally {
    registry.delete(url);
  }
}

export function sweepObjectUrls(now = Date.now()): number {
  let revoked = 0;
  for (const [url, e] of registry) {
    if (e.refCount === 0 && now - e.createdAt > TTL_MS) {
      revoke(url);
      revoked += 1;
    }
  }
  return revoked;
}

export function revokeByOwner(owner: string): void {
  for (const [url, e] of registry) if (e.owner === owner) revoke(url);
}

export function revokeAllObjectUrls(): void {
  for (const url of [...registry.keys()]) revoke(url);
}

export function getRegistrySize(): number {
  return registry.size;
}