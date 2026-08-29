/**
 * Engine điều phối — nơi hai nguồn gặp nhau.
 *
 * Từ **agent-orchestrator** (Untrivial-ai/agent-orchestrator), lấy đúng 3 bước
 * của vòng đời orchestrator mà KODA chưa có:
 *   1. `plan`   — orchestrator tự phân rã mục tiêu.
 *   2. `spawn`  — tạo N agent, mỗi agent context RIÊNG (không thấy transcript
 *                 của nhau), chạy song song, có huỷ.
 *   3. `review` — gom kết quả, chấm, chọn, tổng hợp thành MỘT câu trả lời.
 *
 * Từ **vectorbt** (polakowo/vectorbt), lấy hình dạng của bước 2 và 3:
 *   - Một lượt chạy là MỘT PASS trên toàn bộ lưới (không lặp từng cấu hình).
 *   - Kết quả là **records** — mỗi cấu hình một bản ghi có metric, không phải
 *     một câu trả lời duy nhất bị ghi đè.
 *   - Rút gọn bằng `groupby(level)` + heatmap 2 trục, thay vì "chọn đại một".
 *
 * MỌI lời gọi LLM là HÀM ĐƯỢC TIÊM VÀO (`deps`), nên module này không biết
 * mạng tồn tại: test chạy được trong node, và route chỉ việc cung cấp
 * implementation thật.
 */

import { buildGrid, type Cell, type Grid } from './grid';
import {
  buildHeatmap,
  errorRecord,
  groupByAxis,
  pickHeatmapAxes,
  rankRecords,
  sweepStats,
  type AxisGroup,
  type Heatmap,
  type RunRecord,
  type ScoredRecord,
  type SweepStats,
} from './metrics';
import { coercePlan, type OrchestratorPlan } from './plan';
import { runPool, withTimeout, type PoolOutcome } from './scheduler';
import { normalizePolicy, runWithRepair, type RetryPolicy } from './repair';
import type { SynthesisCandidate } from './prompts';

/* ------------------------------------------------------------------ */
/* Sự kiện — stream về client                                          */
/* ------------------------------------------------------------------ */

export type OrchestratorPhase =
  | 'planning'
  | 'sweeping'
  | 'ranking'
  | 'synthesizing'
  | 'done'
  | 'error'
  | 'aborted';

export type OrchestratorEvent =
  | { type: 'phase'; phase: OrchestratorPhase }
  | { type: 'plan'; plan: OrchestratorPlan; axes: string[]; total: number }
  | { type: 'run_start'; cellIndex: number; key: string; coords: Record<string, string>; done: number; total: number }
  /** Một cell thất bại TẠM THỜI và sắp được thử lại — vòng lặp tự sửa. */
  | { type: 'retry'; cellIndex: number; attempt: number; error: string; waitMs: number }
  | { type: 'run_done'; record: RunRecord; done: number; total: number }
  | { type: 'rank'; ranked: ScoredRecord[]; groups: AxisBreakdown[]; heatmap: Heatmap | null }
  | { type: 'answer'; text: string }
  | { type: 'done'; result: OrchestratorResult }
  | { type: 'error'; message: string };

/** Điểm của từng mức trên từng trục — kết quả của `groupby(level)`. */
export interface AxisBreakdown {
  axis: string;
  groups: AxisGroup[];
}

export interface OrchestratorResult {
  plan: OrchestratorPlan;
  grid: Grid;
  records: ScoredRecord[];
  groups: AxisBreakdown[];
  heatmap: Heatmap | null;
  answer: string;
  stats: SweepStats;
  aborted: boolean;
}

/* ------------------------------------------------------------------ */
/* Cổng tiêm vào                                                       */
/* ------------------------------------------------------------------ */

export interface WorkerContext {
  goal: string;
  context?: string;
  plan: OrchestratorPlan;
  cell: Cell;
  /**
   * Lần thử hiện tại, ĐẾM TỪ 1. >1 nghĩa là cell này đã hỏng vì lỗi tạm thời
   * và đang được spawn lại — đúng nghĩa "respawn agent kèm ngữ cảnh lỗi" của
   * agent-orchestrator.
   */
  attempt: number;
  /** Lỗi của lần thử NGAY TRƯỚC ĐÓ. Chỉ xuất hiện khi `attempt > 1`. */
  previousError?: string;
}

export interface OrchestratorDeps {
  /** Trả object thô (chưa validate) hoặc null. Hỏng → dùng lưới mặc định. */
  plan?: (goal: string, context: string | undefined, signal?: AbortSignal) => Promise<unknown>;
  /** Chạy MỘT cell. Throw → record lỗi. */
  run: (ctx: WorkerContext, signal?: AbortSignal) => Promise<{ output: string }>;
  /** Chấm 0..1. Hỏng/trả null → điểm trung tính. */
  judge?: (goal: string, criteria: readonly string[], output: string, signal?: AbortSignal) => Promise<number | null>;
  /** Gộp các ứng viên thành câu trả lời cuối. Thiếu → lấy output điểm cao nhất. */
  synthesize?: (goal: string, candidates: readonly SynthesisCandidate[], signal?: AbortSignal) => Promise<string>;
  /** Trần số cấu hình chạy (sau khi thu nhỏ lưới). */
  maxRuns?: number;
  /** Số worker chạy cùng lúc. */
  concurrency?: number;
  /**
   * Trần thời gian cho MỖI LẦN THỬ của một cell (không phải cả chuỗi thử lại).
   * Một lần thử bị treo không được phép nuốt ngân sách của các lần còn lại.
   */
  runTimeoutMs?: number;
  /**
   * Chính sách thử lại khi cell gặp lỗi TẠM THỜI (429/5xx/timeout/mạng).
   * Mặc định 3 lần thử, backoff có jitter — xem repair.ts. Truyền
   * `{ maxAttempts: 1 }` để tắt.
   */
  retry?: Partial<RetryPolicy>;
  signal?: AbortSignal;
  now?: () => number;
  onEvent?: (event: OrchestratorEvent) => void;
}

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_RUN_TIMEOUT_MS = 90_000;
/** Số ứng viên đưa vào bước tổng hợp. */
export const SYNTHESIS_TOP_K = 3;

/** Kết quả của MỘT cell sau khi đã đi qua (có thể) nhiều lần thử. */
export type WorkerOutcome =
  | { ok: true; output: string; quality: number | null; latencyMs: number; attempts: number }
  | { ok: false; error: string; aborted: boolean; latencyMs: number; attempts: number };

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  return (raw.trim() || 'Lỗi không xác định').slice(0, 300);
}

function clamp01(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null;
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export async function orchestrate(goal: string, context: string | undefined, deps: OrchestratorDeps): Promise<OrchestratorResult> {
  const now = deps.now ?? (() => Date.now());
  const emit = (e: OrchestratorEvent) => deps.onEvent?.(e);
  const aborted = () => deps.signal?.aborted === true;
  const cleanGoal = goal.trim();

  /* 1. PLAN ---------------------------------------------------------- */
  emit({ type: 'phase', phase: 'planning' });
  let plan: OrchestratorPlan;
  try {
    plan = coercePlan(deps.plan ? await deps.plan(cleanGoal, context, deps.signal) : null, cleanGoal);
  } catch (err) {
    // Planner hỏng KHÔNG được làm chết cả lượt — lùi về lưới mặc định.
    plan = coercePlan(null, cleanGoal);
    emit({ type: 'error', message: `Planner lỗi, dùng lưới mặc định: ${messageOf(err)}` });
  }

  const grid = buildGrid(plan.axes, deps.maxRuns);
  emit({ type: 'plan', plan, axes: grid.axes.map((a) => a.name), total: grid.cells.length });

  if (aborted()) return finish(plan, grid, [], [], null, '', true);
  if (!grid.cells.length) {
    emit({ type: 'error', message: 'Lưới tham số rỗng — không có cấu hình nào để chạy.' });
    return finish(plan, grid, [], [], null, '', false);
  }

  /* 2. SPAWN — một pass trên toàn bộ lưới ---------------------------- */
  emit({ type: 'phase', phase: 'sweeping' });
  const total = grid.cells.length;
  const timeoutMs = deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const retryPolicy = normalizePolicy(deps.retry);
  const records: RunRecord[] = new Array(total);

  /**
   * Chuyển kết quả thô của một làn thành `RunRecord`. Dùng ở 2 nơi: ngay khi
   * một cell vừa xong (để stream tiến độ) và ở vòng lặp chốt sổ (để đảm bảo
   * mọi index đều có record dù pool kết thúc sớm vì huỷ).
   *
   * Hai dạng thất bại cần phân biệt: pool-level (worker ném ra ngoài dự kiến —
   * không có latency/attempts) và cell-level (cell thất bại sau khi đã thử hết
   * lượt — có đủ thông tin).
   */
  const toRecord = (cell: Cell, o: PoolOutcome<WorkerOutcome>): RunRecord => {
    if (!o.ok) return errorRecord(cell, o.aborted ? 'aborted' : 'error', 0, o.error);
    const v = o.value;
    if (!v.ok) return errorRecord(cell, v.aborted ? 'aborted' : 'error', v.latencyMs, v.error, v.attempts);
    return {
      cellIndex: cell.index,
      key: cell.key,
      coords: cell.coords,
      status: 'ok',
      output: v.output,
      latencyMs: v.latencyMs,
      chars: v.output.length,
      quality: v.quality,
      attempts: v.attempts,
    };
  };

  let started = 0;
  const outcomes = await runPool<Cell, WorkerOutcome>({
    items: grid.cells,
    limit: deps.concurrency ?? DEFAULT_CONCURRENCY,
    signal: deps.signal,
    /* Phát `run_done` TỪNG cell ngay khi xong thay vì đợi cả lưới. Event này
       đã được khai báo trong union và đã được client xử lý, nhưng trước đây
       engine không bao giờ phát — panel vì thế giậm chân tại chỗ cho tới bước
       xếp hạng, và các chỉ báo "đang thử lại" không có chỗ hiển thị. */
    onSettled: (outcome, index, doneCount, totalCount) => {
      const record = toRecord(grid.cells[index], outcome);
      records[index] = record;
      emit({ type: 'run_done', record, done: doneCount, total: totalCount });
    },
    worker: async (cell) => {
      const doneBefore = started++;
      emit({ type: 'run_start', cellIndex: cell.index, key: cell.key, coords: cell.coords, done: doneBefore, total });

      const t0 = now();

      /* SPAWN (có tự sửa). `runWithRepair` tự quyết định thử lại hay không dựa
         trên phân loại lỗi — engine không cần biết 429 là gì. Lỗi của lần thử
         trước được truyền vào lần thử sau: đó là "ngữ cảnh sửa lỗi" mà
         agent-orchestrator đưa cho agent khi respawn. */
      const repaired = await runWithRepair<{ output: string }>({
        policy: retryPolicy,
        signal: deps.signal,
        attempt: (attempt, previousError) =>
          withTimeout(
            deps.run(
              { goal: cleanGoal, context, plan, cell, attempt, ...(previousError ? { previousError } : {}) },
              deps.signal,
            ),
            timeoutMs,
          ),
        onRetry: (n) => {
          emit({ type: 'retry', cellIndex: cell.index, attempt: n.nextAttempt, error: n.error, waitMs: n.waitMs });
        },
      });
      const elapsed = Math.max(0, Math.round(now() - t0));

      if (!repaired.ok) {
        return {
          ok: false,
          error: repaired.error,
          aborted: repaired.kind === 'abort',
          latencyMs: elapsed,
          attempts: repaired.attempts,
        };
      }

      const output = repaired.value.output;

      let quality: number | null = null;
      if (deps.judge && output.trim()) {
        /* Chấm hỏng vì lỗi TẠM THỜI sẽ rớt về điểm trung tính, làm PHẲNG thứ
           hạng của cả lưới — nên chấm cũng đi qua vòng lặp tự sửa, nhưng với
           ngân sách NHỎ HƠN: chấm điểm là phụ trợ, không đáng 3 lượt gọi LLM. */
        const judged = await runWithRepair<number | null>({
          policy: { ...retryPolicy, maxAttempts: Math.min(2, retryPolicy.maxAttempts) },
          signal: deps.signal,
          attempt: () => deps.judge!(cleanGoal, plan.criteria, output, deps.signal),
        });
        quality = judged.ok ? clamp01(judged.value) : null; // chấm hỏng ≠ kết quả hỏng
      }

      return { ok: true, output, quality, latencyMs: elapsed, attempts: repaired.attempts };
    },
  });

  /* Chốt sổ: bảo đảm mọi index đều có record (pool có thể thoát sớm khi huỷ).
     Với các cell đã phát `run_done`, giá trị này giống hệt — chỉ là an toàn. */
  for (let i = 0; i < total; i++) {
    if (!records[i]) records[i] = toRecord(grid.cells[i], outcomes[i]);
  }

  const wasAborted = aborted();

  /* 3. REVIEW — chấm, gom, chọn ------------------------------------- */
  emit({ type: 'phase', phase: 'ranking' });
  const ranked = rankRecords(records);
  const groups: AxisBreakdown[] = grid.axes.map((a) => ({
    axis: a.name,
    groups: groupByAxis(records, a.name, a.values),
  }));
  const hmAxes = pickHeatmapAxes(grid.axes.map((a) => a.name));
  const heatmap = hmAxes
    ? buildHeatmap(records, {
        xAxis: hmAxes.x,
        yAxis: hmAxes.y,
        xLevels: axisValues(grid, hmAxes.x),
        yLevels: axisValues(grid, hmAxes.y),
      })
    : null;
  emit({ type: 'rank', ranked, groups, heatmap });

  if (wasAborted) return finish(plan, grid, ranked, groups, heatmap, '', true);

  /* 4. TỔNG HỢP ------------------------------------------------------ */
  const winners = ranked.filter((r) => r.status === 'ok' && r.output.trim()).slice(0, SYNTHESIS_TOP_K);
  let answer = '';
  if (winners.length) {
    emit({ type: 'phase', phase: 'synthesizing' });
    const candidates: SynthesisCandidate[] = winners.map((r) => ({ score: r.score, coords: r.coords, output: r.output }));
    if (deps.synthesize && winners.length > 1) {
      try {
        answer = (await deps.synthesize(cleanGoal, candidates, deps.signal)).trim();
      } catch (err) {
        emit({ type: 'error', message: `Tổng hợp lỗi, dùng kết quả tốt nhất: ${messageOf(err)}` });
      }
    }
    if (!answer) answer = winners[0].output.trim();
    emit({ type: 'answer', text: answer });
  } else {
    emit({ type: 'error', message: 'Mọi cấu hình đều thất bại — không có kết quả để tổng hợp.' });
  }

  return finish(plan, grid, ranked, groups, heatmap, answer, false);

  function finish(
    p: OrchestratorPlan,
    g: Grid,
    recs: ScoredRecord[],
    grps: AxisBreakdown[],
    hm: Heatmap | null,
    ans: string,
    ab: boolean,
  ): OrchestratorResult {
    const result: OrchestratorResult = {
      plan: p,
      grid: g,
      records: recs,
      groups: grps,
      heatmap: hm,
      answer: ans,
      stats: sweepStats(recs),
      aborted: ab,
    };
    emit({ type: 'phase', phase: ab ? 'aborted' : 'done' });
    emit({ type: 'done', result });
    return result;
  }
}

function axisValues(grid: Grid, axisName: string): string[] {
  return grid.axes.find((a) => a.name === axisName)?.values.slice() ?? [];
}
