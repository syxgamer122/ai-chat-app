export interface ChatDebugEvent {
  type: "tree-repair";

  sessionId?: string;
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
