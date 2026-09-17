/**
 * Logic siêu dữ liệu model picker (lib/model-meta.ts) - thuần, NODE env.
 *
 * buildPickerSections là hàm mà ModelSelector tiêu thụ: mọi quy tắc section
 * (Đề xuất/Gần đây/Yêu thích/nhóm hãng/query) đều khoá lại ở đây để component
 * chỉ còn việc render.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_FAVORITES,
  MAX_RECENTS,
  buildPickerSections,
  buildRenderLayout,
  deriveModelOption,
  fmtCtx,
  sanitizeModelFavorites,
  sanitizeRecentModels,
  toggleFavorite,
  upsertRecent,
  type ModelOption,
  type PickerSection,
} from '@/lib/model-meta';
import { AVAILABLE_MODELS, DEFAULT_MODEL_ID, type ModelConfig } from '@/lib/models';
import type { ProviderModel } from '@/lib/provider-url';

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

const cfg = (over: Partial<ModelConfig> & { id: string }): ModelConfig => ({
  name: over.id,
  provider: 'openai',
  providerModel: over.id,
  providerModelFallbacks: [],
  description: 'Mô tả catalog',
  category: 'general',
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_192,
  isReasoning: false,
  supportsTemperature: true,
  supportsImages: false,
  supportsPdf: false,
  ...over,
});

/** Toàn bộ catalog built-in qua đúng đường production (deriveModelOption). */
const builtinOptions: ModelOption[] = AVAILABLE_MODELS.map((m) => deriveModelOption(m));

/* ------------------------------------------------------------------ */
/* fmtCtx                                                              */
/* ------------------------------------------------------------------ */

describe('fmtCtx - cột ngữ cảnh compact', () => {
  it('mốc triệu làm tròn về 1 chữ số thập phân', () => {
    expect(fmtCtx(1_000_000)).toBe('1M');
    expect(fmtCtx(1_050_000)).toBe('1.1M');
    expect(fmtCtx(1_048_576)).toBe('1M');
    expect(fmtCtx(2_000_000)).toBe('2M');
  });

  it('mốc nghìn làm tròn nguyên', () => {
    expect(fmtCtx(500_000)).toBe('500k');
    expect(fmtCtx(262_144)).toBe('262k');
    expect(fmtCtx(128_000)).toBe('128k');
    expect(fmtCtx(4_000)).toBe('4k');
    expect(fmtCtx(999_499)).toBe('999k');
  });

  it('k làm tròn lên 1000 thì chuyển sang dạng M, không in "1000k"', () => {
    expect(fmtCtx(999_500)).toBe('1M');
    expect(fmtCtx(999_999)).toBe('1M');
  });

  it('dưới 1000 giữ nguyên', () => {
    expect(fmtCtx(999)).toBe('999');
    expect(fmtCtx(64)).toBe('64');
  });

  it('giá trị rác trả chuỗi rỗng để caller bỏ cột', () => {
    expect(fmtCtx(0)).toBe('');
    expect(fmtCtx(-5)).toBe('');
    expect(fmtCtx(Number.NaN)).toBe('');
    expect(fmtCtx(Number.POSITIVE_INFINITY)).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* deriveModelOption                                                   */
/* ------------------------------------------------------------------ */

describe('deriveModelOption - từ catalog built-in (ModelConfig)', () => {
  it('model chat: hint = description, ctx = contextWindowTokens, caps từ flags', () => {
    const opt = deriveModelOption(
      cfg({
        id: 'x-large',
        name: 'X Large',
        description: 'Model đa năng',
        contextWindowTokens: 400_000,
        supportsImages: true,
        supportsPdf: true,
        isReasoning: true,
      }),
    );
    expect(opt).toEqual({
      id: 'x-large',
      label: 'X Large',
      hint: 'Model đa năng',
      ctx: 400_000,
      caps: ['vision', 'pdf', 'reasoning'],
    });
  });

  it('không có capability nào thì caps undefined (không badge rỗng)', () => {
    const opt = deriveModelOption(cfg({ id: 'plain' }));
    expect(opt.caps).toBeUndefined();
  });

  it('model media: hint là câu tác vụ, ctx bị bỏ (4000 token là giới hạn nội bộ route)', () => {
    const image = deriveModelOption(
      cfg({ id: 'x-image', media: 'image', contextWindowTokens: 4_000 }),
    );
    expect(image.hint).toBe('Tạo ảnh từ mô tả');
    expect(image.media).toBe('image');
    expect(image.ctx).toBeUndefined();

    const video = deriveModelOption(cfg({ id: 'x-video', media: 'video' }));
    expect(video.hint).toBe('Tạo video, 2-5 phút');
    expect(video.media).toBe('video');
    expect(video.ctx).toBeUndefined();
  });
});

describe('deriveModelOption - từ provider custom (ProviderModel)', () => {
  it('không có metadata: không hint, không ctx, không badge - không đoán', () => {
    const opt = deriveModelOption({ id: 'weird/model@v2' });
    expect(opt).toEqual({ id: 'weird/model@v2', label: 'weird/model@v2' });
  });

  it('contextLength → ctx; thiếu name thì label = id', () => {
    const opt = deriveModelOption({ id: 'm1', contextLength: 200_000 });
    expect(opt.label).toBe('m1');
    expect(opt.ctx).toBe(200_000);
    const named = deriveModelOption({ id: 'm2', name: 'Model 2', contextLength: 8_000 });
    expect(named).toEqual({ id: 'm2', label: 'Model 2', ctx: 8_000 });
  });

  it('badge suy luận chỉ khi metadata khai báo và model dùng được suy luận', () => {
    const withEfforts = deriveModelOption({
      id: 'r1',
      reasoning: { efforts: ['high'], mandatory: false },
    });
    expect(withEfforts.caps).toEqual(['reasoning']);

    const mandatoryOnly = deriveModelOption({
      id: 'r2',
      reasoning: { efforts: [], mandatory: true },
    });
    expect(mandatoryOnly.caps).toEqual(['reasoning']);

    // Toggle-only không mandatory: gateway chỉ bật/tắt, chưa chắc model dùng
    // suy luận → không badge.
    const toggleOnly = deriveModelOption({
      id: 'r3',
      reasoning: { efforts: [], mandatory: false },
    });
    expect(toggleOnly.caps).toBeUndefined();

    expect(deriveModelOption({ id: 'r4' }).caps).toBeUndefined();
  });

  it('model media của provider: media + hint qua regex dùng chung, bỏ ctx', () => {
    const opt = deriveModelOption({ id: 'qwen-image-3.0-pro', contextLength: 8_000 });
    expect(opt.media).toBe('image');
    expect(opt.hint).toBe('Tạo ảnh từ mô tả');
    expect(opt.ctx).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* upsertRecent / toggleFavorite                                       */
/* ------------------------------------------------------------------ */

describe('upsertRecent', () => {
  it('model mới đứng đầu, mới nhất trước', () => {
    const l1 = upsertRecent([], 'a', 'p1', 100);
    const l2 = upsertRecent(l1, 'b', 'p1', 200);
    expect(l2).toEqual([
      { id: 'b', providerId: 'p1', ts: 200 },
      { id: 'a', providerId: 'p1', ts: 100 },
    ]);
  });

  it('dedupe theo (id, providerId): chọn lại thì nhảy lên đầu với ts mới', () => {
    const l = upsertRecent(upsertRecent(upsertRecent([], 'a', 'p1', 100), 'b', 'p1', 200), 'a', 'p1', 300);
    expect(l).toEqual([
      { id: 'a', providerId: 'p1', ts: 300 },
      { id: 'b', providerId: 'p1', ts: 200 },
    ]);
  });

  it('cùng id khác provider là hai mục khác nhau (không đè chéo)', () => {
    const l = upsertRecent(upsertRecent([], 'a', 'p1', 100), 'a', 'p2', 200);
    expect(l).toHaveLength(2);
    expect(l[0]).toEqual({ id: 'a', providerId: 'p2', ts: 200 });
  });

  it(`cap ${MAX_RECENTS}: mục cũ nhất bị rơi`, () => {
    let l: ReturnType<typeof upsertRecent> = [];
    for (let i = 0; i < MAX_RECENTS + 2; i++) {
      l = upsertRecent(l, `m${i}`, 'p1', i);
    }
    expect(l).toHaveLength(MAX_RECENTS);
    expect(l[0]?.id).toBe(`m${MAX_RECENTS + 1}`);
    expect(l.some((r) => r.id === 'm0')).toBe(false);
  });

  it('không đổi mảng nhập vào', () => {
    const input = [{ id: 'a', providerId: 'p1', ts: 1 }];
    upsertRecent(input, 'b', 'p1', 2);
    expect(input).toHaveLength(1);
  });
});

describe('toggleFavorite', () => {
  it('bật rồi tắt theo (id, providerId)', () => {
    const on = toggleFavorite([], 'a', 'p1');
    expect(on).toEqual([{ id: 'a', providerId: 'p1' }]);
    expect(toggleFavorite(on, 'a', 'p1')).toEqual([]);
  });

  it('cùng id khác provider độc lập', () => {
    const on = toggleFavorite(toggleFavorite([], 'a', 'p1'), 'a', 'p2');
    expect(on).toHaveLength(2);
    expect(toggleFavorite(on, 'a', 'p1')).toEqual([{ id: 'a', providerId: 'p2' }]);
  });

  it(`cap ${MAX_FAVORITES}: thêm mới đứng đầu, mục cũ nhất rơi`, () => {
    let l: ReturnType<typeof toggleFavorite> = [];
    for (let i = 0; i < MAX_FAVORITES + 1; i++) {
      l = toggleFavorite(l, `f${i}`, 'p1');
    }
    expect(l).toHaveLength(MAX_FAVORITES);
    expect(l[0]?.id).toBe(`f${MAX_FAVORITES}`);
    expect(l.some((f) => f.id === 'f0')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* sanitize (merge persisted)                                          */
/* ------------------------------------------------------------------ */

describe('sanitizeModelFavorites / sanitizeRecentModels', () => {
  it('bỏ entry rác, giữ entry tốt - không throw', () => {
    expect(
      sanitizeModelFavorites([
        { id: 'ok', providerId: 'p1' },
        null,
        'x',
        42,
        { id: '', providerId: 'p1' },
        { id: 'no-provider' },
        { id: 'ok2', providerId: 'p2' },
      ]),
    ).toEqual([
      { id: 'ok', providerId: 'p1' },
      { id: 'ok2', providerId: 'p2' },
    ]);
  });

  it('recents đòi ts hữu hạn', () => {
    expect(
      sanitizeRecentModels([
        { id: 'ok', providerId: 'p1', ts: 123 },
        { id: 'nan', providerId: 'p1', ts: Number.NaN },
        { id: 'str', providerId: 'p1', ts: '123' as unknown as number },
        { id: 'missing', providerId: 'p1' },
      ]),
    ).toEqual([{ id: 'ok', providerId: 'p1', ts: 123 }]);
  });

  it('đầu vào không phải mảng → mảng rỗng', () => {
    expect(sanitizeModelFavorites(undefined)).toEqual([]);
    expect(sanitizeModelFavorites('x')).toEqual([]);
    expect(sanitizeRecentModels({})).toEqual([]);
  });

  it('dedupe và cắt cap', () => {
    const dup = [
      { id: 'a', providerId: 'p1' },
      { id: 'a', providerId: 'p1' },
    ];
    expect(sanitizeModelFavorites(dup)).toHaveLength(1);

    const manyRecents = Array.from({ length: 12 }, (_, i) => ({
      id: `r${i}`,
      providerId: 'p1',
      ts: i,
    }));
    expect(sanitizeRecentModels(manyRecents)).toHaveLength(MAX_RECENTS);
  });
});

/* ------------------------------------------------------------------ */
/* buildPickerSections                                                 */
/* ------------------------------------------------------------------ */

describe('buildPickerSections - Đề xuất', () => {
  it('catalog built-in: mặc định + model coding đầu + model fast đầu, dedupe', () => {
    const sections = buildPickerSections(builtinOptions, { isBuiltinCatalog: true, providerId: 'srv' });
    const suggested = sections.find((s) => s.key === 'suggested');
    const firstCoding = AVAILABLE_MODELS.find((m) => m.category === 'coding');
    const firstFast = AVAILABLE_MODELS.find((m) => m.category === 'fast');
    expect(suggested?.items.map((m) => m.id)).toEqual(
      [DEFAULT_MODEL_ID, firstCoding?.id, firstFast?.id].filter(Boolean),
    );
    // Mỏ neo dữ liệu: catalog đổi thì test này đỏ để chủ ý, không lặng lẽ đổi.
    expect(DEFAULT_MODEL_ID).toBe('gpt-4o');
    expect(firstFast?.id).toBe('gpt-4o-mini');
  });

  it('provider custom KHÔNG bao giờ có Đề xuất, kể cả khi id trùng catalog', () => {
    const sections = buildPickerSections(builtinOptions, { isBuiltinCatalog: false, providerId: 'p1' });
    expect(sections.some((s) => s.key === 'suggested')).toBe(false);
  });

  it('phiên đầu (chưa có gì): không Đề xuất khi catalog lọc hết model đề xuất', () => {
    const sections = buildPickerSections(
      [deriveModelOption(cfg({ id: 'mystery-model' }))],
      { isBuiltinCatalog: true, providerId: 'srv' },
    );
    expect(sections.some((s) => s.key === 'suggested')).toBe(false);
    expect(sections.some((s) => s.key === 'recent')).toBe(false);
    expect(sections.some((s) => s.key === 'favorite')).toBe(false);
  });
});

describe('buildPickerSections - Gần đây / Yêu thích', () => {
  const rec = (id: string, providerId: string, ts: number) => ({ id, providerId, ts });

  it('scoped theo provider: recents/favorites provider khác bị bỏ (không ghost)', () => {
    const sections = buildPickerSections(builtinOptions, {
      providerId: 'p1',
      recents: [rec('gpt-4o', 'p2', 1), rec('o1', 'p1', 2)],
      favorites: [{ id: 'o1-mini', providerId: 'p2' }],
    });
    expect(sections.find((s) => s.key === 'recent')?.items.map((m) => m.id)).toEqual([
      'o1',
    ]);
    expect(sections.some((s) => s.key === 'favorite')).toBe(false);
  });

  it('ghost (id không còn trong danh sách) bị bỏ âm thầm', () => {
    const sections = buildPickerSections(builtinOptions, {
      providerId: 'srv',
      recents: [rec('da-chet-tren-gateway', 'srv', 1), rec('o1', 'srv', 2)],
      favorites: [{ id: 'khong-ton-tai', providerId: 'srv' }],
    });
    expect(sections.find((s) => s.key === 'recent')?.items.map((m) => m.id)).toEqual(['o1']);
    expect(sections.some((s) => s.key === 'favorite')).toBe(false);
  });

  it('Gần đây tối đa 4 mục, loại model đang chọn, thứ tự mới nhất trước', () => {
    const sections = buildPickerSections(builtinOptions, {
      providerId: 'srv',
      currentId: 'gpt-4o',
      recents: [
        rec('gpt-4o', 'srv', 50),
        rec('o1', 'srv', 40),
        rec('o1-mini', 'srv', 30),
        rec('o3-mini', 'srv', 20),
        rec('gpt-4o-mini', 'srv', 10),
        rec('chatgpt-4o-latest', 'srv', 5),
      ],
    });
    expect(sections.find((s) => s.key === 'recent')?.items.map((m) => m.id)).toEqual([
      'o1',
      'o1-mini',
      'o3-mini',
      'gpt-4o-mini',
    ]);
  });

  it('Yêu thích giữ model đang chọn và thứ tự danh sách', () => {
    const sections = buildPickerSections(builtinOptions, {
      providerId: 'srv',
      currentId: 'gpt-4o',
      favorites: [
        { id: 'o1', providerId: 'srv' },
        { id: 'gpt-4o', providerId: 'srv' },
      ],
    });
    expect(sections.find((s) => s.key === 'favorite')?.items.map((m) => m.id)).toEqual([
      'o1',
      'gpt-4o',
    ]);
  });
});

describe('buildPickerSections - nhóm hãng / media / khác', () => {
  const mixed: ModelOption[] = [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
    { id: 'my-image-model', label: 'My Image', media: 'image', hint: 'Tạo ảnh từ mô tả' },
    { id: 'my-video-model', label: 'My Video', media: 'video', hint: 'Tạo video, 2-5 phút' },
    { id: 'totally-unknown-lab', label: 'Unknown Lab 7B' },
  ];

  it('media thắng hãng: gpt-image-2 vào Tạo ảnh, không vào OpenAI · GPT', () => {
    const sections = buildPickerSections(mixed, { providerId: 'srv' });
    const keys = sections.filter((s) => !s.quick).map((s) => s.key);
    expect(keys).toEqual(['gpt', 'claude', 'image', 'video', 'other']);
    expect(sections.find((s) => s.key === 'gpt')?.items.map((m) => m.id)).toEqual(['gpt-4o']);
    expect(sections.find((s) => s.key === 'image')?.items.map((m) => m.id)).toEqual(['my-image-model']);
    expect(sections.find((s) => s.key === 'other')?.items.map((m) => m.id)).toEqual([
      'totally-unknown-lab',
    ]);
  });

  it('nhóm rỗng bị bỏ, Khác luôn cuối', () => {
    const sections = buildPickerSections(
      [{ id: 'glm-5', label: 'GLM 5' }],
      { providerId: 'srv' },
    );
    expect(sections.map((s) => s.key)).toEqual(['glm']);
  });

  it('danh sách rỗng → không section nào', () => {
    expect(buildPickerSections([], { providerId: 'srv', isBuiltinCatalog: true })).toEqual([]);
  });
});

describe('buildPickerSections - query', () => {
  it('có query: sập thành một nhóm Kết quả (n), match cả id lẫn label', () => {
    const sections = buildPickerSections(builtinOptions, {
      providerId: 'srv',
      query: 'o1',
      favorites: [{ id: 'gpt-4o', providerId: 'srv' }],
    });
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: 'search', quick: false });
    expect(sections[0]!.label).toMatch(/^Kết quả \(\d+\)$/);
    // id 'o1' / 'o1-mini' chứa 'o1'
    expect(sections[0]!.items.every((m) => m.id.toLowerCase().includes('o1'))).toBe(true);
    expect(sections[0]!.items.length).toBeGreaterThan(0);
  });

  it('query khớp id nhưng không khớp label vẫn tìm thấy', () => {
    const sections = buildPickerSections(builtinOptions, { providerId: 'srv', query: 'o1-mini' });
    expect(sections[0]?.items.map((m) => m.id)).toEqual(['o1-mini']);
  });

  it('query trống sau trim = không search', () => {
    const sections = buildPickerSections(builtinOptions, { providerId: 'srv', query: '   ' });
    expect(sections.some((s) => s.key === 'search')).toBe(false);
  });
});

describe('buildPickerSections - provider 190 model (không virtualization)', () => {
  const bigModels: ModelOption[] = Array.from({ length: 190 }, (_, i) => ({
    id: `lab/m-${i}`,
    label: `Lab M${i}`,
    ctx: 32_000,
  }));

  it('gom hết vào Khác và tìm kiếm vẫn hoạt động', () => {
    const sections = buildPickerSections(bigModels, { providerId: 'p1' });
    expect(sections.find((s) => s.key === 'other')?.items).toHaveLength(190);

    const hit = buildPickerSections(bigModels, { providerId: 'p1', query: 'M18' });
    // M18 match M18, M180..M189 (và label chứa 'M18')
    expect(hit[0]?.items.length).toBeGreaterThanOrEqual(11);
  });
});

describe('buildPickerSections - id trùng lặp (regression)', () => {
  it('models chứa entry trùng id: mọi section chỉ một hàng cho id đó', () => {
    const sections = buildPickerSections(
      [
        { id: 'glm-5', label: 'GLM 5' },
        { id: 'glm-5', label: 'GLM 5 (bản copy)' },
      ],
      { providerId: 'p1' },
    );
    for (const s of sections) {
      const ids = s.items.map((i) => i.id);
      expect(new Set(ids).size, `section "${s.key}" lặp id`).toBe(ids.length);
    }
    expect(sections.find((s) => s.key === 'glm')?.items).toHaveLength(1);
  });

  it('id media đụng id thường: một hàng duy nhất, vào nhóm media (bản đầu thắng)', () => {
    const sections = buildPickerSections(
      [
        { id: 'x-image', label: 'X Image', media: 'image', hint: 'Tạo ảnh từ mô tả' },
        { id: 'x-image', label: 'X Image (chat)' },
      ],
      { providerId: 'p1' },
    );
    const occurrences = sections
      .flatMap((s) => s.items.map((i) => i.id))
      .filter((id) => id === 'x-image');
    expect(occurrences).toHaveLength(1);
    expect(sections.find((s) => s.key === 'image')?.items.map((m) => m.id)).toEqual(['x-image']);
    expect(sections.some((s) => s.key === 'other')).toBe(false);
  });
});

describe('buildRenderLayout - bố cục render thuần', () => {
  const sec = (key: string, ids: string[], quick = false): PickerSection => ({
    key,
    label: key,
    items: ids.map((id) => ({ id, label: id })),
    quick,
  });

  it('section quick render full-width, không lọt vào cột grid', () => {
    const layout = buildRenderLayout([sec('recent', ['a'], true), sec('gpt', ['b'])], 2);
    expect(layout.quickSections.map((s) => s.key)).toEqual(['recent']);
    expect(layout.columns.flat().map((s) => s.key)).toEqual(['gpt']);
  });

  it('model nằm nhiều section: renderIndex lấy index của lần render đầu', () => {
    const layout = buildRenderLayout([sec('recent', ['a'], true), sec('other', ['a', 'b'])], 2);
    expect(layout.renderIndex.get('a')).toBe(0);
    expect(layout.renderIndex.get('b')).toBe(2);
  });

  it('ordered[row.idx] chính là row.m ở mọi section, không sót không thừa', () => {
    const layout = buildRenderLayout(
      [sec('suggested', ['d1'], true), sec('gpt', ['a', 'b']), sec('claude', ['c', 'e']), sec('other', ['f'])],
      2,
    );
    const all = [...layout.quickSections, ...layout.columns.flat()];
    let total = 0;
    for (const s of all) {
      for (const row of s.rows) expect(layout.ordered[row.idx]).toBe(row.m);
      total += s.rows.length;
    }
    expect(layout.ordered).toHaveLength(total);
    expect([...layout.renderIndex.values()].every((i) => layout.ordered[i])).toBe(true);
  });

  it('colCount 2: tổng item hai cột đúng, mỗi cột chênh tối đa 1, section không bị xé', () => {
    const layout = buildRenderLayout(
      [sec('a', ['1', '2']), sec('b', ['3', '4']), sec('c', ['5']), sec('d', ['6'])],
      2,
    );
    expect(layout.columns).toHaveLength(2);
    const sizes = layout.columns.map((col) => col.reduce((n, s) => n + s.rows.length, 0));
    expect(sizes[0]! + sizes[1]!).toBe(6);
    expect(Math.abs(sizes[0]! - sizes[1]!)).toBeLessThanOrEqual(1);
    // Mỗi section nguyên vẹn trong đúng một cột.
    const keys = layout.columns.flat().map((s) => s.key);
    expect(new Set(keys).size).toBe(4);
  });

  it('colCount 1: một cột duy nhất giữ nguyên thứ tự section', () => {
    const layout = buildRenderLayout([sec('gpt', ['a']), sec('claude', ['b'])], 1);
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]!.map((s) => s.key)).toEqual(['gpt', 'claude']);
    expect(layout.ordered.map((m) => m.id)).toEqual(['a', 'b']);
    expect(layout.renderIndex.get('b')).toBe(1);
  });
});
