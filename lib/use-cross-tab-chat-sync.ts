"use client";

import { useEffect, useRef } from "react";
import { chatBroadcast } from "@/lib/chat-broadcast";
import { db } from "@/lib/db";
import { streamController } from "@/lib/stream-controller";

interface UseCrossTabChatSyncOptions {
  sessionId: string | null;
  onReload: () => void;
  onRemoteBranchSwitch?: (activeLeafId: string) => void;
}

export function useCrossTabChatSync({
  sessionId,
  onReload,
  onRemoteBranchSwitch,
}: UseCrossTabChatSyncOptions) {
  const lastRevisionRef = useRef(0);

  useEffect(() => {
    const unsubscribe = chatBroadcast.subscribe(async (event) => {
      if (!sessionId || event.sessionId !== sessionId) {
        return;
      }

      /**
       * Chống xử lý event cũ hoặc event đến trùng.
       */
      if (event.revision <= lastRevisionRef.current) {
        return;
      }

      lastRevisionRef.current = event.revision;

      if (event.type === "session-invalidated") {
        /**
         * Không lấy payload event làm source of truth.
         * onReload phải đọc lại Dexie.
         */
        onReload();
        return;
      }

      if (event.type === "branch-switched") {
        const latestSession = await db.chats.get(sessionId);

        if (!latestSession) {
          onReload();
          return;
        }

        onRemoteBranchSwitch?.(latestSession.activeLeafId ?? "");
        onReload();
        return;
      }

      if (event.type === "stream-abort-request") {
        const activeStream = streamController.get(sessionId);

        /**
         * Chỉ abort nếu streamId trùng.
         * Tab B không được abort nhầm stream mới của Tab A.
         */
        if (activeStream?.streamId === event.streamId) {
          await streamController.abort(sessionId, "remote");
        }
      }
    });

    return unsubscribe;
  }, [
    onReload,
    onRemoteBranchSwitch,
    sessionId,
  ]);
}
