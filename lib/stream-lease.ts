'use client';

import { db, type StreamLease } from '@/lib/db';

const LEASE_TTL_MS = 12_000;
const HEARTBEAT_MS = 4_000;

const WRITER_ID =
  typeof window === 'undefined'
    ? 'server'
    : ((window as { __writerId?: string }).__writerId ??=
        `w-${Math.random().toString(36).slice(2, 10)}`);

export function getWriterId(): string {
  return WRITER_ID;
}

const activeControllers = new Map<string, AbortController>();

/** Chỉ tab thắng lease được phép ghi message đang stream vào DB. */
export async function acquireLease(chatId: string, messageId: string): Promise<boolean> {
  const now = Date.now();
  return db.transaction('rw', db.leases, async () => {
    const existing = await db.leases.get(chatId);
    if (existing && existing.expiresAt > now && existing.writerId !== WRITER_ID) return false;
    const lease: StreamLease = {
      chatId,
      messageId,
      writerId: WRITER_ID,
      acquiredAt: existing?.acquiredAt ?? now,
      expiresAt: now + LEASE_TTL_MS,
    };
    await db.leases.put(lease);
    return true;
  });
}

export async function heartbeatLease(chatId: string): Promise<boolean> {
  const now = Date.now();
  return db.transaction('rw', db.leases, async () => {
    const existing = await db.leases.get(chatId);
    if (!existing || existing.writerId !== WRITER_ID) return false;
    await db.leases.update(chatId, { expiresAt: now + LEASE_TTL_MS });
    return true;
  });
}

export function startHeartbeat(chatId: string, onLost: () => void): () => void {
  const id = window.setInterval(async () => {
    if (!(await heartbeatLease(chatId))) {
      window.clearInterval(id);
      onLost();
    }
  }, HEARTBEAT_MS);
  return () => window.clearInterval(id);
}

export async function releaseLease(chatId: string): Promise<void> {
  await db.transaction('rw', db.leases, async () => {
    const existing = await db.leases.get(chatId);
    if (existing?.writerId === WRITER_ID) await db.leases.delete(chatId);
  });
}

export function registerStreamController(chatId: string, c: AbortController): void {
  activeControllers.set(chatId, c);
}

/** Sidebar gọi trước khi xóa chat, tránh stream ghi lại record đã bị xóa. */
export async function abortStreamForChat(chatId: string): Promise<void> {
  activeControllers.get(chatId)?.abort();
  activeControllers.delete(chatId);
  await releaseLease(chatId);
}

/* Backward compatibility aliases */
export const STREAM_LEASE_HEARTBEAT_MS = HEARTBEAT_MS;
export const heartbeatStreamLease = heartbeatLease;
export const releaseStreamLease = releaseLease;

export async function cleanupExpiredStreamLease(chatId: string): Promise<boolean> {
  const now = Date.now();
  let cleaned = false;
  await db.transaction('rw', db.leases, async () => {
    const existing = await db.leases.get(chatId);
    if (existing && existing.expiresAt <= now) {
      await db.leases.delete(chatId);
      cleaned = true;
    }
  });
  return cleaned;
}

export async function recoverInterruptedStreams(chatId?: string): Promise<number> {
  const now = Date.now();
  let recovered = 0;
  await db.transaction('rw', db.messages, db.leases, async () => {
    const expiredLeases = await db.leases.where('expiresAt').below(now).toArray();
    for (const l of expiredLeases) {
      if (!chatId || l.chatId === chatId) {
        await db.messages.where('id').equals(l.messageId).modify({ status: 'aborted', finishReason: 'abort' });
        await db.leases.delete(l.chatId);
        recovered += 1;
      }
    }
  });
  return recovered;
}