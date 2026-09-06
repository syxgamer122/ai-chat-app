/**
 * RED TEAM — sanitizeModelFavorites / sanitizeRecentModels (lib/model-meta.ts).
 *
 * Mô phỏng localStorage bị sửa tay / hash cũ / dữ liệu gateway rác: entry
 * prototype-key, entry mảng lồng, mảng 10.000 phần tử, cặp (id, providerId)
 * trùng, ts vô hạn. Sau đó ĐUỔI KẾT QUẢ qua upsertRecent → toggleFavorite →
 * buildPickerSections (chuỗi nhiễm chéo) và đóng băng mảng đầu vào.
 *
 * Chuẩn phòng thủ: không throw, không ô nhiễm Object.prototype, dedupe,
 * cắt cap, giới hạn thời gian (bắt hồi quy bậc hai).
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_FAVORITES,
  MAX_RECENTS,
  buildPickerSections,
  sanitizeModelFavorites,
  sanitizeRecentModels,
  toggleFavorite,
  upsertRecent,
  type ModelOption,
} from '@/lib/model-meta';

describe('RED TEAM sanitize — entry prototype-key và mảng lồng', () => {
  it('id "__proto__"/"constructor" được giữ như chuỗi thường, không ô nhiễm Object.prototype', () => {
    const out = sanitizeModelFavorites([
      { id: '__proto__', providerId: 'p1' },
      { id: 'constructor', providerId: 'p1' },
    ]);
    expect(out).toEqual([
      { id: '__proto__', providerId: 'p1' },
      { id: 'constructor', providerId: 'p1' },
    ]);
    expect(({} as Record<string, unknown>).id).toBeUndefined();
    expect(({} as Record<string, unknown>).providerId).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('p1');
  });

  it('entry là mảng lồng / primitive / null bị bỏ, không throw', () => {
    const out = sanitizeModelFavorites([
      [['id', 'x']] as unknown as never,
      ['a', 'b'] as unknown as never,
      42 as unknown as never,
      null,
      'x' as unknown as never,
      { id: 'ok', providerId: 'p1' },
    ] as unknown[]);
    expect(out).toEqual([{ id: 'ok', providerId: 'p1' }]);
  });

  it('entry đọc id qua prototype chain vẫn an toàn (giá trị được copy sang object thường)', () => {
    const inherited = Object.create({ id: 'ke-thua', providerId: 'p1' }) as object;
    const out = sanitizeModelFavorites([inherited]);
    expect(out).toEqual([{ id: 'ke-thua', providerId: 'p1' }]);
    expect(Object.getPrototypeOf(out[0]!)).toBe(Object.prototype);
  });

  it('khóa lạ của entry bị vứt, chỉ giữ id/providerId (+ts với recents)', () => {
    const out = sanitizeModelFavorites([
      { id: 'ok', providerId: 'p1', evil: 'x', toJSON: 'y' } as never,
    ]);
    expect(out).toEqual([{ id: 'ok', providerId: 'p1' }]);

    const recs = sanitizeRecentModels([
      { id: 'ok', providerId: 'p1', ts: 5, evil: 'x' } as never,
    ]);
    expect(recs).toEqual([{ id: 'ok', providerId: 'p1', ts: 5 }]);
  });
});

describe('RED TEAM sanitize — ts rác', () => {
  it('Infinity / NaN / ts chuỗi bị từ chối; -0 hữu hạn nên được giữ', () => {
    const out = sanitizeRecentModels([
      { id: 'inf', providerId: 'p1', ts: Number.POSITIVE_INFINITY },
      { id: 'nan', providerId: 'p1', ts: Number.NaN },
      { id: 'str', providerId: 'p1', ts: '1' as unknown as number },
      { id: 'negzero', providerId: 'p1', ts: -0 },
      { id: 'ok', providerId: 'p1', ts: 1 },
    ]);
    expect(out.map((r) => r.id)).toEqual(['negzero', 'ok']);
    expect(Number.isFinite(out[0]!.ts)).toBe(true);
  });
});

describe('RED TEAM sanitize — mảng 10.000 entry (perf + cap)', () => {
  it('favorites 10k entry hợp lệ: dừng ở đúng cap 30, giữ 30 mục đầu, dưới 200ms', () => {
    const raw = Array.from({ length: 10_000 }, (_, i) => ({
      id: `m${i}`,
      providerId: 'p1',
    }));
    const t0 = performance.now();
    const out = sanitizeModelFavorites(raw);
    const elapsed = performance.now() - t0;
    expect(out).toHaveLength(MAX_FAVORITES);
    expect(out[0]).toEqual({ id: 'm0', providerId: 'p1' });
    expect(out[29]).toEqual({ id: 'm29', providerId: 'p1' });
    expect(elapsed).toBeLessThan(200);
  });

  it('favorites 10k entry toàn bản sao của entry đầu: không phình, dưới 200ms', () => {
    const raw = Array.from({ length: 10_000 }, () => ({
      id: 'dup',
      providerId: 'p1',
    }));
    const t0 = performance.now();
    const out = sanitizeModelFavorites(raw);
    const elapsed = performance.now() - t0;
    expect(out).toEqual([{ id: 'dup', providerId: 'p1' }]);
    expect(elapsed).toBeLessThan(200);
  });

  it('recents 10k entry: dừng ở cap 6, dưới 200ms', () => {
    const raw = Array.from({ length: 10_000 }, (_, i) => ({
      id: `r${i}`,
      providerId: 'p1',
      ts: i,
    }));
    const t0 = performance.now();
    const out = sanitizeRecentModels(raw);
    const elapsed = performance.now() - t0;
    expect(out).toHaveLength(MAX_RECENTS);
    expect(out.map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
    expect(elapsed).toBeLessThan(200);
  });

  it('cặp (id, providerId) trùng lặp được dedupe, cùng id khác provider là 2 mục', () => {
    const out = sanitizeModelFavorites([
      { id: 'a', providerId: 'p1' },
      { id: 'a', providerId: 'p1' },
      { id: 'a', providerId: 'p2' },
      { id: 'b', providerId: 'p1' },
    ]);
    expect(out).toEqual([
      { id: 'a', providerId: 'p1' },
      { id: 'a', providerId: 'p2' },
      { id: 'b', providerId: 'p1' },
    ]);
  });
});

describe('RED TEAM sanitize — mảng đầu vào bị đóng băng', () => {
  it('Object.freeze đầu vào: không throw, mảng gốc không đổi', () => {
    const favs = Object.freeze([
      { id: 'a', providerId: 'p1' },
      { id: 'bad' } as never,
    ]);
    const snapshot = JSON.stringify(favs);
    expect(() => sanitizeModelFavorites(favs)).not.toThrow();
    expect(JSON.stringify(favs)).toBe(snapshot);

    const recs = Object.freeze([{ id: 'a', providerId: 'p1', ts: 1 }]);
    const recsSnapshot = JSON.stringify(recs);
    expect(() => sanitizeRecentModels(recs)).not.toThrow();
    expect(JSON.stringify(recs)).toBe(recsSnapshot);
  });
});

describe('RED TEAM — chuỗi nhiễm chéo sanitize → upsert → toggle → buildPickerSections', () => {
  const models: ModelOption[] = [
    { id: 'gpt-5-6-sol', label: 'GPT Sol' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  ];

  it('kết quả sanitize nhiễm prototype-key sống sót qua cả chuỗi mà không tạo hàng ma', () => {
    const favs = sanitizeModelFavorites([
      { id: '__proto__', providerId: 'p1' },
      { id: 'gpt-5-6-sol', providerId: 'srv' },
      { id: 'gpt-5-6-sol', providerId: 'srv' },
    ]);
    const recs = sanitizeRecentModels([
      { id: 'claude-sonnet-5', providerId: 'srv', ts: Number.POSITIVE_INFINITY },
      { id: 'claude-sonnet-5', providerId: 'srv', ts: 10 },
    ]);
    const recs2 = upsertRecent(recs, 'gpt-5-6-sol', 'srv', 20);
    const favs2 = toggleFavorite(favs, 'claude-sonnet-5', 'srv');
    const sections = buildPickerSections(models, {
      favorites: favs2,
      recents: recs2,
      providerId: 'srv',
      currentId: 'gpt-5-6-sol',
    });
    const favoriteIds = sections.find((s) => s.key === 'favorite')?.items.map((m) => m.id);
    expect(favoriteIds).toEqual(['claude-sonnet-5', 'gpt-5-6-sol']);
    const recentIds = sections.find((s) => s.key === 'recent')?.items.map((m) => m.id);
    expect(recentIds).toEqual(['claude-sonnet-5']);
    const allIds = sections.flatMap((s) => s.items.map((m) => m.id));
    expect(allIds).not.toContain('__proto__');
  });
});
