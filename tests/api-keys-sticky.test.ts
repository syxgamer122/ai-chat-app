import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearStickyKey,
  getStickyKey,
  markStickyKey,
  preferStickyKey,
  resetStickyKeys,
} from '@/lib/api-keys';

describe('sticky key theo hội thoại — prompt-cache affinity', () => {
  beforeEach(() => resetStickyKeys());

  it('mark → get; hội thoại khác không bị ảnh hưởng', () => {
    markStickyKey('chat-1', 'keyA');
    expect(getStickyKey('chat-1')).toBe('keyA');
    expect(getStickyKey('chat-2')).toBeUndefined();
  });

  it('preferStickyKey: đưa sticky lên đầu nếu còn trong danh sách', () => {
    expect(preferStickyKey(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(preferStickyKey(['a', 'b'], 'a')).toEqual(['a', 'b']); // đã ở đầu
    expect(preferStickyKey(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });

  it('sticky key đang NGHỈ (không trong list khả dụng) thì KHÔNG ép — sức khỏe thắng', () => {
    // keyB đang cooldown nên getKeyCandidates sẽ không trả nó — prefer phải
    // giữ nguyên danh sách thay vì chèn key nghỉ vào.
    expect(preferStickyKey(['a', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('fail → clearStickyKey; không clear thì lượt sau vẫn ghim', () => {
    markStickyKey('chat-1', 'keyB');
    clearStickyKey('chat-1');
    expect(getStickyKey('chat-1')).toBeUndefined();
  });

  it('conversationId rỗng là no-op an toàn', () => {
    markStickyKey(undefined, 'keyA');
    expect(getStickyKey(undefined)).toBeUndefined();
    clearStickyKey(undefined); // không ném
  });
});
