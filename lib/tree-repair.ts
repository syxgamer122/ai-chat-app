import { db, ROOT_KEY, type ChatSession, type StoredMessage } from "@/lib/db";
import { findDeepestLeafId } from "@/lib/tree-utils";
import {
  getClientId,
  nextLamport,
} from "@/lib/client-identity";
import {
  validateLeafChain,
} from "@/lib/tree-validation";
import { chatBroadcast } from "@/lib/chat-broadcast";
import { logChatEvent } from "@/lib/chat-logger";

function compareMessagesForFallback(
  a: StoredMessage,
  b: StoredMessage,
): number {
  if (a.createdAt !== b.createdAt) {
    return b.createdAt - a.createdAt;
  }

  return b.id.localeCompare(a.id);
}

function findFallbackLeafId(
  session: ChatSession,
  messages: StoredMessage[],
): string | null {
  const sessionMessages = messages.filter(
    (message) => message.chatId === session.id,
  );

  if (sessionMessages.length === 0) {
    return null;
  }

  /**
   * Ưu tiên deepest leaf từ root. Chọn root MỚI NHẤT (regenerate/edit tạo
   * nhiều root anh em — lấy root đầu tiên sẽ nhảy về nhánh cổ nhất).
   * Row trong DB luôn mang sentinel '__ROOT__' — không bao giờ là null.
   */
  const roots = sessionMessages
    .filter((m) => m.parentId === ROOT_KEY)
    .sort(compareMessagesForFallback);
  const root = roots[0];
  if (root) {
    const deepestFromRoot = findDeepestLeafId(
      sessionMessages,
      root.id,
    );

    if (deepestFromRoot) {
      const validation = validateLeafChain(
        sessionMessages,
        session.id,
        deepestFromRoot,
      );

      if (validation.valid) {
        return deepestFromRoot;
      }
    }
  }

  /**
   * Tìm tất cả leaf:
   * message không có child nào trong cùng session.
   */
  const parentIds = new Set(
    sessionMessages
      .map((message) => message.parentId)
      .filter((parentId): parentId is string => Boolean(parentId)),
  );

  const leaves = sessionMessages
    .filter((message) => !parentIds.has(message.id))
    .sort(compareMessagesForFallback);

  for (const leaf of leaves) {
    const validation = validateLeafChain(
      sessionMessages,
      session.id,
      leaf.id,
    );

    if (validation.valid) {
      return leaf.id;
    }
  }

  /**
   * Fallback cuối cùng: dựng thread từ message mới nhất.
   * Nếu chain lỗi thì trả null để UI hiển thị empty/error state.
   */
  const newest = [...sessionMessages].sort(
    compareMessagesForFallback,
  )[0];

  const newestValidation = validateLeafChain(
    sessionMessages,
    session.id,
    newest.id,
  );

  return newestValidation.valid ? newest.id : null;
}

export interface RepairResult {
  changed: boolean;
  reason:
    | "none"
    | "missing-session"
    | "repaired-active-leaf"
    | "cleared-active-leaf";
  session: ChatSession | null;
  previousActiveLeafId?: string | null;
  nextActiveLeafId?: string | null;
}

export async function repairSessionIfNeeded(
  sessionId: string,
): Promise<RepairResult> {
  const [session, messages] = await Promise.all([
    db.chats.get(sessionId),
    db.messages
      .where("chatId")
      .equals(sessionId)
      .toArray(),
  ]);

  if (!session) {
    return {
      changed: false,
      reason: "missing-session",
      session: null,
    };
  }

  const validation = validateLeafChain(
    messages,
    session.id,
    session.activeLeafId,
  );

  if (validation.valid) {
    return {
      changed: false,
      reason: "none",
      session,
    };
  }

  const fallbackLeafId = findFallbackLeafId(
    session,
    messages,
  );

  const previousActiveLeafId = session.activeLeafId ?? null;

  if (fallbackLeafId === previousActiveLeafId) {
    return {
      changed: false,
      reason: "none",
      session,
    };
  }

  const clientId = getClientId();
  const revision = nextLamport();
  const updatedAt = Date.now();

  const repairedSession: ChatSession = {
    ...session,
    activeLeafId: fallbackLeafId ?? undefined,
    updatedAt,
    revision,
    lastWriterId: clientId,
  };

  await db.chats.put(repairedSession);

  const reason = fallbackLeafId
    ? "repaired-active-leaf"
    : "cleared-active-leaf";

  logChatEvent({
    type: "tree-repair",
    sessionId,
    revision,
    clientId,
    details: {
      previousActiveLeafId,
      nextActiveLeafId: fallbackLeafId,
      reason,
    },
  });

  return {
    changed: true,
    reason,
    session: repairedSession,
    previousActiveLeafId,
    nextActiveLeafId: fallbackLeafId,
  };
}

export async function repairAndBroadcastSession(
  sessionId: string,
): Promise<RepairResult> {
  const result = await repairSessionIfNeeded(sessionId);

  if (!result.changed || !result.session) {
    return result;
  }

  chatBroadcast.publish({
    type: "session-invalidated",
    sessionId,
    mutationId: `repair_${crypto.randomUUID()}`,
    revision: result.session.revision ?? 0,
    reason: "repair",
  });

  return result;
}
