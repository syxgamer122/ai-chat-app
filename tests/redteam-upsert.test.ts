/**
 * RED TEAM — upsertRecent / toggleFavorite (lib/model-meta.ts).
 *
 * Khuấy dữ liệu: churn cùng id 100 lần, luân phiên 2 provider cùng id,
 * thao tác ngay tại cap, đồng hồ chạy lùi (ts bằng/thấp hơn), mảng đầu vào
 * bị Object.freeze. Chuẩn phòng thủ: bất biến (không sửa đầu vào), xác định
 * (cùng vào ra cùng kết quả), cap giữ nguyên ngữ nghĩa, frozen không throw.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_FAVORITES,
  MAX_RECENTS,
  toggleFavorite,
  upsertRecent,
  type ModelFavorite,
  type RecentModel,
} from '@/lib/model-meta';

describe('RED TEAM upsertRecent — churn cùng id', () => {
  it('chọn lại cùng (id, providerId) 100 lần: vẫn 1 entry, không phình', () => {
    let l = upsertRecent([], 'a', 'p1', 1);
    for (let i = 2; i <= 101; i++) {
      l = upsertRecent(l, 'a', 'p1', i);
    }
    expect(l).toEqual([{ id: 'a', providerId: 'p1', ts: 101 }]);
  });

  it('kết quả ổn định: cùng đầu vào gọi 2 lần ra 2 bản deep-equal và khác reference', () => {
    const base = upsertRecent([], 'a', 'p1', 1);
    const x = upsertRecent(base, 'b', 'p1', 2);
    const y = upsertRecent(base, 'b', 'p1', 2);
    expect(x).toEqual(y);
    expect(x).not.toBe(y);
  });
});

describe('RED TEAM upsertRecent — luân phiên 2 provider cùng id', () => {
  it('a/p1 → a/p2 → a/p1: mục được chạm đứng đầu, cả hai còn sống', () => {
    let l = upsertRecent([], 'a', 'p1', 1);
    l = upsertRecent(l, 'a', 'p2', 2);
    l = upsertRecent(l, 'a', 'p1', 3);
    expect(l).toEqual([
      { id: 'a', providerId: 'p1', ts: 3 },
      { id: 'a', providerId: 'p2', ts: 2 },
    ]);
  });
});

describe('RED TEAM upsertRecent — đồng hồ chạy lùi', () => {
  const base: RecentModel[] = [
    { id: 'a', providerId: 'p1', ts: 100 },
    { id: 'b', providerId: 'p1', ts: 90 },
  ];

  it('ts mới bằng ts cũ: mục vẫn lên đầu, không đảo thứ tự phần còn lại', () => {
    const l = upsertRecent(base, 'b', 'p1', 90);
    expect(l).toEqual([
      { id: 'b', providerId: 'p1', ts: 90 },
      { id: 'a', providerId: 'p1', ts: 100 },
    ]);
  });

  it('ts mới thấp hơn mọi ts cũ: vẫn lên đầu (thứ tự theo lần dùng, không sort theo ts)', () => {
    const l = upsertRecent(base, 'c', 'p1', 1);
    expect(l[0]).toEqual({ id: 'c', providerId: 'p1', ts: 1 });
  });

  it('ts cũ bị sửa thành số lớn hơn vẫn bị đè lên đầu với ts mới', () => {
    const l = upsertRecent(base, 'a', 'p1', 50);
    expect(l).toEqual([
      { id: 'a', providerId: 'p1', ts: 50 },
      { id: 'b', providerId: 'p1', ts: 90 },
    ]);
  });
});

describe('RED TEAM upsertRecent — cap đúng biên', () => {
  it('list đúng 6 mục, thêm mới: mục cũ nhất (cuối) rơi, còn 6', () => {
    let l: RecentModel[] = [];
    for (let i = 0; i < MAX_RECENTS; i++) {
      l = upsertRecent(l, `m${i}`, 'p1', i);
    }
    expect(l).toHaveLength(MAX_RECENTS);
    const next = upsertRecent(l, 'moi', 'p1', 99);
    expect(next).toHaveLength(MAX_RECENTS);
    expect(next[0]?.id).toBe('moi');
    expect(next.some((r) => r.id === 'm0')).toBe(false);
  });

  it('list đúng 6 mục, chạm lại mục giữa: không đổi độ dài, mục đó lên đầu', () => {
    let l: RecentModel[] = [];
    for (let i = 0; i < MAX_RECENTS; i++) {
      l = upsertRecent(l, `m${i}`, 'p1', i);
    }
    const next = upsertRecent(l, 'm3', 'p1', 99);
    expect(next).toHaveLength(MAX_RECENTS);
    expect(next[0]?.id).toBe('m3');
  });
});

describe('RED TEAM toggleFavorite — churn và cap', () => {
  it('bật/tắt 100 lần kết thúc tắt: về mảng rỗng, không rác', () => {
    let l: ModelFavorite[] = [];
    for (let i = 0; i < 100; i++) {
      l = toggleFavorite(l, 'a', 'p1');
      l = toggleFavorite(l, 'a', 'p1');
    }
    expect(l).toEqual([]);
  });

  it('đúng 30 favorite, thêm mới: rơi mục CUỐI, đủ 30', () => {
    let l: ModelFavorite[] = [];
    for (let i = 0; i < MAX_FAVORITES; i++) {
      l = toggleFavorite(l, `f${i}`, 'p1');
    }
    expect(l).toHaveLength(MAX_FAVORITES);
    const next = toggleFavorite(l, 'f-moi', 'p1');
    expect(next).toHaveLength(MAX_FAVORITES);
    expect(next[0]?.id).toBe('f-moi');
    expect(next.some((f) => f.id === 'f0')).toBe(false);
    expect(next.some((f) => f.id === `f${MAX_FAVORITES - 1}`)).toBe(true);
  });

  it('đúng 30 favorite, tắt một mục: còn 29, không tự thêm lại', () => {
    let l: ModelFavorite[] = [];
    for (let i = 0; i < MAX_FAVORITES; i++) {
      l = toggleFavorite(l, `f${i}`, 'p1');
    }
    const next = toggleFavorite(l, 'f10', 'p1');
    expect(next).toHaveLength(MAX_FAVORITES - 1);
    expect(next.some((f) => f.id === 'f10')).toBe(false);
  });
});

describe('RED TEAM — đầu vào bị Object.freeze', () => {
  it('upsertRecent với mảng frozen: không throw, mảng gốc nguyên vẹn', () => {
    const input = Object.freeze([
      { id: 'a', providerId: 'p1', ts: 1 },
    ] as RecentModel[]);
    const snapshot = JSON.stringify(input);
    let out: RecentModel[] = [];
    expect(() => {
      out = upsertRecent(input, 'b', 'p1', 2);
    }).not.toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).toHaveLength(2);
  });

  it('toggleFavorite với mảng frozen: không throw, mảng gốc nguyên vẹn', () => {
    const input = Object.freeze([{ id: 'a', providerId: 'p1' }] as ModelFavorite[]);
    const snapshot = JSON.stringify(input);
    let out: ModelFavorite[] = [];
    expect(() => {
      out = toggleFavorite(input, 'b', 'p1');
    }).not.toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).toHaveLength(2);
  });
});
