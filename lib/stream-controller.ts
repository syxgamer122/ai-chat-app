import { db, type StoredMessage, type ChatSession } from "./db";
import { chatBroadcast } from "./chat-broadcast";
import {
  createMutationId,
  getClientId,
  nextLamport,
} from "./client-identity";
import type {
  ChatMessage,
  StreamTokenCheckpoint,
} from "./chat-types";

export interface ActiveStream {
  sessionId: string;
  messageId: string;
  streamId: string;

  /**
   * stop là hàm stop của useChat.
   */
  stop?: () => void;

  /**
   * Nếu app tự tạo fetch stream thì dùng AbortController này.
   */
  controller?: AbortController;
  abortController?: AbortController;

  content: string;
  tokenCount: number;
  startedAt: number;
}

import { withDexieRetry, writePendingStream, clearPendingStream } from "./dexie-retry";
import { logChatEvent } from "./chat-logger";

export class StreamController {
  private active = new Map<string, ActiveStream>();

  register(stream: ActiveStream) {
    this.active.set(stream.sessionId, stream);
    writePendingStream(stream.sessionId, stream.messageId, stream.content);
    logChatEvent({
      type: "stream-start",
      sessionId: stream.sessionId,
      messageId: stream.messageId,
      streamId: stream.streamId,
    });
  }

  get(sessionId: string) {
    return this.active.get(sessionId);
  }

  unregister(sessionId: string) {
    const stream = this.active.get(sessionId);
    if (stream) {
      clearPendingStream(stream.sessionId, stream.messageId);
    }
    this.active.delete(sessionId);
  }

  async abort(
    sessionId: string,
    reason: "switch-branch" | "switch-chat" | "manual" | "remote",
  ) {
    const stream = this.active.get(sessionId);

    if (!stream) {
      return;
    }

    /**
     * Gọi stop trước. stop() của useChat thường sẽ abort request nội bộ.
     * AbortController bổ sung dùng cho custom fetch.
     */
    try {
      stream.stop?.();
    } catch (error) {
      console.warn("Unable to stop useChat stream", error);
    }

    try {
      stream.controller?.abort(reason);
      stream.abortController?.abort(reason);
    } catch (error) {
      console.warn("Unable to abort stream controller", error);
    }

    await this.persistAborted(stream, reason);
    this.unregister(sessionId);
  }

  async updateProgress(
    sessionId: string,
    content: string,
    tokenCount: number,
  ) {
    const stream = this.active.get(sessionId);

    if (!stream) return;

    stream.content = content;
    stream.tokenCount = tokenCount;
    writePendingStream(stream.sessionId, stream.messageId, content);
  }

  private async persistAborted(
    stream: ActiveStream,
    reason: string,
  ) {
    const now = Date.now();
    const revision = nextLamport();

    try {
      await withDexieRetry(() =>
        db.transaction(
          "rw",
          [db.messages, db.chats],
          async () => {
            const message = await db.messages.get(stream.messageId);

            if (message) {
              const updatedMessage: StoredMessage = {
                ...message,
                content: stream.content || message.content,
                status: "aborted",
                finishReason: "abort",
              };

              await db.messages.put(updatedMessage);
            }

            const session = await db.chats.get(stream.sessionId);

            if (session) {
              const updatedSession: ChatSession = {
                ...session,
                updatedAt: now,
                revision,
                lastWriterId: getClientId(),
              };

              await db.chats.put(updatedSession);
            }
          },
        ),
      );

      chatBroadcast.publish({
        type: "session-invalidated",
        sessionId: stream.sessionId,
        mutationId: createMutationId(),
        revision,
        reason: "stream-aborted",
      });

      logChatEvent({
        type: "stream-abort",
        sessionId: stream.sessionId,
        messageId: stream.messageId,
        streamId: stream.streamId,
        revision,
        details: { reason },
      });

      console.info(
        `[stream] aborted: ${stream.streamId}, reason=${reason}`,
      );
    } catch (error) {
      logChatEvent({
        type: "persistence-error",
        sessionId: stream.sessionId,
        messageId: stream.messageId,
        streamId: stream.streamId,
        details: { error: String(error) },
      });
      console.error("[stream] failed to persist aborted stream with retry", error);
      // Backup content is still available in sessionStorage via writePendingStream
    }
  }
}

export const streamController = new StreamController();
