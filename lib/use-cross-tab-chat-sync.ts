"use client";

import { useEffect, useRef } from "react";
import { chatBroadcast } from "@/lib/chat-broadcast";

interface UseCrossTabChatSyncOptions {
  sessionId: string | null;
  onReload: () => void;
}

/**
 * Lắng nghe broadcast đa-tab. Sự kiện thực tế được publish trong app chỉ có
 * "session-invalidated" (tree-repair) — tab nhận sẽ đọc lại Dexie, không tin
 * payload của event.
 */
export function useCrossTabChatSync({
  sessionId,
  onReload,
}: UseCrossTabChatSyncOptions) {
  const lastRevisionRef = useRef(0);

  useEffect(() => {
    const unsubscribe = chatBroadcast.subscribe(async (event) => {
      if (!sessionId || event.sessionId !== sessionId) {
        return;
      }

      if (event.type !== "session-invalidated") {
        return;
      }

      /**
       * Chống xử lý event cũ hoặc event đến trùng.
       */
      if (event.revision <= lastRevisionRef.current) {
        return;
      }

      lastRevisionRef.current = event.revision;

      /**
       * Không lấy payload event làm source of truth.
       * onReload phải đọc lại Dexie.
       */
      onReload();
    });

    return unsubscribe;
  }, [onReload, sessionId]);
}
