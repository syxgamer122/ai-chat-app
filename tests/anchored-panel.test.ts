/**
 * Logic panel neo (use-anchored-panel) dùng chung cho ba menu portal của
 * status line: ModelSelector, ThinkingMenu, ChatExportMenu.
 *
 * Repo chạy vitest ở environment 'node' (không jsdom/happy-dom, không
 * @testing-library) nên phần hook (getBoundingClientRect, listener resize/
 * scroll/pointerdown) không test render được; toàn bộ toán đặt panel nằm
 * trong hàm thuần `computeAnchoredPanelPos` và được test ma trận tại đây.
 * Phần remap cursor theo id của ModelSelector không thể tách ra hàm thuần
 * (ràng buộc vòng đời effect trong component), khối dưới mô phỏng đúng dữ
 * liệu nó đọc: ordered/renderIndex TRƯỚC và SAU khi yêu thích thay đổi layout.
 */
import { describe, expect, it } from 'vitest';
import { computeAnchoredPanelPos } from '@/lib/hooks/use-anchored-panel';
import {
  buildPickerSections,
  buildRenderLayout,
  type ModelOption,
} from '@/lib/model-meta';

describe('computeAnchoredPanelPos - canh trái (ModelSelector, width 620)', () => {
  it('mép trái panel theo mép trái trigger, mở xuống 8px', () => {
    const pos = computeAnchoredPanelPos(
      { left: 100, right: 240, bottom: 40 },
      { width: 1280, height: 800 },
      { width: 620, align: 'left', withMaxHeight: true },
    );
    expect(pos).toEqual({ top: 48, left: 100, width: 620, maxHeight: 744 });
  });

  it('trigger lọt trái viewport: left kẹp về 8', () => {
    const pos = computeAnchoredPanelPos(
      { left: -40, right: 100, bottom: 40 },
      { width: 1280, height: 800 },
      { width: 620, align: 'left' },
    );
    expect(pos.left).toBe(8);
  });

  it('panel tràn phải viewport: left kẹp về vw - width - 8', () => {
    // vw 700 < 620 + 8 + 8 + mép trái trigger: phải nhả về 72.
    const pos = computeAnchoredPanelPos(
      { left: 650, right: 790, bottom: 40 },
      { width: 700, height: 800 },
      { width: 620, align: 'left' },
    );
    expect(pos.left).toBe(72);
  });

  it('viewport hẹp hơn width: width co về vw - 16 rồi mới kẹp left', () => {
    const pos = computeAnchoredPanelPos(
      { left: 90, right: 200, bottom: 40 },
      { width: 180, height: 800 },
      { width: 620, align: 'left' },
    );
    expect(pos.width).toBe(164);
    expect(pos.left).toBe(8);
  });
});

describe('computeAnchoredPanelPos - canh phải (ThinkingMenu/ChatExportMenu, width 240)', () => {
  it('mép phải panel theo mép phải trigger', () => {
    const pos = computeAnchoredPanelPos(
      { left: 1000, right: 1100, bottom: 60 },
      { width: 1280, height: 800 },
      { width: 240, align: 'right' },
    );
    expect(pos).toEqual({ top: 68, left: 860, width: 240 });
  });

  it('trigger sát trái: anchor âm bị kẹp về 8', () => {
    const pos = computeAnchoredPanelPos(
      { left: 100, right: 200, bottom: 60 },
      { width: 1280, height: 800 },
      { width: 240, align: 'right' },
    );
    expect(pos.left).toBe(8);
  });

  it('viewport hẹp: width co về vw - 16, hai biên kẹp gặp nhau tại 8', () => {
    const pos = computeAnchoredPanelPos(
      { left: 0, right: 240, bottom: 60 },
      { width: 250, height: 800 },
      { width: 240, align: 'right' },
    );
    expect(pos.width).toBe(234);
    expect(pos.left).toBe(8);
  });
});

describe('computeAnchoredPanelPos - maxHeight', () => {
  it('bình thường: chiều cao còn lại của viewport trừ top và mép dưới 8', () => {
    const pos = computeAnchoredPanelPos(
      { left: 100, right: 240, bottom: 40 },
      { width: 1280, height: 800 },
      { width: 620, align: 'left', withMaxHeight: true },
    );
    expect(pos.maxHeight).toBe(800 - 48 - 8);
  });

  it('trigger sát đáy: floor 160 giữ panel cuộn được', () => {
    const pos = computeAnchoredPanelPos(
      { left: 100, right: 240, bottom: 900 },
      { width: 1280, height: 800 },
      { width: 620, align: 'left', withMaxHeight: true },
    );
    expect(pos.top).toBe(908);
    expect(pos.maxHeight).toBe(160);
  });

  it('không xin withMaxHeight thì không có maxHeight', () => {
    const pos = computeAnchoredPanelPos(
      { left: 100, right: 240, bottom: 40 },
      { width: 1280, height: 800 },
      { width: 240, align: 'right' },
    );
    expect(pos.maxHeight).toBeUndefined();
    expect('maxHeight' in pos).toBe(false);
  });
});

describe('computeAnchoredPanelPos - margin và làm tròn', () => {
  it('margin/minMargin mặc định 8: kết quả trùng bản ghi tường minh', () => {
    const rect = { left: 100, right: 240, bottom: 40 };
    const viewport = { width: 1280, height: 800 };
    expect(
      computeAnchoredPanelPos(rect, viewport, { width: 620, align: 'left', withMaxHeight: true }),
    ).toEqual(
      computeAnchoredPanelPos(rect, viewport, {
        width: 620,
        align: 'left',
        margin: 8,
        minMargin: 8,
        withMaxHeight: true,
      }),
    );
  });

  it('margin 16/minMargin 12: hở hai bên 32, kẹp trái 12, top +16', () => {
    const pos = computeAnchoredPanelPos(
      { left: -5, right: 140, bottom: 40 },
      { width: 1280, height: 800 },
      { width: 620, align: 'left', margin: 16, minMargin: 12, withMaxHeight: true },
    );
    expect(pos.width).toBe(620);
    expect(pos.left).toBe(12);
    expect(pos.top).toBe(56);
    expect(pos.maxHeight).toBe(800 - 56 - 16);
  });

  it('toạ độ lẻ làm tròn trước khi kẹp: left .6 lên, bottom .4 giữ', () => {
    const left = computeAnchoredPanelPos(
      { left: 100.6, right: 240, bottom: 40.4 },
      { width: 1280, height: 800 },
      { width: 620, align: 'left' },
    );
    expect(left.left).toBe(101);
    expect(left.top).toBe(48);

    const right = computeAnchoredPanelPos(
      { left: 1000, right: 1100.6, bottom: 60 },
      { width: 1280, height: 800 },
      { width: 240, align: 'right' },
    );
    expect(right.left).toBe(861);
  });

  it('viền phải kẹp tính trên width ĐÃ co theo viewport', () => {
    // vw 700.4: width 620, upper bound = round(700.4 - 620 - 8) = 72.
    const pos = computeAnchoredPanelPos(
      { left: 650, right: 790, bottom: 40 },
      { width: 700.4, height: 800 },
      { width: 620, align: 'left' },
    );
    expect(pos.left).toBe(72);
  });
});

describe('remap cursor theo id - dữ liệu effect ModelSelector đọc', () => {
  const models: ModelOption[] = [
    { id: 'gpt-5', label: 'GPT 5' },
    { id: 'claude-sonnet-4', label: 'Claude' },
    { id: 'glm-4.7', label: 'GLM 4.7' },
  ];

  it('yêu thích dựng section mới: cùng số cursor trỏ sang model khác, tra lại theo id mới đúng hàng model cũ', () => {
    const before = buildRenderLayout(
      buildPickerSections(models, {
        favorites: [],
        recents: [],
        currentId: 'gpt-5',
        providerId: 'p1',
      }),
      1,
    );
    // Con trỏ user đang đứng ở GLM 4.7 (hàng cuối layout 1 cột).
    const cursor = before.renderIndex.get('glm-4.7')!;
    expect(before.ordered[cursor]!.id).toBe('glm-4.7');

    // Shift+Enter yêu thích chính hàng con trỏ: section Yêu thích chèn lên
    // đầu, mọi index sau đó dịch chuyển.
    const after = buildRenderLayout(
      buildPickerSections(models, {
        favorites: [{ id: 'glm-4.7', providerId: 'p1' }],
        recents: [],
        currentId: 'gpt-5',
        providerId: 'p1',
      }),
      1,
    );
    expect(after.renderIndex).not.toBe(before.renderIndex);
    // Giữ nguyên con số cursor (hành vi cũ): hàng highlight đổi sang model khác.
    expect(after.ordered[cursor]!.id).not.toBe('glm-4.7');
    // Remap theo id: ghi id theo layout cũ, tra lại index trong layout mới.
    const id = before.ordered[cursor]!.id;
    expect(after.renderIndex.get(id)).toBe(0);
    expect(after.ordered[after.renderIndex.get(id)!]!.id).toBe('glm-4.7');
  });
});
