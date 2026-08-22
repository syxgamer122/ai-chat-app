"use client";

import { useCallback, useRef } from "react";
import { useChat } from "ai/react";
import { streamController } from "@/lib/stream-controller";
import { db, type StoredMessage } from "@/lib/db";
import { getClientId, nextLamport } from "@/lib/client-identity";
import type { ChatMessage } from "@/lib/chat-types";

interface UseForkingChatOptions {
  sessionId: string;
  initialMessages: ChatMessage[];
  onPersistMessages?: (messages: ChatMessage[]) => Promise<void>;
}

export function useForkingChat({
  sessionId,
  initialMessages,
  onPersistMessages,
}: UseForkingChatOptions) {
  const streamIdRef = useRef<string | null>(null);
  const assistantMessageIdRef = useRef<string | null>(null);
  const accumulatedContentRef = useRef("");

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    setMessages,
    isLoading,
    stop,
    reload,
  } = useChat({
    id: sessionId,

    initialMessages: initialMessages.map((message) => ({
      id: message.id,
      role: message.role as "system" | "user" | "assistant" | "data",
      content: message.content,
    })),

    onResponse(response) {
      const streamId = `stream_${crypto.randomUUID()}`;

      streamIdRef.current = streamId;

      /**
       * Trong thực tế, assistant message ID có thể được tạo
       * khi useChat cập nhật messages lần đầu.
       * Có thể thay bằng ID do app tự tạo trước khi gọi append/reload.
       */
      assistantMessageIdRef.current = null;
      accumulatedContentRef.current = "";

      console.debug("[chat] stream started", {
        sessionId,
        streamId,
        status: response.status,
      });
    },

    onFinish: async (message) => {
      const streamId = streamIdRef.current;
      const assistantMessageId = assistantMessageIdRef.current;

      if (!streamId) {
        return;
      }

      const finalContent = message.content ?? accumulatedContentRef.current;

      /**
       * Nếu app đã lưu assistant message trước khi stream bắt đầu,
       * hãy update message đó tại đây.
       */
      if (assistantMessageId) {
        const current = await db.messages.get(assistantMessageId);

        if (current) {
          await db.messages.put({
            ...current,
            content: finalContent,
            status: "complete",
            finishReason: "stop",
          });
        }
      }

      streamController.unregister(sessionId);
      streamIdRef.current = null;
      assistantMessageIdRef.current = null;
    },

    onError(error) {
      console.error("[chat] stream error", error);
    },
  });

  /**
   * Gọi hàm này sau mỗi lần messages thay đổi.
   * Trong project thực tế nên throttle 100–250ms.
   */
  const onMessagesChanged = useCallback(
    async (nextMessages: typeof messages) => {
      const latest = nextMessages.at(-1);

      if (latest?.role === "assistant") {
        accumulatedContentRef.current = latest.content;

        if (!assistantMessageIdRef.current) {
          assistantMessageIdRef.current = latest.id;
        }

        const streamId = streamIdRef.current;

        if (streamId) {
          await streamController.updateProgress(
            sessionId,
            latest.content,
            latest.content.length,
          );
        }
      }

      await onPersistMessages?.(nextMessages as any);
    },
    [onPersistMessages, sessionId],
  );

  const abortCurrentStream = useCallback(
    async (
      reason: "switch-branch" | "switch-chat" | "manual" | "remote",
    ) => {
      await streamController.abort(sessionId, reason);

      /**
       * useChat có thể vẫn còn một render cuối cùng sau stop().
       * Việc set lại messages nên thực hiện sau khi persist aborted.
       */
      setMessages((current) => [...current]);
    },
    [sessionId, setMessages],
  );

  return {
    messages,
    input,
    isLoading,
    handleInputChange,
    handleSubmit,
    setMessages,
    reload,
    stop,
    abortCurrentStream,
    onMessagesChanged,
  };
}
