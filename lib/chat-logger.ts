export interface ChatDebugEvent {
  type:
    | "stream-start"
    | "stream-progress"
    | "stream-abort"
    | "branch-switch"
    | "tree-repair"
    | "cross-tab-event"
    | "persistence-error";

  sessionId?: string;
  messageId?: string;
  streamId?: string;
  revision?: number;
  clientId?: string;
  details?: Record<string, unknown>;
}

export function logChatEvent(event: ChatDebugEvent) {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  console.debug("[chat-event]", {
    ...event,
    timestamp: new Date().toISOString(),
  });
}

export async function hashContent(content: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(content);
    const hash = await crypto.subtle.digest("SHA-256", data);

    return Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}
