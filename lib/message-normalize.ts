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
