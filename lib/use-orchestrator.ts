'use client';

/**
 * Client của /api/orchestrate — đọc SSE và giữ TOÀN BỘ trạng thái lưới.
 *
 * Lý do tách thành hook: panel chỉ là phần vẽ. Mọi quyết định "nhận event nào
 * thì đổi state ra sao" nằm ở đây, nên panel có thể bị thay thế/tháo ra mà
 * không đụng vào logic, và một panel khác (vd: inline trong chat) có thể dùng
 * chung nguồn trạng thái.
 *
 * Huỷ được bằng AbortController: mọi request LLM đang chạy trên server nhận
 * `req.signal.aborted` và dừng, nên bấm "Dừng" thật sự ngưng tiêu token thay
 * vì chỉ ẩn UI.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { pumpSseLines } from '@/lib/sse';
import type {
  OrchestratorEvent,
  OrchestratorPhase,
  OrchestratorResult,
  AxisBreakdown,
} from '@/lib/orchestrator/engine';
import type { Heatmap, RunRecord, ScoredRecord, SweepStats } from '@/lib/orchestrator/metrics';
import type { OrchestratorPlan } from '@/lib/orchestrator/plan';

export interface OrchestratorContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OrchestratorState {
  phase: OrchestratorPhase | 'idle';
  plan: OrchestratorPlan | null;
  axes: string[];
  total: number;
  done: number;
  /** Record tạm theo cellIndex, nhận dần khi từng cell xong. */
  records: RunRecord[];
  /**
   * cellIndex → lần thử HIỆN TẠI, chỉ tồn tại trong lúc đang thử lại.
   * Số lần thử CUỐI CÙNG nằm trong `RunRecord.attempts` của mỗi record;
   * map này chỉ để vẽ huy hiệu "đang thử lại lần N" khi cell chưa xong.
   */
  retrying: Record<number, number>;
  /** Kết quả đã chấm/xếp hạng — có sau event `rank`. */
  ranked: ScoredRecord[];
  groups: AxisBreakdown[];
  heatmap: Heatmap | null;
  answer: string;
  stats: SweepStats | null;
  errors: string[];
}

const INITIAL: OrchestratorState = {
  phase: 'idle',
  plan: null,
  axes: [],
  total: 0,
  done: 0,
  records: [],
  retrying: {},
  ranked: [],
  groups: [],
  heatmap: null,
  answer: '',
  stats: null,
  errors: [],
};

export interface StartOptions {
  goal: string;
  context?: OrchestratorContextMessage[];
  maxRuns?: number;
  concurrency?: number;
  judge?: boolean;
  model?: string;
  /** Header BYOK (x-api-key / x-api-base) — cùng quy ước với /api/chat. */
  headers?: Record<string, string>;
}

export interface UseOrchestrator {
  state: OrchestratorState;
  busy: boolean;
  start: (opts: StartOptions) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

export function useOrchestrator(): UseOrchestrator {
  const [state, setState] = useState<OrchestratorState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(INITIAL);
  }, []);

  const start = useCallback(async (opts: StartOptions) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...INITIAL, phase: 'planning' });

    const pushError = (message: string) =>
      setState((s) => (s.errors.includes(message) ? s : { ...s, errors: [...s.errors, message] }));

    try {
      const res = await fetch('/api/orchestrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
        body: JSON.stringify({
          goal: opts.goal,
          context: opts.context ?? [],
          maxRuns: opts.maxRuns ?? 4,
          concurrency: opts.concurrency ?? 2,
          judge: opts.judge ?? true,
          ...(opts.model ? { model: opts.model } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        pushError(res.ok ? 'Máy chủ không trả được luồng dữ liệu.' : `Máy chủ bận (${res.status}). Thử lại sau.`);
        setState((s) => ({ ...s, phase: 'error' }));
        return;
      }

      await pumpSseLines(
        res.body,
        (raw) => {
          let event: OrchestratorEvent;
          try {
            event = JSON.parse(raw) as OrchestratorEvent;
          } catch {
            return; // dòng rác — bỏ qua, không giết cả luồng
          }
          if (!aliveRef.current) return;

          switch (event.type) {
            case 'phase':
              setState((s) => ({ ...s, phase: event.phase }));
              break;
            case 'plan':
              setState((s) => ({ ...s, plan: event.plan, axes: event.axes, total: event.total }));
              break;
            case 'run_start':
              setState((s) => ({ ...s, total: event.total }));
              break;
            case 'retry':
              // Cell gặp lỗi tạm thời (429/5xx/timeout) và sắp được thử lại.
              // Chỉ cập nhật huy hiệu — record thật vẫn chưa có.
              setState((s) => ({ ...s, retrying: { ...s.retrying, [event.cellIndex]: event.attempt } }));
              break;
            case 'run_done':
              setState((s) => {
                const next = s.records.slice();
                next[event.record.cellIndex] = event.record;
                // Cell đã xong → xoá huy hiệu "đang thử lại" của nó.
                const retrying = { ...s.retrying };
                delete retrying[event.record.cellIndex];
                return { ...s, records: next, retrying, done: event.done, total: event.total };
              });
              break;
            case 'rank':
              setState((s) => ({ ...s, ranked: event.ranked, groups: event.groups, heatmap: event.heatmap }));
              break;
            case 'answer':
              setState((s) => ({ ...s, answer: event.text }));
              break;
            case 'done':
              setState((s) => applyResult(s, event.result));
              break;
            case 'error':
              pushError(event.message);
              break;
          }
        },
        () => {
          /* byte về = server còn sống; không cần làm gì, chỉ để không bị coi
             là treo nếu ta thêm idle-timeout sau này. */
        },
      );

      if (!aliveRef.current) return;
      setState((s) => (s.phase === 'done' || s.phase === 'aborted' || s.phase === 'error' ? s : { ...s, phase: 'done' }));
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setState((s) => ({ ...s, phase: 'aborted' }));
        return;
      }
      pushError(err instanceof Error ? err.message.slice(0, 300) : 'Lỗi không xác định');
      setState((s) => ({ ...s, phase: 'error' }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  const busy = state.phase !== 'idle' && state.phase !== 'done' && state.phase !== 'aborted' && state.phase !== 'error';

  return { state, busy, start, cancel, reset };
}

/** `done` là nguồn sự thật cuối cùng — ghi đè mọi thứ tích luỹ dở dang. */
function applyResult(s: OrchestratorState, result: OrchestratorResult): OrchestratorState {
  return {
    ...s,
    phase: result.aborted ? 'aborted' : 'done',
    plan: result.plan ?? s.plan,
    axes: result.grid.axes.map((a) => a.name),
    total: result.records.length || s.total,
    done: result.records.length,
    ranked: result.records.length ? result.records : s.ranked,
    records: result.records.length ? result.records : s.records,
    groups: result.groups,
    heatmap: result.heatmap,
    answer: result.answer || s.answer,
    stats: result.stats,
  };
}
