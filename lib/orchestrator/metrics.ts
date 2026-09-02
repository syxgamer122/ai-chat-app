/**
 * Records & analytics — port LÕI của vectorbt `pf.trades` / `groupby` /
 * `.vbt.heatmap` sang TypeScript thuần.
 *
 * Ở vectorbt, sau một lượt mô phỏng vector hóa, kết quả không phải là "một con
 * số" mà là **bản ghi (records)**: mỗi giao dịch/ drawdown là một dòng, rồi
 * người dùng RÚT GỌN theo ý muốn:
 *   - `pf.total_return()`                          → giảm theo thời gian
 *   - `pf.trades.expectancy()`                     → metric trên từng bản ghi
 *   - `groupby(['fast_window','symbol']).mean()`   → gom theo level của
 *                                                    MultiIndex cột
 *   - `series.vbt.heatmap(x_level, y_level)`       → pivot 2 trục thành lưới màu
 *
 * Chuyển ngữ sang Vyen: mỗi lần chạy một cell của lưới tham số sinh ra MỘT
 * `RunRecord`. Từ đó:
 *   - `scoreRecords`  ≈ `pf.trades.expectancy()` — điểm kỳ vọng của một record.
 *   - `groupByAxis`   ≈ `groupby(level).mean()`  — "trục nào đang tốt?".
 *   - `buildHeatmap`  ≈ `.vbt.heatmap(x_level, y_level)` — nhìn 2 trục cùng lúc.
 *
 * Không mang theo pandas/NumPy: `records` là mảng phẳng, group-by là Map,
 * heatmap là mảng 2 chiều thưa (null = chưa có dữ liệu). Zero dependency.
 */

import type { Cell } from './grid';

/* ------------------------------------------------------------------ */
/* Bản ghi                                                             */
/* ------------------------------------------------------------------ */

export type RunStatus = 'ok' | 'error' | 'aborted';

export interface RunRecord {
  /** Chỉ số cột trong lưới — khoá nối ngược về `Cell`. */
  cellIndex: number;
  /** Khoá gom nhóm (nối giá trị theo thứ tự trục). */
  key: string;
  coords: Record<string, string>;
  status: RunStatus;
  /** Kết quả text. Rỗng khi status !== 'ok'. */
  output: string;
  latencyMs: number;
  chars: number;
  /** Điểm chất lượng 0..1 do judge chấm. null = chưa chấm được. */
  quality: number | null;
  error?: string;
  /**
   * Số lần worker THỰC SỰ chạy cho cell này (1 = xong ngay lần đầu).
   * >1 nghĩa là đã đi qua vòng lặp tự sửa (repair.ts). Tùy chọn để mọi code
   * tạo record bằng tay vẫn hợp lệ như cũ.
   */
  attempts?: number;
}

/** Điểm rơi khi judge hỏng — không phải 0 (phạt oan) cũng không phải 1. */
export const NEUTRAL_QUALITY = 0.5;

/* ------------------------------------------------------------------ */
/* Chấm điểm                                                           */
/* ------------------------------------------------------------------ */

export interface ScoreWeights {
  /** Trọng số chất lượng (judge). */
  quality: number;
  /** Trọng số tốc độ (tương đối trong chính lưới này). */
  speed: number;
}

/**
 * vectorbt không có "tốc độ" vì mọi cột chạy cùng lúc. Ở đây mỗi cell là MỘT
 * request mạng, nên tốc độ có nghĩa — nhưng chỉ cho 20%: một câu trả lời đúng
 * mà chậm vẫn hơn một câu trả lời nhanh mà sai.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = Object.freeze({ quality: 0.8, speed: 0.2 });

export function normalizeWeights(w?: Partial<ScoreWeights>): ScoreWeights {
  const q = typeof w?.quality === 'number' && Number.isFinite(w.quality) ? Math.max(0, w.quality) : DEFAULT_WEIGHTS.quality;
  const s = typeof w?.speed === 'number' && Number.isFinite(w.speed) ? Math.max(0, w.speed) : DEFAULT_WEIGHTS.speed;
  const sum = q + s;
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  return { quality: q / sum, speed: s / sum };
}

export interface ScoredRecord extends RunRecord {
  /** Điểm tổng hợp 0..1. Record lỗi = 0. */
  score: number;
  /** Thành phần tốc độ 0..1 (1 = nhanh nhất lưới). */
  speed: number;
}

/**
 * Chấm điểm TOÀN BỘ lưới một lần — tương đương phép "giảm theo cột" của
 * vectorbt. Tốc độ được chuẩn hoá theo chính lưới này (tương đối, không tuyệt
 * đối) nên lưới chậm đồng đều không bị phạt.
 */
export function scoreRecords(
  records: readonly RunRecord[],
  weights?: Partial<ScoreWeights>,
): ScoredRecord[] {
  const w = normalizeWeights(weights);
  const ok = records.filter((r) => r.status === 'ok');
  const maxLatency = ok.reduce((m, r) => Math.max(m, r.latencyMs), 0);

  return records.map((r) => {
    const speed =
      r.status !== 'ok' || maxLatency <= 0 ? 0 : Math.max(0, Math.min(1, 1 - r.latencyMs / maxLatency));
    if (r.status !== 'ok') return { ...r, score: 0, speed: 0 };
    const q = typeof r.quality === 'number' && Number.isFinite(r.quality)
      ? Math.max(0, Math.min(1, r.quality))
      : NEUTRAL_QUALITY;
    return { ...r, score: w.quality * q + w.speed * speed, speed };
  });
}

/** Sắp xếp: điểm cao nhất trước. Hoà → nhanh hơn trước → index nhỏ hơn trước. */
export function rankRecords(
  records: readonly RunRecord[],
  weights?: Partial<ScoreWeights>,
): ScoredRecord[] {
  return scoreRecords(records, weights).sort(
    (a, b) => b.score - a.score || a.latencyMs - b.latencyMs || a.cellIndex - b.cellIndex,
  );
}

/* ------------------------------------------------------------------ */
/* Group-by theo trục (≈ groupby(level).mean())                        */
/* ------------------------------------------------------------------ */

export interface AxisGroup {
  level: string;
  /** Tổng số record có mức này. */
  count: number;
  /** Số record chạy thành công. */
  okCount: number;
  /** Điểm trung bình — chỉ tính trên record lỗi bị loại? KHÔNG: tính cả, để
   *  một mức hay lỗi mạng bị kéo xuống (đúng thực tế chi phí). */
  mean: number;
  best: number;
  bestCell: number | null;
}

/**
 * Gom điểm theo MỘT trục. Trả về đúng thứ tự mức trong trục (không phải thứ tự
 * điểm) để UI vẽ được heatmap/so sánh ổn định giữa các lần chạy.
 */
export function groupByAxis(
  records: readonly RunRecord[],
  axisName: string,
  order?: readonly string[],
  weights?: Partial<ScoreWeights>,
): AxisGroup[] {
  const scored = scoreRecords(records, weights);
  const buckets = new Map<string, ScoredRecord[]>();
  for (const r of scored) {
    const level = r.coords[axisName] ?? '';
    const list = buckets.get(level);
    if (list) list.push(r);
    else buckets.set(level, [r]);
  }

  const levels = order?.length ? order.slice() : [...buckets.keys()];
  const seen = new Set<string>();
  const out: AxisGroup[] = [];

  for (const level of levels) {
    if (seen.has(level)) continue;
    seen.add(level);
    const list = buckets.get(level);
    if (!list || !list.length) continue;
    let sum = 0;
    let best = -1;
    let bestCell: number | null = null;
    for (const r of list) {
      sum += r.score;
      if (r.score > best) {
        best = r.score;
        bestCell = r.cellIndex;
      }
    }
    out.push({
      level,
      count: list.length,
      okCount: list.filter((r) => r.status === 'ok').length,
      mean: sum / list.length,
      best: best < 0 ? 0 : best,
      bestCell,
    });
  }

  // Mức có trong record nhưng không có trong `order` vẫn phải xuất hiện.
  for (const [level, list] of buckets) {
    if (seen.has(level)) continue;
    seen.add(level);
    let sum = 0;
    let best = -1;
    let bestCell: number | null = null;
    for (const r of list) {
      sum += r.score;
      if (r.score > best) {
        best = r.score;
        bestCell = r.cellIndex;
      }
    }
    out.push({
      level,
      count: list.length,
      okCount: list.filter((r) => r.status === 'ok').length,
      mean: sum / list.length,
      best: best < 0 ? 0 : best,
      bestCell,
    });
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Heatmap (≈ series.vbt.heatmap(x_level, y_level))                    */
/* ------------------------------------------------------------------ */

export interface Heatmap {
  xAxis: string;
  yAxis: string;
  xLevels: string[];
  yLevels: string[];
  /** values[y][x] — điểm trung bình, null = chưa có record nào. */
  values: Array<Array<number | null>>;
  /** counts[y][x] — số record gộp vào ô (để tooltip nói "1 mẫu" hay "3 mẫu"). */
  counts: number[][];
}

export function buildHeatmap(
  records: readonly RunRecord[],
  opts: {
    xAxis: string;
    yAxis: string;
    xLevels?: readonly string[];
    yLevels?: readonly string[];
    weights?: Partial<ScoreWeights>;
  },
): Heatmap {
  const { xAxis, yAxis } = opts;
  const scored = scoreRecords(records, opts.weights);

  const xs = opts.xLevels?.length
    ? opts.xLevels.slice()
    : uniqueInOrder(scored.map((r) => r.coords[xAxis] ?? ''));
  const ys = opts.yLevels?.length
    ? opts.yLevels.slice()
    : uniqueInOrder(scored.map((r) => r.coords[yAxis] ?? ''));

  const sums: number[][] = ys.map(() => xs.map(() => 0));
  const counts: number[][] = ys.map(() => xs.map(() => 0));

  for (const r of scored) {
    const xi = xs.indexOf(r.coords[xAxis] ?? '');
    const yi = ys.indexOf(r.coords[yAxis] ?? '');
    if (xi < 0 || yi < 0) continue;
    sums[yi][xi] += r.score;
    counts[yi][xi] += 1;
  }

  const values = sums.map((row, y) => row.map((s, x) => (counts[y][x] > 0 ? s / counts[y][x] : null)));
  return { xAxis, yAxis, xLevels: xs, yLevels: ys, values, counts };
}

/** Chọn 2 trục để vẽ heatmap: ưu tiên 2 trục đầu của lưới. */
export function pickHeatmapAxes(axisNames: readonly string[]): { x: string; y: string } | null {
  if (axisNames.length < 2) return null;
  return { x: axisNames[1], y: axisNames[0] };
}

/* ------------------------------------------------------------------ */
/* Tiện ích                                                            */
/* ------------------------------------------------------------------ */

/** Min-max về 0..1. Toàn bằng nhau → 0.5 (tránh chia cho 0). */
export function normalize01(values: readonly number[]): number[] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return values.map(() => 0);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (max - min < 1e-9) return values.map(() => (Number.isFinite(values[0]) ? 0.5 : 0));
  return values.map((v) => (Number.isFinite(v) ? (v - min) / (max - min) : 0));
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export interface SweepStats {
  total: number;
  ok: number;
  failed: number;
  aborted: number;
  /** ok / total, 0..1. */
  passRate: number;
  meanLatencyMs: number;
  bestScore: number;
  totalChars: number;
}

export function sweepStats(
  records: readonly RunRecord[],
  weights?: Partial<ScoreWeights>,
): SweepStats {
  const scored = scoreRecords(records, weights);
  const ok = scored.filter((r) => r.status === 'ok');
  const totalLatency = ok.reduce((s, r) => s + r.latencyMs, 0);
  return {
    total: scored.length,
    ok: ok.length,
    failed: scored.filter((r) => r.status === 'error').length,
    aborted: scored.filter((r) => r.status === 'aborted').length,
    passRate: scored.length ? ok.length / scored.length : 0,
    meanLatencyMs: ok.length ? totalLatency / ok.length : 0,
    bestScore: scored.reduce((m, r) => Math.max(m, r.score), 0),
    totalChars: scored.reduce((s, r) => s + r.chars, 0),
  };
}

/** Dựng record lỗi/abort — dùng chung để mọi nơi có cùng shape. */
export function errorRecord(
  cell: Pick<Cell, 'index' | 'key' | 'coords'>,
  status: Exclude<RunStatus, 'ok'>,
  latencyMs: number,
  error?: string,
  attempts?: number,
): RunRecord {
  return {
    cellIndex: cell.index,
    key: cell.key,
    coords: cell.coords,
    status,
    output: '',
    latencyMs: Math.max(0, Math.round(latencyMs)),
    chars: 0,
    quality: null,
    ...(error ? { error } : {}),
    ...(attempts && attempts > 0 ? { attempts } : {}),
  };
}
