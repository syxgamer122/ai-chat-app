import { ROOT_KEY, type StoredMessage } from "@/lib/db";

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

/**
 * Kiểm tra chuỗi từ leaf leo lên root có nguyên vẹn không.
 * Row trong DB luôn mang parentId = '__ROOT__' ở cấp gốc (không bao giờ null)
 * — sentinel này là điểm kết thúc hợp lệ của chuỗi.
 */
export function validateLeafChain(
  allMessages: StoredMessage[],
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
    allMessages.map((message) => [message.id, message]),
  );

  const sessionMessages = allMessages.filter(
    (message) => message.chatId === sessionId,
  );

  const byId = new Map(
    sessionMessages.map((message) => [message.id, message]),
  );

  const leaf = globalById.get(leafId);

  if (!leaf) {
    return {
      valid: false,
      reason: "missing-leaf",
      brokenNodeId: leafId,
    };
  }

  if (leaf.chatId !== sessionId) {
    return {
      valid: false,
      reason: "wrong-session",
      brokenNodeId: leaf.id,
    };
  }

  const visited = new Set<string>();
  let current: StoredMessage | undefined = leaf;

  while (current) {
    if (visited.has(current.id)) {
      return {
        valid: false,
        reason: "cycle",
        brokenNodeId: current.id,
      };
    }

    visited.add(current.id);

    if (current.parentId === ROOT_KEY || !current.parentId) {
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
