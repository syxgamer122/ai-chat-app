import { db, type ChatSession } from "@/lib/db";
import { chatBroadcast } from "@/lib/chat-broadcast";
import {
  getClientId,
  nextLamport,
} from "@/lib/client-identity";
import type { StreamLease } from "@/lib/chat-types";

export const STREAM_LEASE_TIMEOUT_MS = 15_000;
export const STREAM_LEASE_HEARTBEAT_MS = 5_000;

function isLeaseAlive(
  lease: StreamLease | null | undefined,
  now = Date.now(),
): boolean {
  if (!lease) {
    return false;
  }

  return now - lease.heartbeatAt < STREAM_LEASE_TIMEOUT_MS;
}

export interface AcquireStreamLeaseInput {
  sessionId: string;
  streamId: string;
  messageId: string;
}

export async function acquireStreamLease({
  sessionId,
  streamId,
  messageId,
}: AcquireStreamLeaseInput): Promise<ChatSession> {
  const clientId = getClientId();
  const revision = nextLamport();
  const now = Date.now();

  const updatedSession = await db.transaction(
    "rw",
    db.chats,
    async () => {
      const session = await db.chats.get(sessionId);

      if (!session) {
        throw new Error(
          `Cannot acquire stream lease. Session not found: ${sessionId}`,
        );
      }

      const existingLease = session.activeLease;

      /**
       * Nếu lease còn sống và thuộc tab khác,
       * không cho phép stream thứ hai khởi động.
       */
      if (
        isLeaseAlive(existingLease, now) &&
        existingLease?.clientId !== clientId
      ) {
        throw new Error(
          JSON.stringify({
            code: "SESSION_STREAMING_IN_ANOTHER_TAB",
            sessionId,
            streamId: existingLease?.streamId,
            clientId: existingLease?.clientId,
          }),
        );
      }

      const nextLease: StreamLease = {
        streamId,
        clientId,
        messageId,
        startedAt:
          existingLease?.clientId === clientId
            ? existingLease.startedAt
            : now,
        heartbeatAt: now,
      };

      const nextSession: ChatSession = {
        ...session,
        activeLease: nextLease,
        updatedAt: now,
        revision,
        lastWriterId: clientId,
      };

      await db.chats.put(nextSession);

      return nextSession;
    },
  );

  chatBroadcast.publish({
    type: "stream-lease-acquired",
    sessionId,
    streamId,
    messageId,
    clientId,
    heartbeatAt: now,
    revision,
  });

  return updatedSession;
}

export async function heartbeatStreamLease(
  sessionId: string,
  streamId: string,
): Promise<boolean> {
  const clientId = getClientId();
  const now = Date.now();

  const updated = await db.transaction(
    "rw",
    db.chats,
    async () => {
      const session = await db.chats.get(sessionId);

      if (!session?.activeLease) {
        return false;
      }

      const lease = session.activeLease;

      /**
       * Không được heartbeat lease của tab hoặc stream khác.
       */
      if (
        lease.clientId !== clientId ||
        lease.streamId !== streamId
      ) {
        return false;
      }

      await db.chats.put({
        ...session,
        activeLease: {
          ...lease,
          heartbeatAt: now,
        },
        updatedAt: now,
      });

      return true;
    },
  );

  if (updated) {
    chatBroadcast.publish({
      type: "stream-lease-heartbeat",
      sessionId,
      streamId,
      clientId,
      heartbeatAt: now,
      revision: nextLamport(),
    });
  }

  return updated;
}

export async function releaseStreamLease(
  sessionId: string,
  streamId: string,
): Promise<boolean> {
  const clientId = getClientId();
  const revision = nextLamport();

  const released = await db.transaction(
    "rw",
    db.chats,
    async () => {
      const session = await db.chats.get(sessionId);

      if (!session?.activeLease) {
        return false;
      }

      const lease = session.activeLease;

      if (
        lease.clientId !== clientId ||
        lease.streamId !== streamId
      ) {
        return false;
      }

      await db.chats.put({
        ...session,
        activeLease: null,
        updatedAt: Date.now(),
        revision,
        lastWriterId: clientId,
      });

      return true;
    },
  );

  if (released) {
    chatBroadcast.publish({
      type: "stream-lease-released",
      sessionId,
      streamId,
      clientId,
      revision,
    });
  }

  return released;
}

export async function cleanupExpiredStreamLease(
  sessionId: string,
): Promise<boolean> {
  const now = Date.now();
  const clientId = getClientId();
  const revision = nextLamport();

  const cleaned = await db.transaction(
    "rw",
    db.chats,
    async () => {
      const session = await db.chats.get(sessionId);

      if (!session?.activeLease) {
        return false;
      }

      const expired =
        now - session.activeLease.heartbeatAt >=
        STREAM_LEASE_TIMEOUT_MS;

      if (!expired) {
        return false;
      }

      await db.chats.put({
        ...session,
        activeLease: null,
        updatedAt: now,
        revision,
        lastWriterId: clientId,
      });

      return true;
    },
  );

  if (cleaned) {
    chatBroadcast.publish({
      type: "stream-lease-released",
      sessionId,
      streamId: "expired",
      clientId,
      revision,
    });
  }

  return cleaned;
}

export async function recoverInterruptedStreams(
  sessionId: string,
): Promise<number> {
  const messages = await db.messages
    .where("chatId")
    .equals(sessionId)
    .toArray();

  const streamingMessages = messages.filter(
    (message) => message.status === "streaming",
  );

  if (streamingMessages.length === 0) {
    return 0;
  }

  const session = await db.chats.get(sessionId);
  const activeLease = session?.activeLease;
  const now = Date.now();

  let recoveredCount = 0;

  for (const message of streamingMessages) {
    const leaseMatches =
      activeLease?.messageId === message.id &&
      activeLease.streamId === message.streamId;

    const leaseAlive =
      activeLease &&
      now - activeLease.heartbeatAt < STREAM_LEASE_TIMEOUT_MS;

    if (leaseMatches && leaseAlive) {
      continue;
    }

    await db.messages.put({
      ...message,
      status: "aborted",
      finishReason: "abort",
    });

    recoveredCount += 1;
  }

  if (session?.activeLease) {
    const leaseExpired =
      now - session.activeLease.heartbeatAt >= STREAM_LEASE_TIMEOUT_MS;

    if (leaseExpired) {
      await db.chats.put({
        ...session,
        activeLease: null,
        updatedAt: now,
      });
    }
  }

  return recoveredCount;
}
