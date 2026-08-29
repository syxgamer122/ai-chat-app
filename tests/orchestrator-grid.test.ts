/**
 * Broadcast / parameter grid — module thuần, test trong node.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_CELLS_DEFAULT,
  axisLevels,
  buildGrid,
  cartesian,
  describeCell,
  evenSample,
  formatCoords,
  levelKey,
  normalizeAxes,
  product,
  shrinkAxes,
} from '@/lib/orchestrator/grid';
import { DEFAULT_AXES } from '@/lib/orchestrator/plan';

describe('normalizeAxes', () => {
  it('bỏ rỗng, trim, khử trùng giá trị', () => {
    const axes = normalizeAxes([{ name: 'a', values: [' x ', '', 'x', 'y'] }]);
    expect(axes).toEqual([{ name: 'a', values: ['x', 'y'] }]);
  });

  it('bỏ trục không có tên hoặc không có giá trị', () => {
    const axes = normalizeAxes([
      { name: '', values: ['x'] },
      { name: 'b', values: [] },
      { name: 'c', values: ['z'] },
    ]);
    expect(axes).toEqual([{ name: 'c', values: ['z'] }]);
  });

  it('gộp hai trục cùng tên thay vì tạo trục trùng', () => {
    const axes = normalizeAxes([
      { name: 'a', values: ['x'] },
      { name: 'a', values: ['y', 'x'] },
    ]);
    expect(axes).toEqual([{ name: 'a', values: ['x', 'y'] }]);
  });

  it('rác hoàn toàn → mảng rỗng, không throw', () => {
    expect(normalizeAxes(null as unknown as unknown[])).toEqual([]);
    expect(normalizeAxes([null, 42, 'x'])).toEqual([]);
  });
});

describe('evenSample', () => {
  it('n >= length → giữ nguyên', () => {
    expect(evenSample([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it('n = 1 → chỉ giữ phần tử đầu', () => {
    expect(evenSample([1, 2, 3], 1)).toEqual([1]);
  });

  it('luôn giữ đầu và cuối, cách đều ở giữa', () => {
    expect(evenSample([1, 2, 3, 4, 5], 3)).toEqual([1, 3, 5]);
  });

  it('deterministic — cùng input cho cùng output', () => {
    expect(evenSample([1, 2, 3, 4, 5, 6, 7], 4)).toEqual(evenSample([1, 2, 3, 4, 5, 6, 7], 4));
  });
});

describe('shrinkAxes', () => {
  it('thu nhỏ trục dài nhất cho tới khi tích ≤ trần', () => {
    const axes = [
      { name: 'a', values: ['1', '2', '3', '4', '5', '6', '7', '8'] },
      { name: 'b', values: ['x', 'y'] },
    ];
    expect(product(axes)).toBe(16);
    const shrunk = shrinkAxes(axes, 4);
    expect(product(shrunk)).toBeLessThanOrEqual(4);
  });

  it('không thu nhỏ khi đã vừa trần', () => {
    const axes = [
      { name: 'a', values: ['1', '2'] },
      { name: 'b', values: ['x', 'y'] },
    ];
    expect(shrinkAxes(axes, 4)).toEqual(axes);
  });

  it('không lặp vô hạn khi mọi trục chỉ còn một giá trị', () => {
    const axes = [{ name: 'a', values: ['only'] }];
    expect(shrinkAxes(axes, 0)).toEqual(axes);
  });
});

describe('cartesian', () => {
  it('sinh đúng số cột và thứ tự kiểu C (trục ngoài quay chậm nhất)', () => {
    const cells = cartesian([
      { name: 'a', values: ['1', '2', '3'] },
      { name: 'b', values: ['x', 'y'] },
    ]);
    expect(cells).toHaveLength(6);
    expect(cells.map((c) => `${c.coords.a}${c.coords.b}`)).toEqual([
      '1x',
      '1y',
      '2x',
      '2y',
      '3x',
      '3y',
    ]);
  });

  it('index khớp vị trí trong mảng', () => {
    const cells = cartesian([{ name: 'a', values: ['1', '2'] }]);
    expect(cells.map((c) => c.index)).toEqual([0, 1]);
  });

  it('không có trục → không có cột', () => {
    expect(cartesian([])).toEqual([]);
  });
});

describe('buildGrid', () => {
  it('lưới mặc định sinh đúng số ô theo trần mặc định', () => {
    const grid = buildGrid(DEFAULT_AXES);
    expect(grid.cells).toHaveLength(MAX_CELLS_DEFAULT);
  });

  it('trần 4 thu nhỏ lưới mặc định từ 6 xuống 4, deterministic', () => {
    const grid = buildGrid(DEFAULT_AXES, 4);
    expect(grid.cells).toHaveLength(4);
    // Trục 3 mức bị chia đôi → còn 2 mức (giữ đầu + cuối).
    expect(grid.axes[0].values).toHaveLength(2);
    expect(grid.axes[1].values).toHaveLength(2);
  });

  it('trục rác → lưới rỗng chứ không throw', () => {
    expect(buildGrid([{ name: '', values: [] }], 6).cells).toEqual([]);
  });

  it('không vượt trần cứng dù caller đòi số điên', () => {
    const grid = buildGrid(
      [
        { name: 'a', values: ['1', '2', '3', '4', '5', '6'] },
        { name: 'b', values: ['1', '2', '3', '4', '5', '6'] },
      ],
      999,
    );
    expect(grid.cells.length).toBeLessThanOrEqual(24);
  });
});

describe('truy vấn lưới', () => {
  const grid = buildGrid(
    [
      { name: 'góc', values: ['trực tiếp', 'phản biện'] },
      { name: 'độ sâu', values: ['ngắn', 'dài'] },
    ],
    9,
  );

  it('axisLevels trả đúng thứ tự mức', () => {
    expect(axisLevels(grid, 'góc')).toEqual(['trực tiếp', 'phản biện']);
    expect(axisLevels(grid, 'không tồn tại')).toEqual([]);
  });

  it('levelKey nối theo đúng thứ tự trục truyền vào', () => {
    const cell = grid.cells[0];
    expect(levelKey(cell.coords, ['góc', 'độ sâu'])).toBe('trực tiếp|ngắn');
    expect(levelKey(cell.coords, ['độ sâu', 'góc'])).toBe('ngắn|trực tiếp');
  });

  it('key của cell khớp levelKey theo thứ tự trục của lưới', () => {
    const axisNames = grid.axes.map((a) => a.name);
    for (const cell of grid.cells) {
      expect(cell.key).toBe(levelKey(cell.coords, axisNames));
    }
  });

  it('describeCell / formatCoords phục vụ prompt', () => {
    const cell = grid.cells[0];
    expect(describeCell(cell)).toContain('góc = trực tiếp');
    expect(formatCoords(cell)).toContain('- góc: trực tiếp');
  });
});
