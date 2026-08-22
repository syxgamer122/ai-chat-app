import type { ChatMessage } from "@/lib/chat-types";
import type { StoredMessage } from "@/lib/db";

export type TreeValidationReason =
  | "missing-leaf"
  | "wrong-session"
  | "missing-parent"
  | "cycle";

export interface TreeValidationResult {
  valid: boolean;
  reason?: TreeValidationReason;
  brokenNodeId?: string;
}

export function validateLeafChain(
  allMessages: (ChatMessage | StoredMessage)[],
  sessionId: string,
  leafId: string | null | undefined,
): TreeValidationResult {
  if (!leafId) {
    return {
      valid: false,
      reason: "missing-leaf",
    };
  }

  const globalById = new Map(
    allMessages.map((message) => [
      message.id,
      message,
    ]),
  );

  const sessionMessages = allMessages.filter(
    (message) => (message as ChatMessage).sessionId === sessionId || (message as StoredMessage).chatId === sessionId,
  );

  const byId = new Map(
    sessionMessages.map((message) => [
      message.id,
      message,
    ]),
  );

  const leaf = globalById.get(leafId);

  if (!leaf) {
    return {
      valid: false,
      reason: "missing-leaf",
      brokenNodeId: leafId,
    };
  }

  const leafSessionId = (leaf as ChatMessage).sessionId ?? (leaf as StoredMessage).chatId;
  if (leafSessionId !== sessionId) {
    return {
      valid: false,
      reason: "wrong-session",
      brokenNodeId: leaf.id,
    };
  }

  const visited = new Set<string>();
  let current: (ChatMessage | StoredMessage) | undefined = leaf;

  while (current) {
    if (visited.has(current.id)) {
      return {
        valid: false,
        reason: "cycle",
        brokenNodeId: current.id,
      };
    }

    visited.add(current.id);

    if (!current.parentId) {
      return {
        valid: true,
      };
    }

    const parent = byId.get(current.parentId);

    if (!parent) {
      /**
       * Nếu parent tồn tại trong DB nhưng thuộc session khác,
       * vẫn coi là orphan trong session hiện tại.
       */
      const globalParent = globalById.get(current.parentId);

      return {
        valid: false,
        reason: globalParent
          ? "wrong-session"
          : "missing-parent",
        brokenNodeId: current.id,
      };
    }

    current = parent;
  }

  return {
    valid: false,
    reason: "missing-parent",
  };
}
