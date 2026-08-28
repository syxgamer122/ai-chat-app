/**
 * Logic chuẩn hoá message trước khi gửi upstream. Trước đây nằm trong
 * app/api/chat/route.ts (~2.000 dòng) nên không test trực tiếp được.
 */

import { describe, expect, it } from 'vitest';
import type { CoreMessage } from 'ai';
import { mergeSameRole, normalize, toParts } from '@/lib/message-normalize';

const u = (text: string): CoreMessage => ({ role: 'user', content: text });
const a = (text: string): CoreMessage => ({ role: 'assistant', content: text });
const s = (text: string): CoreMessage => ({ role: 'system', content: text });

describe('toParts', () => {
  it('string → mảng một part text', () => {
    expect(toParts('xin chào')).toEqual([{ type: 'text', text: 'xin chào' }]);
  });

  it('mảng giữ nguyên', () => {
    const parts = [{ type: 'text' as const, text: 'a' }];
    expect(toParts(parts as never)).toBe(parts);
  });
});

describe('mergeSameRole', () => {
  /* Nhiều gateway trả 400 khi thấy hai message cùng vai liền nhau. */
  it('gộp hai user liên tiếp, chèn dòng trống ở giữa', () => {
    const out = mergeSameRole([u('một'), u('hai')]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([
      { type: 'text', text: 'một' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'hai' },
    ]);
  });

  it('vai khác nhau thì KHÔNG gộp', () => {
    expect(mergeSameRole([u('hỏi'), a('đáp'), u('hỏi tiếp')])).toHaveLength(3);
  });

  it('không gộp system (chỉ user/assistant mới gộp)', () => {
    expect(mergeSameRole([s('a'), s('b')])).toHaveLength(2);
  });

  it('gộp chuỗi dài 3 message cùng vai', () => {
    const out = mergeSameRole([a('x'), a('y'), a('z')]);
    expect(out).toHaveLength(1);
    expect((out[0].content as unknown[]).length).toBe(5); // 3 nội dung + 2 ngăn cách
  });

  it('KHÔNG làm hỏng mảng gốc (không mutate input)', () => {
    const input: CoreMessage[] = [u('một'), u('hai')];
    mergeSameRole(input);
    expect(input[0].content).toBe('một');
  });

  it('mảng rỗng → rỗng', () => {
    expect(mergeSameRole([])).toEqual([]);
  });
});

describe('normalize', () => {
  it('dồn system lên đầu (gateway 400 nếu system nằm giữa)', () => {
    const out = normalize([u('hỏi'), s('quy tắc'), a('đáp')]);
    expect(out[0].role).toBe('system');
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('bỏ message text rỗng/toàn khoảng trắng', () => {
    const out = normalize([u('thật'), u('   '), a('')]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('thật');
  });

  it('cắt phần trước user message đầu tiên', () => {
    // assistant mở đầu không hợp lệ với hầu hết gateway.
    const out = normalize([a('chào trước'), u('câu hỏi')]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  it('KHÔNG có user nào → trả rỗng (đầu vào không hợp lệ)', () => {
    expect(normalize([s('quy tắc'), a('đáp')])).toEqual([]);
    expect(normalize([])).toEqual([]);
  });

  it('giữ part không phải text (ảnh) dù không có chữ', () => {
    const withImage: CoreMessage = {
      role: 'user',
      content: [{ type: 'image', image: 'https://x/a.png' }] as never,
    };
    expect(normalize([withImage])).toHaveLength(1);
  });

  it('giữ nhiều system, tất cả đều lên đầu', () => {
    const out = normalize([s('a'), u('hỏi'), s('b')]);
    expect(out.map((m) => m.role)).toEqual(['system', 'system', 'user']);
  });
});
