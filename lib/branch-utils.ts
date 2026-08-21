import { db, type StoredMessage } from "@/lib/db";
import {
  getClientId,
  nextLamport,
} from "@/lib/client-identity";
import type { ChatMessage } from "@/lib/chat-types";

export function getNextBranchMetadata(
  allMessages: (ChatMessage | StoredMessage)[],
  parentId: string | null,
) {
  const children = allMessages.filter(
    (message) => message.parentId === parentId,
  );

  const maxBranchOrder = children.reduce(
    (max, child) => Math.max(max, child.branchOrder ?? -1),
    -1,
  );

  const messageId = `msg_${crypto.randomUUID()}`;
  const createdAt = Date.now();
  const clientId = getClientId();

  return {
    messageId,
    branchOrder: maxBranchOrder + 1,
    branchTieBreaker: [
      String(createdAt),
      clientId,
      messageId,
    ].join(":"),
  };
}

export function compareSiblingMessages(
  a: ChatMessage | StoredMessage,
  b: ChatMessage | StoredMessage,
): number {
  const branchOrderA = a.branchOrder ?? Number.MAX_SAFE_INTEGER;
  const branchOrderB = b.branchOrder ?? Number.MAX_SAFE_INTEGER;

  if (branchOrderA !== branchOrderB) {
    return branchOrderA - branchOrderB;
  }

  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }

  return (
    (a.branchTieBreaker ?? a.id).localeCompare(
      b.branchTieBreaker ?? b.id,
    )
  );
}

export function getSortedChildren<T extends ChatMessage | StoredMessage>(
  allMessages: T[],
  parentId: string | null,
): T[] {
  return allMessages
    .filter((message) => message.parentId === parentId)
    .sort(compareSiblingMessages);
}

interface CreateForkInput {
  sessionId: string;
  parentId: string;
  content: string;
  attachments?: any[];
}

export async function createForkMessage({
  sessionId,
  parentId,
  content,
  attachments,
}: CreateForkInput): Promise<StoredMessage> {
  const allMessages = await db.messages
    .where("chatId")
    .equals(sessionId)
    .toArray();

  const branch = getNextBranchMetadata(allMessages, parentId);
  const clientId = getClientId();
  const revision = nextLamport();
  const now = Date.now();

  const message: StoredMessage = {
    id: branch.messageId,
    chatId: sessionId,
    role: "user",
    content,
    parentId,
    seq: allMessages.length + 1,
    branchOrder: branch.branchOrder,
    branchTieBreaker: branch.branchTieBreaker,
    createdAt: now,
    status: "complete",
    attachments,
  };

  await db.transaction(
    "rw",
    [db.messages, db.chats],
    async () => {
      await db.messages.put(message);

      const session = await db.chats.get(sessionId);

      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      await db.chats.put({
        ...session,
        activeLeafId: message.id,
        updatedAt: now,
        revision,
        lastWriterId: clientId,
      });
    },
  );

  return message;
}
