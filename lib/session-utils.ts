import { db, type ChatSession } from "@/lib/db";
import { chatBroadcast } from "@/lib/chat-broadcast";
import {
  getClientId,
  nextLamport,
} from "@/lib/client-identity";

export async function setSessionActiveLeaf(
  sessionId: string,
  activeLeafId: string,
): Promise<ChatSession> {
  const clientId = getClientId();
  const revision = nextLamport();
  const now = Date.now();

  const session = await db.chats.get(sessionId);

  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const updatedSession: ChatSession = {
    ...session,
    activeLeafId,
    updatedAt: now,
    revision,
    lastWriterId: clientId,
  };

  await db.chats.put(updatedSession);

  chatBroadcast.publish({
    type: "branch-switched",
    sessionId,
    activeLeafId,
    mutationId: crypto.randomUUID(),
    revision,
  });

  chatBroadcast.publish({
    type: "session-invalidated",
    sessionId,
    mutationId: crypto.randomUUID(),
    reason: "branch-switched",
    revision,
  });

  return updatedSession;
}
