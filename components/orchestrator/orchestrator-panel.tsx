'use client';

/**
 * Panel orchestrator — nơi người dùng NHÌN THẤY lưới thay vì chỉ nhận một câu
 * trả lời.
 *
 * agent-orchestrator hiển thị "sessions board": mỗi agent một thẻ, trạng thái
 * riêng, có thể mở ra xem. vectorbt hiển thị heatmap tham số. Panel này là
 * phần giao của hai bên: **mỗi cell của lưới là một thẻ agent**, và khi lưới
 * có từ 2 trục trở lên, các thẻ được tóm tắt thành heatmap.
 *
 * Chủ đích thiết kế: KHÔNG thay thế luồng chat chính. Orchestrator là một mặt
 * phẳng PHÂN TÍCH — chạy xong, người dùng bấm "Dùng kết quả" thì text mới được
 * đưa vào composer. Nhờ vậy panel này không đụng vào cây nhánh hội thoại
 * (seq/branchOrder/parentId), tức là không có rủi ro làm hỏng dữ liệu.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, Loader2, Network, Play, RotateCw, X } from 'lucide-react';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { AxisBars, SweepHeatmap } from '@/components/orchestrator/sweep-heatmap';
import { describeCell } from '@/lib/orchestrator/grid';
import type { OrchestratorState } from '@/lib/use-orchestrator';
import type { OrchestratorPhase } from '@/lib/orchestrator/engine';
import type { RunRecord } from '@/lib/orchestrator/metrics';

const PHASE_LABEL: Record<OrchestratorPhase | 'idle', string> = {
  idle: 'Sẵn sàng',
  planning: 'Đang lập kế hoạch…',
  sweeping: 'Đang chạy lưới…',
  ranking: 'Đang chấm điểm…',
  synthesizing: 'Đang tổng hợp…',
  done: 'Hoàn tất',
  error: 'Có lỗi',
  aborted: 'Đã dừng',
};

function StatusDot({ status }: { status: RunRecord['status'] }) {
  if (status === 'ok') return <Check size={12} className="text-emerald-600" />;
  if (status === 'aborted') return <X size={12} className="text-zinc-400" />;
  return <AlertTriangle size={12} className="text-red-500" />;
}

function Bar({ value, tone }: { value: number; tone?: 'brand' | 'warn' }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-zinc-200/70">
      <div
        className="h-full rounded"
        style={{
          width: `${Math.max(2, Math.min(100, value * 100)).toFixed(1)}%`,
          background: tone === 'warn' ? 'rgb(220 38 38)' : 'rgb(var(--brand))',
        }}
      />
    </div>
  );
}

const RUN_OPTIONS = [4, 6, 9, 12] as const;

export function OrchestratorPanel({
  open,
  state,
  busy,
  initialGoal,
  onRun,
  onCancel,
  onClose,
  onAdopt,
}: {
  open: boolean;
  state: OrchestratorState;
  busy: boolean;
  /** Gợi ý sẵn từ ô nhập — người dùng vẫn sửa được trước khi chạy. */
  initialGoal: string;
  onRun: (opts: { goal: string; maxRuns: number; judge: boolean }) => void;
  onCancel: () => void;
  onClose: () => void;
  onAdopt: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [goalDraft, setGoalDraft] = useState(initialGoal);
  const [maxRuns, setMaxRuns] = useState<number>(4);
  const [judge, setJudge] = useState(true);

  /* Mở lại panel với một gợi ý mới → nhận gợi ý đó, nhưng KHÔNG giật mất chữ
     người dùng đang gõ dở trong cùng một phiên mở. */
  useEffect(() => {
    if (open) setGoalDraft(initialGoal);
  }, [open, initialGoal]);

  /* `score` chỉ có SAU bước chấm điểm (event `rank`). Trước đó record vẫn được
     hiện để người dùng thấy tiến độ, nên trường này là optional. */
  const rows = useMemo<Array<RunRecord & { score?: number }>>(() => {
    if (state.ranked.length) return state.ranked;
    return state.records.filter(Boolean);
  }, [state.ranked, state.records]);

  if (!open) return null;

  const progress = state.total > 0 ? state.done / state.total : 0;

  const copy = async () => {
    if (!state.answer) return;
    try {
      await navigator.clipboard.writeText(state.answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* clipboard bị chặn — người dùng vẫn bấm "Dùng kết quả" được */
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Orchestrator — quét tham số"
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-3 sm:p-6"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-zinc-300 bg-surface-raised shadow-panel dark:border-zinc-700"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
              <Network size={15} className="text-[rgb(var(--brand))]" />
              Orchestrator
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">
                {busy && <Loader2 size={9} className="mr-1 inline animate-spin" />}
                {PHASE_LABEL[state.phase]}
              </span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-[11px] text-zinc-600">
              {state.plan?.goal || goalDraft || 'Chưa có mục tiêu'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="flex-shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-auto p-4">
          {/* Thiết lập — chỉ hiện khi chưa chạy */}
          {state.phase === 'idle' && (
            <div className="space-y-2 rounded-lg border border-zinc-200 p-3">
              <label
                htmlFor="orch-goal"
                className="block text-[11px] font-semibold uppercase tracking-wide text-zinc-500"
              >
                Mục tiêu
              </label>
              <textarea
                id="orch-goal"
                value={goalDraft}
                onChange={(e) => setGoalDraft(e.target.value)}
                rows={3}
                placeholder="Ví dụ: giải thích vì sao Next.js App Router không còn getServerSideProps"
                className="w-full resize-y rounded-lg border border-zinc-300 bg-surface-raised px-2.5 py-2 text-[13px] text-zinc-800 outline-none placeholder:text-zinc-400 focus:border-[rgb(var(--brand))]"
              />
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-600">
                <label className="inline-flex items-center gap-1.5">
                  Số cấu hình
                  <select
                    value={maxRuns}
                    onChange={(e) => setMaxRuns(Number(e.target.value))}
                    className="rounded border border-zinc-300 bg-surface-raised px-1.5 py-0.5 text-[11px] text-zinc-800"
                  >
                    {RUN_OPTIONS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={judge}
                    onChange={(e) => setJudge(e.target.checked)}
                    className="h-3.5 w-3.5 accent-teal-700"
                  />
                  Chấm điểm từng kết quả (thêm ~{maxRuns} lượt gọi)
                </label>
              </div>
              <button
                type="button"
                disabled={!goalDraft.trim()}
                onClick={() => onRun({ goal: goalDraft.trim(), maxRuns, judge })}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[rgb(var(--brand))] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[rgb(var(--brand-hover))] disabled:opacity-40"
              >
                <Play size={13} /> Chạy lưới
              </button>
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Mỗi ô trong lưới là MỘT agent giải cùng mục tiêu theo một cấu hình KHÁC NHAU. Kết quả
                được chấm, xếp hạng rồi tổng hợp — bạn nhìn được cả lưới chứ không chỉ câu trả lời
                cuối cùng.
              </p>
            </div>
          )}

          {/* Tiến độ */}
          {state.total > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-zinc-600">
                <span>
                  {state.done}/{state.total} cấu hình
                  {state.stats ? ` · ${state.stats.ok} thành công` : ''}
                  {state.stats && state.stats.failed ? ` · ${state.stats.failed} lỗi` : ''}
                </span>
                <span className="tabular-nums">{Math.round(progress * 100)}%</span>
              </div>
              <Bar value={progress} />
            </div>
          )}

          {/* Lưới tham số */}
          {state.plan && (
            <div className="rounded-lg border border-zinc-200 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Lưới tham số
              </div>
              <div className="flex flex-wrap gap-1.5">
                {state.plan.axes.map((a) => (
                  <span
                    key={a.name}
                    className="rounded border border-zinc-200 bg-surface-muted px-1.5 py-0.5 text-[11px] text-zinc-700"
                  >
                    <span className="font-medium">{a.name}</span>
                    <span className="text-zinc-500"> ({a.values.length}): </span>
                    {a.values.join(' / ')}
                  </span>
                ))}
                {!state.plan.axes.length && <span className="text-[11px] text-zinc-500">Lưới mặc định</span>}
              </div>
              {state.plan.criteria.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[11px] text-zinc-600">
                  {state.plan.criteria.map((c) => (
                    <li key={c}>· {c}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Bảng kết quả */}
          {rows.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-zinc-200">
              <div className="border-b border-zinc-200 bg-surface-muted px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Bản ghi theo cấu hình
              </div>
              <ul className="divide-y divide-zinc-200">
                {rows.map((r, i) => (
                  <li key={`${r.cellIndex}-${r.key}`}>
                    <button
                      type="button"
                      onClick={() => setExpanded(expanded === i ? null : i)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-muted"
                    >
                      <StatusDot status={r.status} />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-800">
                        {describeCell({ index: r.cellIndex, key: r.key, coords: r.coords })}
                      </span>
                      {/* Vòng lặp tự sửa: cell đang được spawn lại (lỗi tạm
                          thời), hoặc đã cần nhiều lần thử mới xong. Nếu không
                          có huy hiệu này, một cú 429 chỉ hiện ra như một ô
                          "lỗi" vô cớ — trong khi thực tế nó đã được sửa. */}
                      {(() => {
                        const live = state.retrying[r.cellIndex] ?? 0;
                        const final = r.attempts ?? 1;
                        const n = live > 1 ? live : final > 1 ? final : 0;
                        if (!n) return null;
                        return (
                          <span
                            title={
                              live > 1
                                ? `Lỗi tạm thời (429/5xx/timeout) — đang thử lại lần ${live}`
                                : `Đã cần ${final} lần thử — lỗi tạm thời được tự động sửa`
                            }
                            className="flex flex-shrink-0 items-center gap-0.5 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium tabular-nums text-amber-700"
                          >
                            <RotateCw size={9} />
                            {n}
                          </span>
                        );
                      })()}
                      {r.status === 'ok' && (
                        <span className="w-24 flex-shrink-0">
                          <Bar value={r.score ?? 0} />
                        </span>
                      )}
                      <span className="w-20 flex-shrink-0 text-right text-[10px] tabular-nums text-zinc-500">
                        {r.status === 'ok' ? `${(r.latencyMs / 1000).toFixed(1)}s · ${r.chars} chữ` : r.status === 'aborted' ? 'đã huỷ' : 'lỗi'}
                      </span>
                    </button>
                    {expanded === i && (
                      <div className="border-t border-zinc-200 bg-surface-muted/60 px-3 py-2">
                        {r.error && <div className="mb-1 text-[11px] text-red-600">{r.error}</div>}
                        <div className="max-h-56 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-800">
                          {r.output || '(không có nội dung)'}
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Heatmap + group-by */}
          {state.heatmap && state.heatmap.xLevels.length > 0 && state.heatmap.yLevels.length > 0 && (
            <div className="rounded-lg border border-zinc-200 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Heatmap — điểm trung bình
              </div>
              <div className="overflow-x-auto">
                <SweepHeatmap heatmap={state.heatmap} />
              </div>
            </div>
          )}

          {state.groups.length > 0 && (
            <div className="rounded-lg border border-zinc-200 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Điểm theo từng mức
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {state.groups.map((g) => (
                  <AxisBars key={g.axis} axis={g.axis} groups={g.groups} />
                ))}
              </div>
            </div>
          )}

          {/* Lỗi */}
          {state.errors.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50/60 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-red-700">
                <AlertTriangle size={12} /> Ghi chú
              </div>
              <ul className="space-y-0.5 text-[11px] text-red-700">
                {state.errors.map((e, i) => (
                  <li key={`${i}-${e}`}>· {e}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Kết quả cuối */}
          {state.answer && (
            <div className="rounded-lg border border-zinc-200 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Câu trả lời tổng hợp
              </div>
              <div className="prose prose-sm max-w-none text-zinc-800">
                <MarkdownRenderer content={state.answer} />
              </div>
            </div>
          )}

          {busy && !rows.length && (
            <div className="flex items-center gap-2 py-8 text-[12px] text-zinc-500">
              <Loader2 size={14} className="animate-spin" /> Đang chuẩn bị lưới tham số…
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3">
          {busy ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100"
            >
              Dừng
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100"
              >
                Đóng
              </button>
              {state.phase !== 'idle' && (
                <button
                  type="button"
                  disabled={!goalDraft.trim()}
                  onClick={() => onRun({ goal: goalDraft.trim(), maxRuns, judge })}
                  className="rounded-lg border border-zinc-300 px-3 py-1.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
                >
                  Chạy lại
                </button>
              )}
              <button
                type="button"
                onClick={copy}
                disabled={!state.answer}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-[12px] font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? 'Đã chép' : 'Sao chép'}
              </button>
              <button
                type="button"
                onClick={() => {
                  onAdopt(state.answer);
                  onClose();
                }}
                disabled={!state.answer}
                className="rounded-lg bg-[rgb(var(--brand))] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[rgb(var(--brand-hover))] disabled:opacity-40"
              >
                Dùng kết quả
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
