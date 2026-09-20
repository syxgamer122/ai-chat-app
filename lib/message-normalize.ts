/**
 * Chuẩn hoá mảng CoreMessage trước khi gửi upstream.
 *
 * Tách khỏi `app/api/chat/route.ts` (file ~2.000 dòng) vì đây là logic THUẦN:
 * không đọc env, không chạm mạng, không dùng closure của request. Nhờ vậy
 * kiểm thử được trực tiếp thay vì phải dựng cả route.
 *
 * Hai việc chính:
 *  1. `mergeSameRole` — gộp các message liên tiếp cùng vai. Nhiều gateway trả
 *     400 khi thấy hai message 'user' liền nhau.
 *  2. `normalize` — bỏ message rỗng và dồn mọi system message lên đầu; một số
 *     gateway cũng 400 nếu system nằm giữa cuộc hội thoại.
 */

import type { CoreMessage } from 'ai';

/** Đưa content về dạng mảng part để nối được. */
export const toParts = (content: CoreMessage['content']) =>
  typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;

/**
 * Gộp message liên tiếp CÙNG vai (chỉ user/assistant) thành một, chèn dòng
 * trống giữa hai phần để nội dung không dính liền nhau.
 */
export function mergeSameRole(messages: CoreMessage[]): CoreMessage[] {
  return messages.reduce<CoreMessage[]>((acc, cur) => {
    const last = acc[acc.length - 1];
    const mergeable =
      last && last.role === cur.role && (cur.role === 'user' || cur.role === 'assistant');
    if (!mergeable) {
      acc.push({ ...cur });
      return acc;
    }
    (last as any).content = [
      ...(toParts(last.content) as any[]),
      { type: 'text', text: '\n\n' },
      ...(toParts(cur.content) as any[]),
    ];
    return acc;
  }, []);
}

/**
 * Bỏ message rỗng, dồn system lên đầu, và cắt phần trước message user đầu
 * tiên. Trả mảng RỖNG khi không có user message nào — caller phải coi đó là
 * đầu vào không hợp lệ.
 */
export function normalize(messages: CoreMessage[]): CoreMessage[] {
  const cleaned = messages.filter((m) => {
    const parts = toParts(m.content) as any[];
    return parts.some((p) => p.type !== 'text' || (p.text ?? '').trim().length > 0);
  });
  // Gộp mọi system message rải rác về đầu — một số gateway 400 nếu system nằm giữa.
  const systems = cleaned.filter((m) => m.role === 'system');
  const rest = cleaned.filter((m) => m.role !== 'system');
  const firstUser = rest.findIndex((m) => m.role === 'user');
  if (firstUser === -1) return [];
  return [...systems, ...rest.slice(firstUser)];
}

/**
 * Chuẩn hóa các toolInvocation trong mảng Message trước khi chuyển đổi sang CoreMessage.
 * Nếu một invocation bị ngắt quãng do rẽ nhánh / đổi branch / reload trang (state !== 'result'),
 * gắn kết quả tổng hợp (synthetic aborted result) để convertToCoreMessages không ném lỗi
 * AI_MessageConversionError: ToolInvocation must have a result.
 */
export function normalizeMessageToolInvocations<T extends { role: string; toolInvocations?: any[] }>(
  messages: T[],
): T[] {
  if (!messages || messages.length === 0) return [];
  return messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.toolInvocations) || m.toolInvocations.length === 0) {
      return m;
    }
    const fixedInvocations = m.toolInvocations.map((inv) => {
      if (!inv || typeof inv !== 'object') return inv;
      if (inv.state !== 'result') {
        return {
          ...inv,
          state: 'result',
          result: inv.result ?? {
            error: 'Tool execution was aborted or interrupted by branch switch',
          },
        };
      }
      return inv;
    });
    return {
      ...m,
      toolInvocations: fixedInvocations,
    };
  });
}

/**
 * Chuẩn hóa cặp tool_call / tool_result (P2.4):
 * Khi rẽ nhánh (branching) cắt ngang một lượt thực thi tool, assistant message có
 * thể chứa tool_call nhưng thiếu tool_result tương ứng (hoặc ngược lại có tool_result mồ côi).
 *
 * Hàm này duyệt chuỗi CoreMessage và đảm bảo:
 * 1. Mọi tool-call trong assistant message đều được ghép cặp với tool-result tương ứng.
 * 2. Nếu thiếu tool-result (do chuyển nhánh / huỷ bỏ), chèn tool-result tổng hợp (synthetic aborted result).
 * 3. Loại bỏ các tool-result mồ côi (không có tool-call tương ứng phía trước) để chống lỗi 400 upstream.
 */
export function normalizeToolCallPairing(messages: CoreMessage[]): CoreMessage[] {
  if (!messages || messages.length === 0) return [];

  const result: CoreMessage[] = [];
  const pendingToolCalls = new Map<string, { toolCallId: string; toolName: string }>();

  const createSyntheticToolMessage = (
    toolCalls: Array<{ toolCallId: string; toolName: string }>,
  ): CoreMessage => ({
    role: 'tool',
    content: toolCalls.map((tc) => ({
      type: 'tool-result' as const,
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      result: { error: 'Tool execution was aborted or interrupted by branch switch' },
      isError: true,
    })),
  });

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];

    if (current.role === 'assistant') {
      if (pendingToolCalls.size > 0) {
        result.push(createSyntheticToolMessage(Array.from(pendingToolCalls.values())));
        pendingToolCalls.clear();
      }

      if (Array.isArray(current.content)) {
        for (const part of current.content) {
          const callId = (part as any).toolCallId || (part as any).id;
          if (part.type === 'tool-call' && callId) {
            pendingToolCalls.set(callId, {
              toolCallId: callId,
              toolName: (part as any).toolName ?? 'unknown_tool',
            });
          }
        }
      }
      result.push(current);
    } else if (current.role === 'tool') {
      const parts = Array.isArray(current.content) ? current.content : [];
      const validResults: any[] = [];

      for (const part of parts) {
        const callId = (part as any).toolCallId || (part as any).id;
        if (part.type === 'tool-result' && callId) {
          if (pendingToolCalls.has(callId)) {
            validResults.push(part);
            pendingToolCalls.delete(callId);
          }
        }
      }

      const nextMsg = messages[i + 1];
      if (!nextMsg || nextMsg.role !== 'tool') {
        for (const [, missing] of pendingToolCalls) {
          validResults.push({
            type: 'tool-result',
            toolCallId: missing.toolCallId,
            toolName: missing.toolName,
            result: { error: 'Tool execution was aborted or interrupted by branch switch' },
            isError: true,
          });
        }
        pendingToolCalls.clear();
      }

      if (validResults.length > 0) {
        result.push({
          role: 'tool',
          content: validResults,
        });
      }
    } else {
      if (pendingToolCalls.size > 0) {
        result.push(createSyntheticToolMessage(Array.from(pendingToolCalls.values())));
        pendingToolCalls.clear();
      }
      result.push(current);
    }
  }

  if (pendingToolCalls.size > 0) {
    result.push(createSyntheticToolMessage(Array.from(pendingToolCalls.values())));
    pendingToolCalls.clear();
  }

  return result;
}
