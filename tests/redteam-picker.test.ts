/**
 * RED TEAM - buildPickerSections (lib/model-meta.ts).
 *
 * Đầu vào đối kháng: model id trùng lặp, id đứng cả trong favorites lẫn
 * recents lẫn currentId, favorites trỏ mọi model, query 10k ký tự,
 * providerId undefined, isBuiltinCatalog lệch với nguồn models. Mỗi section
 * phải không lặp id (một model đúng một hàng), không throw, và 1000 lần gọi
 * với 200 model phải chạy dưới 500ms (bắt hồi quy bậc hai).
 */
import { describe, expect, it } from 'vitest';
import {
  buildPickerSections,
  type ModelOption,
} from '@/lib/model-meta';

const m = (id: string, over: Partial<ModelOption> = {}): ModelOption => ({
  id,
  label: id,
  ...over,
});

/** Mọi section không được lặp id: một model tối đa một hàng mỗi section. */
function assertNoDuplicateIds(sections: ReturnType<typeof buildPickerSections>, context: string) {
  for (const section of sections) {
    const ids = section.items.map((i) => i.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dup, `${context}: section "${section.key}" lặp id [${dup.join(', ')}]`).toEqual([]);
  }
}

describe('RED TEAM buildPickerSections - id trùng lặp', () => {
  it('models chứa 2 entry cùng id: mỗi section vẫn chỉ một hàng cho id đó', () => {
    const models = [m('glm-5'), m('glm-5', { label: 'GLM 5 (bản cop py)' })];
    const sections = buildPickerSections(models, { providerId: 'p1' });
    assertNoDuplicateIds(sections, 'models trùng id');
  });

  it('models cùng id nhưng nhóm khác nhau (media vs thường): id không xuất hiện 2 section', () => {
    const models = [m('x-image', { media: 'image' }), m('x-image')];
    const sections = buildPickerSections(models, { providerId: 'p1' });
    const occurrences = sections
      .flatMap((s) => s.items.map((i) => i.id))
      .filter((id) => id === 'x-image');
    expect(occurrences).toHaveLength(1);
  });

  it('favorites chứa cùng id theo 2 provider (providerId không scoped): một hàng', () => {
    const models = [m('glm-5')];
    const sections = buildPickerSections(models, {
      providerId: undefined,
      favorites: [
        { id: 'glm-5', providerId: 'p1' },
        { id: 'glm-5', providerId: 'p2' },
      ],
    });
    assertNoDuplicateIds(sections, 'favorites trùng id');
  });

  it('recents chứa cùng id 2 lần: Gần đây một hàng', () => {
    const models = [m('glm-5'), m('kimi-k3')];
    const sections = buildPickerSections(models, {
      providerId: undefined,
      recents: [
        { id: 'glm-5', providerId: 'p1', ts: 2 },
        { id: 'glm-5', providerId: 'p1', ts: 1 },
      ],
    });
    assertNoDuplicateIds(sections, 'recents trùng id');
  });
});

describe('RED TEAM buildPickerSections - id nằm ở mọi vai trò cùng lúc', () => {
  it('currentId vừa là favorite vừa là recent: rời Gần đây, ở Yêu thích đúng 1 lần', () => {
    const models = [m('glm-5'), m('kimi-k3')];
    const sections = buildPickerSections(models, {
      providerId: 'p1',
      currentId: 'glm-5',
      favorites: [{ id: 'glm-5', providerId: 'p1' }],
      recents: [{ id: 'glm-5', providerId: 'p1', ts: 9 }],
    });
    expect(sections.find((s) => s.key === 'recent')).toBeUndefined();
    const fav = sections.find((s) => s.key === 'favorite');
    expect(fav?.items.map((i) => i.id)).toEqual(['glm-5']);
  });
});

describe('RED TEAM buildPickerSections - trạng thái trống và lệch nguồn', () => {
  it('models rỗng + favorites/recents không rỗng: không section, không hàng ma', () => {
    const sections = buildPickerSections([], {
      providerId: 'p1',
      favorites: [{ id: 'ghost', providerId: 'p1' }],
      recents: [{ id: 'ghost', providerId: 'p1', ts: 1 }],
      isBuiltinCatalog: true,
    });
    expect(sections).toEqual([]);
  });

  it('isBuiltinCatalog=true nhưng models là của provider: tin cờ caller, không crash', () => {
    const models = [m('gpt-5-6-sol'), m('claude-3-5-sonnet')];
    const sections = buildPickerSections(models, {
      providerId: 'custom-gateway',
      isBuiltinCatalog: true,
    });
    expect(sections.some((s) => s.key === 'suggested')).toBe(true);
  });

  it('favorites trỏ mọi model (section khổng lồ): đủ số lượng, đúng một lần mỗi id', () => {
    const models = Array.from({ length: 200 }, (_, i) => m(`lab/m-${i}`));
    const favorites = models.map((mm) => ({ id: mm.id, providerId: 'p1' }));
    const sections = buildPickerSections(models, { providerId: 'p1', favorites });
    const fav = sections.find((s) => s.key === 'favorite');
    expect(fav?.items).toHaveLength(200);
    assertNoDuplicateIds(sections, 'favorites trỏ mọi model');
  });
});

describe('RED TEAM buildPickerSections - query đối kháng', () => {
  const models = [m('gpt-5-6-sol', { label: 'Sol Chat' }), m('glm-5', { label: 'GLM 5' })];

  it('query khớp label nhưng không khớp id vẫn tìm ra', () => {
    const sections = buildPickerSections(models, { providerId: 'p1', query: 'sol chat' });
    expect(sections[0]?.items.map((i) => i.id)).toEqual(['gpt-5-6-sol']);
  });

  it('query 10.000 ký tự: một section Kết quả (0), không throw, dưới 200ms', () => {
    const q = 'x'.repeat(10_000);
    const t0 = performance.now();
    const sections = buildPickerSections(models, { providerId: 'p1', query: q });
    const elapsed = performance.now() - t0;
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: 'search', quick: false, items: [] });
    expect(elapsed).toBeLessThan(200);
  });
});

describe('RED TEAM buildPickerSections - providerId undefined vs set', () => {
  const models = [m('glm-5')];
  const recents = [
    { id: 'glm-5', providerId: 'p1', ts: 2 },
    { id: 'glm-5', providerId: 'p2', ts: 1 },
  ];

  it('providerId undefined: không scope, entry 2 provider cùng sống nhưng vẫn một hàng/id', () => {
    const sections = buildPickerSections(models, { providerId: undefined, recents });
    assertNoDuplicateIds(sections, 'providerId undefined + recents 2 provider');
    const recentIds = sections.find((s) => s.key === 'recent')?.items.map((i) => i.id);
    expect(recentIds).toEqual(['glm-5']);
  });

  it('providerId set: chỉ entry cùng provider', () => {
    const sections = buildPickerSections(models, { providerId: 'p2', recents });
    const recentIds = sections.find((s) => s.key === 'recent')?.items.map((i) => i.id);
    expect(recentIds).toEqual(['glm-5']);
  });
});

describe('RED TEAM buildPickerSections - perf 200 model x 1000 lần', () => {
  it('dưới 500ms tổng (bắt hồi quy bậc hai favorites x models)', () => {
    const models = Array.from({ length: 200 }, (_, i) =>
      m(`lab/m-${i}`, { label: `Lab M${i}` }),
    );
    const favorites = Array.from({ length: 30 }, (_, i) => ({
      id: `lab/m-${i}`,
      providerId: 'p1',
    }));
    const recents = Array.from({ length: 6 }, (_, i) => ({
      id: `lab/m-${190 + i}`,
      providerId: 'p1',
      ts: i,
    }));
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      buildPickerSections(models, {
        favorites,
        recents,
        currentId: 'lab/m-0',
        providerId: 'p1',
      });
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(500);
  });
});
