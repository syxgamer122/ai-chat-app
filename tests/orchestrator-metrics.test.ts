/**
 * Records & analytics — port groupby/heatmap của vectorbt. Test trong node.
 */

import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_QUALITY,
  buildHeatmap,
  errorRecord,
  groupByAxis,
  normalize01,
  pickHeatmapAxes,
  rankRecords,
  scoreRecords,
  sweepStats,
  type RunRecord,
} from '@/lib/orchestrator/metrics';

function ok(cellIndex: number, coords: Record<string, string>, quality: number | null, latencyMs: number, output = 'x'.repeat(100)): RunRecord {
  return { cellIndex, key: Object.values(coords).join('|'), coords, status: 'ok', output, latencyMs, chars: output.length, quality };
}

describe('scoreRecords', () => {
  it('kết hợp chất lượng và tốc độ tương đối', () => {
    const records = [ok(0, { a: '1' }, 1, 0), ok(1, { a: '2' }, 1, 1_000)];
    const scored = scoreRecords(records);
    expect(scored[0].speed).toBe(1);
    expect(scored[1].speed).toBe(0);
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it('judge hỏng (quality null) dùng điểm trung tính, không thành 0', () => {
    const [record] = scoreRecords([ok(0, { a: '1' }, null, 500)], { quality: 1, speed: 0 });
    expect(record.score).toBe(NEUTRAL_QUALITY);
  });

  it('record lỗi nhận điểm 0 bất kể trọng số', () => {
    const failed = errorRecord({ index: 1, key: 'x', coords: { a: 'x' } }, 'error', 10, 'boom');
    const [record] = scoreRecords([failed]);
    expect(record.score).toBe(0);
    expect(record.speed).toBe(0);
  });

  it('kẹp quality ngoài [0,1] và trọng số bất thường', () => {
    const [over] = scoreRecords([ok(0, { a: '1' }, 5, 0)], { quality: 1, speed: 0 });
    expect(over.score).toBe(1);
    const [weird] = scoreRecords([ok(0, { a: '1' }, 1, 0)], { quality: 0, speed: 0 });
    expect(weird.score).toBeCloseTo(0.8); // rơi về mặc định
  });
});

describe('rankRecords', () => {
  it('xếp điểm cao nhất lên đầu', () => {
    const records = [ok(0, { a: 'thấp' }, 0.2, 100), ok(1, { a: 'cao' }, 0.9, 900)];
    expect(rankRecords(records)[0].coords.a).toBe('cao');
  });

  it('hoà điểm → nhanh hơn đứng trước', () => {
    const records = [ok(0, { a: 'chậm' }, 0.5, 900), ok(1, { a: 'nhanh' }, 0.5, 100)];
    expect(rankRecords(records)[0].coords.a).toBe('nhanh');
  });

  it('lỗi luôn xếp sau thành công', () => {
    const records = [
      ok(0, { a: 'ok' }, 0.1, 100),
      errorRecord({ index: 1, key: 'bad', coords: { a: 'bad' } }, 'error', 0),
    ];
    expect(rankRecords(records)[0].coords.a).toBe('ok');
  });
});

describe('groupByAxis', () => {
  const records = [
    ok(0, { a: 'x', b: 'p' }, 0.4, 100),
    ok(1, { a: 'x', b: 'q' }, 0.8, 100),
    ok(2, { a: 'y', b: 'p' }, 0.6, 100),
    ok(3, { a: 'y', b: 'q' }, 0.6, 100),
  ];

  it('gom đúng số nhóm và đếm record', () => {
    const groups = groupByAxis(records, 'a');
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.count === 2)).toBe(true);
  });

  it('giữ thứ tự mức theo `order` thay vì theo điểm', () => {
    const groups = groupByAxis(records, 'a', ['y', 'x']);
    expect(groups.map((g) => g.level)).toEqual(['y', 'x']);
  });

  it('mean là trung bình điểm trong nhóm', () => {
    const groups = groupByAxis(records, 'a', ['x']);
    expect(groups[0].mean).toBeGreaterThan(0.4);
    expect(groups[0].best).toBeGreaterThanOrEqual(groups[0].mean);
  });

  it('mức có trong record nhưng không có trong order vẫn xuất hiện', () => {
    const groups = groupByAxis(records, 'a', ['x']);
    expect(groups.map((g) => g.level)).toEqual(['x', 'y']);
  });

  it('trục không tồn tại → mọi record rơi vào cùng một nhóm rỗng', () => {
    const groups = groupByAxis(records, 'không có');
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(4);
  });
});

describe('buildHeatmap', () => {
  const records = [
    ok(0, { a: 'x', b: 'p' }, 0.4, 100),
    ok(1, { a: 'x', b: 'q' }, 0.8, 100),
    ok(2, { a: 'y', b: 'p' }, 0.6, 100),
    ok(3, { a: 'y', b: 'q' }, 1.0, 100),
  ];

  /* Chỉ dùng chất lượng (speed = 0) để giá trị ô bằng đúng điểm judge. */
  const w = { quality: 1, speed: 0 };

  it('pivot đúng ô: values[y][x]', () => {
    const hm = buildHeatmap(records, { xAxis: 'b', yAxis: 'a', xLevels: ['p', 'q'], yLevels: ['x', 'y'], weights: w });
    expect(hm.values[0][0]).toBeCloseTo(0.4); // a=x, b=p
    expect(hm.values[0][1]).toBeCloseTo(0.8); // a=x, b=q
    expect(hm.values[1][1]).toBeCloseTo(1.0); // a=y, b=q
    expect(hm.counts[0][0]).toBe(1);
  });

  it('ô chưa có record là null, không phải 0', () => {
    const hm = buildHeatmap([records[0]], { xAxis: 'b', yAxis: 'a', xLevels: ['p', 'q'], yLevels: ['x', 'y'], weights: w });
    expect(hm.values[0][0]).not.toBeNull();
    expect(hm.values[1][1]).toBeNull();
  });

  it('nhiều record cùng ô → lấy trung bình', () => {
    const dup = [...records, ok(4, { a: 'x', b: 'p' }, 0.8, 100)];
    const hm = buildHeatmap(dup, { xAxis: 'b', yAxis: 'a', xLevels: ['p', 'q'], yLevels: ['x', 'y'], weights: w });
    expect(hm.counts[0][0]).toBe(2);
    expect(hm.values[0][0]).toBeCloseTo(0.6); // (0.4 + 0.8) / 2
  });

  it('pickHeatmapAxes cần ít nhất 2 trục', () => {
    expect(pickHeatmapAxes(['a'])).toBeNull();
    expect(pickHeatmapAxes(['a', 'b'])).toEqual({ x: 'b', y: 'a' });
  });
});

describe('normalize01', () => {
  it('min-max về đúng 0..1', () => {
    expect(normalize01([1, 2, 3])).toEqual([0, 0.5, 1]);
  });

  it('toàn bằng nhau → 0.5 thay vì NaN', () => {
    expect(normalize01([5, 5, 5])).toEqual([0.5, 0.5, 0.5]);
  });

  it('bỏ qua giá trị không hữu hạn', () => {
    const out = normalize01([1, Number.NaN, 3]);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(1);
    expect(Number.isFinite(out[1])).toBe(true);
  });
});

describe('sweepStats', () => {
  it('đếm đúng trạng thái và tỉ lệ thành công', () => {
    const records = [
      ok(0, { a: '1' }, 0.9, 200),
      errorRecord({ index: 1, key: 'e', coords: { a: '2' } }, 'error', 0),
      errorRecord({ index: 2, key: 'z', coords: { a: '3' } }, 'aborted', 0),
    ];
    const stats = sweepStats(records);
    expect(stats).toMatchObject({ total: 3, ok: 1, failed: 1, aborted: 1 });
    expect(stats.passRate).toBeCloseTo(1 / 3);
    expect(stats.meanLatencyMs).toBe(200);
  });

  it('không có record → không chia cho 0', () => {
    const stats = sweepStats([]);
    expect(stats.passRate).toBe(0);
    expect(stats.meanLatencyMs).toBe(0);
    expect(stats.bestScore).toBe(0);
  });
});
