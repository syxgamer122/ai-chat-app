import { beforeEach, describe, expect, it } from 'vitest';
import {
  PROVIDER_NO_KEY_SENTINEL,
  clearStickyKey,
  getKeyPoolSnapshot,
  getKeyLabel,
  getStickyKey,
  markKeyFailure,
  markKeySuccess,
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

describe('synthetic key (sentinel) — không được ghi vào bảng health', () => {
  const snapshotLabelOf = (key: string) => getKeyLabel(key);
  const withEnvKeys = (run: () => void) => {
    const prevKeys = process.env.OPENAI_API_KEYS;
    const prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEYS = 'sk-test-aaaaaaaaaaaaaaaaaaaa';
    process.env.OPENAI_API_KEY = '';
    try {
      run();
    } finally {
      process.env.OPENAI_API_KEYS = prevKeys;
      process.env.OPENAI_API_KEY = prevKey;
    }
  };

  it('markKeyFailure(sentinel) không tạo health entry — pool snapshot sạch', () => {
    withEnvKeys(() => {
      // Reset trạng thái: không có cách export reset health map, nhưng sentinel
      // chưa từng tồn tại thì pool snapshot không có hàng nào mang label của nó.
      markKeyFailure(PROVIDER_NO_KEY_SENTINEL, 401);
      markKeyFailure(PROVIDER_NO_KEY_SENTINEL, 429);
      markKeyFailure('', 500);
      markKeySuccess(PROVIDER_NO_KEY_SENTINEL);

      const snap = getKeyPoolSnapshot();
      const sentinelLabel = snapshotLabelOf(PROVIDER_NO_KEY_SENTINEL);
      const emptyLabel = snapshotLabelOf('');
      // Pool chỉ chứa key thật từ env; sentinel/xâu rỗng không được xuất hiện
      // (nếu bị ghi, nó sẽ đẩy key thật xuống và nhiễu thứ tự xoay).
      expect(snap.some((s) => s.label === sentinelLabel)).toBe(false);
      expect(snap.some((s) => s.label === emptyLabel)).toBe(false);
      expect(snap).toHaveLength(1);
    });
  });

  it('markKeyFailure nhiều lần với sentinel không kéo cooldown/quarantine', () => {
    withEnvKeys(() => {
      for (let i = 0; i < 10; i++) markKeyFailure(PROVIDER_NO_KEY_SENTINEL, 401);
      // Nếu sentinel bị ghi, 3 lần 401 đã đẩy nó vào quarantine và pool snapshot
      // sẽ có thêm 1 hàng cooldown dương — kiểm tra không xảy ra.
      const snap = getKeyPoolSnapshot();
      expect(snap.filter((s) => s.quarantineRemainingMs > 0 || s.cooldownRemainingMs > 0)).toHaveLength(0);
    });
  });
});
