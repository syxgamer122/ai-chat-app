import { getClientId, nextLamport, observeLamport } from "./client-identity";

export type ChatBroadcastEvent =
  | {
      type: "session-invalidated";
      sessionId: string;
      mutationId: string;
      revision: number;
      originClientId: string;
      reason:
        | "message-created"
        | "message-updated"
        | "branch-switched"
        | "stream-started"
        | "stream-progress"
        | "stream-finished"
        | "stream-aborted"
        | "repair";
    }
  | {
      type: "branch-switched";
      sessionId: string;
      activeLeafId: string;
      mutationId: string;
      revision: number;
      originClientId: string;
    }
  | {
      type: "branch-switch-request";
      sessionId: string;
      activeLeafId: string;
      mutationId: string;
      revision: number;
      originClientId: string;
    }
  | {
      type: "chat-updated";
      sessionId: string;
      mutationId: string;
      revision: number;
      originClientId: string;
    }
  | {
      type: "stream-abort-request";
      sessionId: string;
      streamId: string;
      requestedBy?: string;
      originClientId: string;
      mutationId: string;
      revision: number;
    };

const CHANNEL_NAME = "ai-chat-tree";

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

export type PublishBroadcastEvent = DistributiveOmit<
  ChatBroadcastEvent,
  "originClientId" | "revision"
> & {
  revision?: number;
};

const STORAGE_EVENT_KEY = "ai-chat-cross-tab-event";

export function publishStorageFallback(event: unknown) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      STORAGE_EVENT_KEY,
      JSON.stringify({
        id: crypto.randomUUID(),
        event,
        createdAt: Date.now(),
      }),
    );

    window.localStorage.removeItem(STORAGE_EVENT_KEY);
  } catch (error) {
    console.warn("[storage-sync] publish error", error);
  }
}

export function subscribeStorageFallback(
  listener: (event: unknown) => void,
) {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handler = (event: StorageEvent) => {
    if (event.key !== STORAGE_EVENT_KEY) {
      return;
    }

    if (!event.newValue) {
      return;
    }

    try {
      const parsed = JSON.parse(event.newValue);
      listener(parsed.event);
    } catch (error) {
      console.warn(
        "[storage-sync] invalid event",
        error,
      );
    }
  };

  window.addEventListener("storage", handler);

  return () => {
    window.removeEventListener("storage", handler);
  };
}

export class ChatBroadcast {
  private channel: BroadcastChannel | null = null;
  private clientId: string;

  constructor() {
    this.clientId = getClientId();

    if (typeof window !== "undefined" && "BroadcastChannel" in window) {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
    }
  }

  getClientId() {
    return this.clientId;
  }

  publish(event: PublishBroadcastEvent) {
    const revision = event.revision ?? nextLamport();

    const payload = {
      ...event,
      originClientId: this.clientId,
      revision,
    } as ChatBroadcastEvent;

    if (this.channel) {
      this.channel.postMessage(payload);
      return;
    }

    publishStorageFallback(payload);
  }

  subscribe(listener: (event: ChatBroadcastEvent) => void) {
    if (this.channel) {
      const handler = (event: MessageEvent<ChatBroadcastEvent>) => {
        const payload = event.data;

        if (!payload || payload.originClientId === this.clientId) {
          return;
        }

        observeLamport(payload.revision);
        listener(payload);
      };

      this.channel.addEventListener("message", handler);

      return () => {
        this.channel?.removeEventListener("message", handler);
      };
    }

    return subscribeStorageFallback((event) => {
      const payload = event as ChatBroadcastEvent;

      if (!payload || payload.originClientId === this.clientId) {
        return;
      }

      observeLamport(payload.revision);
      listener(payload);
    });
  }

  close() {
    this.channel?.close();
    this.channel = null;
  }
}

export const chatBroadcast = new ChatBroadcast();
