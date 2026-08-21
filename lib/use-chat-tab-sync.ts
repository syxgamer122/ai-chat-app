"use client";

import {
  useCallback,
  useEffect,
  useRef,
} from "react";
import { db, type ChatSession, type StoredMessage } from "@/lib/db";
import { chatBroadcast } from "@/lib/chat-broadcast";
import { repairSessionIfNeeded } from "@/lib/tree-repair";

interface UseChatTabSyncOptions {
  sessionId: string | null;
  onDataChanged: (data: {
    messages: StoredMessage[];
    session: ChatSession | null;
  }) => void;
}

async function loadSessionData(sessionId: string) {
  const [messages, session] = await Promise.all([
    db.messages
      .where("chatId")
      .equals(sessionId)
      .toArray(),
    db.chats.get(sessionId),
  ]);

  return {
    messages,
    session: session ?? null,
  };
}

export function useChatTabSync({
  sessionId,
  onDataChanged,
}: UseChatTabSyncOptions) {
  const reload = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    const repaired = await repairSessionIfNeeded(sessionId);
    const data = await loadSessionData(sessionId);

    onDataChanged({
      messages: data.messages,
      session: repaired.session ?? data.session,
    });
  }, [onDataChanged, sessionId]);

  const revisionRef = useRef(0);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    void reload();

    return chatBroadcast.subscribe((event) => {
      if (event.sessionId !== sessionId) {
        return;
      }

      if (event.revision <= revisionRef.current) {
        return;
      }

      revisionRef.current = event.revision;

      /**
       * setTimeout nhường quyền cho transaction IndexedDB hiện tại
       * hoàn tất trước khi reload.
       */
      window.setTimeout(() => {
        void reload();
      }, 0);
    });
  }, [reload, sessionId]);

  return {
    reload,
  };
}
