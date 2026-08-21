import { db, type StoredMessage } from "@/lib/db";
import type { ChatMessage } from "@/lib/chat-types";

export function isIndexedDbAvailable(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return "indexedDB" in window;
}

export type LoadResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: unknown;
    };

export async function loadMessagesSafely(
  sessionId: string,
): Promise<LoadResult<StoredMessage[]>> {
  try {
    if (!isIndexedDbAvailable()) {
      return {
        ok: false,
        error: new Error("IndexedDB is not available in this environment"),
      };
    }

    const messages = await db.messages
      .where("chatId")
      .equals(sessionId)
      .toArray();

    return {
      ok: true,
      data: messages,
    };
  } catch (error) {
    console.error("[db-fallback] loadMessagesSafely error", error);
    return {
      ok: false,
      error,
    };
  }
}
