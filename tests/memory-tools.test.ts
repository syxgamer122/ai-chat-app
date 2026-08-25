import { describe, expect, it } from 'vitest';
import { searchMemories } from '@/lib/agent-tools';
import {
  isToolUnsupported,
  markToolsUnsupported,
  resetToolSupportCache,
} from '@/lib/tool-support-cache';

const MEMS = [
  { id: '1', text: 'Tôi thích trả lời ngắn gọn' },
  { id: '2', text: 'Ngôn ngữ lập trình yêu thích là TypeScript' },
  { id: '3', text: 'Sinh sống tại Đà Nẵng' },
];

describe('searchMemories', () => {
  it('khớp theo từ khóa, xếp điểm giảm dần', () => {
    const out = searchMemories(MEMS, 'ngôn ngữ lập trình');
    expect(out[0].id).toBe('2');
    expect(out.length).toBeLessThanOrEqual(5);
  });

  it('từ khóa ngắn (<2 ký tự) bị bỏ — không match rác', () => {
    expect(searchMemories(MEMS, 'a 1')).toEqual([]);
  });

  it('không khớp → mảng rỗng', () => {
    expect(searchMemories(MEMS, 'mưa bão Kyoto')).toEqual([]);
  });

  it('query rỗng → rỗng (không trả toàn bộ)', () => {
    expect(searchMemories(MEMS, '')).toEqual([]);
  });
});

describe('tool-support-cache', () => {
  it('chưa đánh dấu → false; đánh dấu rồi → true trong TTL', () => {
    resetToolSupportCache();
    const now = 1_000_000;
    expect(isToolUnsupported('https://gw', 'model-a', now)).toBe(false);
    markToolsUnsupported('https://gw', 'model-a', now);
    expect(isToolUnsupported('https://gw', 'model-a', now + 1000)).toBe(true);
    // model khác không dính
    expect(isToolUnsupported('https://gw', 'model-b', now + 1000)).toBe(false);
  });

  it('hết TTL → tự hồi phục (thử lại tools)', () => {
    resetToolSupportCache();
    const now = 1_000_000;
    markToolsUnsupported('https://g2', 'm', now);
    // TTL 10 phút
    expect(isToolUnsupported('https://g2', 'm', now + 10 * 60_000 - 1)).toBe(true);
    expect(isToolUnsupported('https://g2', 'm', now + 10 * 60_000)).toBe(false);
  });
});
