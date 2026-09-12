/**
 * P1.2 — Persist Dexie dưới dạng subscriber riêng (không nằm trong component).
 *
 * Mọi message mới LUÔN đi qua `db.appendMessage` — giữ bất biến cấp seq /
 * branchOrder nguyên tử trong transaction. Tool result không tạo row riêng
 * (role 'data' UI không render) mà fold vào `toolInvocations` của assistant
 * ngay trước nó — route dùng field này dựng lại tool-call parts sau khi reload.
 */

import {
  ROOT_KEY,
  appendMessage,
  db,
  type StoredMessage,
  type StoredToolInvocation,
} from '@/lib/db';
import type { AgentEvent, AgentMessage } from './loop';

export interface PersistenceSubscriberOptions {
  /** Hội thoại đang chạy. */
  chatId: string;
  /** Parent của user message ĐẦU TIÊN trong run (mặc định root). */
  parentId?: string | null;
  /** Log lỗi persist (không được làm fail cả turn). */
  onError?: (error: unknown, event: AgentEvent) => void;
}

function toStoredRole(role: AgentMessage['role']): StoredMessage['role'] {
  return role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'data';
}

/** Fold các toolResult liền sau assistant thành StoredToolInvocation[]. */
function toolInvocationsOf(
  assistant: AgentMessage,
  following: readonly AgentMessage[],
): StoredToolInvocation[] | undefined {
  const invocations: StoredToolInvocation[] = [];
  for (const msg of following) {
    if (msg.role !== 'toolResult' || !msg.toolResult) break;
    const call = assistant.toolCalls?.find((c) => c.id === msg.toolResult!.toolCallId);
    invocations.push({
      toolCallId: msg.toolResult.toolCallId,
      toolName: msg.toolResult.name,
      args: call?.args,
      state: msg.toolResult.isError ? 'error' : 'call-result',
      result: msg.toolResult.content,
    });
  }
  return invocations.length > 0 ? invocations : undefined;
}

/**
 * Tạo subscriber. Mỗi instance có `seen` riêng — safe với retry/continue:
 * message đã persist rồi thì bỏ qua (check cả id trên DB để survive remount).
 */
export function createPersistenceSubscriber(
  opts: PersistenceSubscriberOptions,
): (event: AgentEvent) => Promise<void> {
  const seen = new Set<string>();

  return async (event: AgentEvent) => {
    if (event.type !== 'agent_end') return;

    let lastUserId: string | null = null;
    let lastAssistantId: string | null = null;
    let firstUser = true;

    for (let i = 0; i < event.messages.length; i++) {
      const msg = event.messages[i];
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;
      if (seen.has(msg.id) || (await db.messages.get(msg.id))) continue;

      // Chain tuyến tính: user nối sau assistant trước đó; assistant nối sau
      // user nó trả lời. Nhánh/fork đặt `parentId` cho user đầu của run.
      const parentId =
        msg.role === 'user'
          ? (firstUser ? (opts.parentId ?? ROOT_KEY) : (lastAssistantId ?? ROOT_KEY))
          : (lastUserId ?? ROOT_KEY);
      if (msg.role === 'user') firstUser = false;

      const toolInvocations =
        msg.role === 'assistant'
          ? toolInvocationsOf(msg, event.messages.slice(i + 1))
          : undefined;

      seen.add(msg.id);
      try {
        const finishReason: StoredMessage['finishReason'] =
          event.stopReason === 'aborted' ? 'abort' : 'stop';
        await appendMessage({
          id: msg.id,
          chatId: opts.chatId,
          role: toStoredRole(msg.role),
          content: msg.content,
          parentId,
          status: event.stopReason === 'aborted' ? 'aborted' : 'complete',
          finishReason,
          ...(toolInvocations ? { toolInvocations } : {}),
        });
      } catch (error) {
        opts.onError?.(error, event);
      }

      if (msg.role === 'user') lastUserId = msg.id;
      else lastAssistantId = msg.id;
    }
  };
}