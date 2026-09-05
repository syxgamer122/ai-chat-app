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
 * phẳng PHÂN TÍCH — chạy xong, người dùng bấm "Thêm vào hội thoại" để ghi đáp
 * án tổng hợp vào hội thoại như một message assistant (panel chỉ gọi callback,
 * việc chạm cây nhánh seq/branchOrder/parentId thuộc về chat-interface), hoặc
 * "Đưa vào ô nhập" để sửa tay trước khi gửi.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, Loader2, MessageSquarePlus, Network, Play, RotateCw, X } from 'lucide-react';
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
  chatBusy,
  initialGoal,
  onRun,
  onCancel,
  onClose,
  onAdopt,
  onAppendToChat,
}: {
  open: boolean;
  state: OrchestratorState;
  busy: boolean;
  /** Chat chính đang stream/tạo media — không được ghi message vào giữa. */
  chatBusy: boolean;
  /** Gợi ý sẵn từ ô nhập — người dùng vẫn sửa được trước khi chạy. */
  initialGoal: string;
  onRun: (opts: { goal: string; maxRuns: number; judge: boolean }) => void;
  onCancel: () => void;
  onClose: () => void;
  /** Đặt đáp án vào ô nhập (nút phụ) — người dùng sửa rồi tự gửi. */
  onAdopt: (text: string) => void;
  /** Ghi đáp án vào hội thoại hiện tại như message assistant (nút chính).
   *  Resolve false khi bị guard chặn (busy/đã khoá) — panel KHÔNG đóng. */
  onAppendToChat: (text: string) => Promise<boolean>;
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
      /* clipboard bị chặn — người dùng vẫn bấm "Thêm vào hội thoại" được */
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
        className="pi-frame relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-none border border-[#495059] bg-[#212730] font-mono text-[#ebe7e4]"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="pi-corner-tl" />
        <span className="pi-corner-tr" />
        <span className="pi-corner-bl" />
        <span className="pi-corner-br" />

        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[#495059] bg-[#161d27] px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-pixel text-[16px] font-semibold text-[#ebe7e4] [image-rendering:pixelated]">
              <Network size={15} className="text-[#6a9fcc]" />
              <span>Orchestrator</span>
              <span className="rounded-none border border-[#495059] bg-[#161b22] px-1.5 py-0.5 font-mono text-[10px] text-[#6a9fcc]">
                {busy && <Loader2 size={9} className="mr-1 inline animate-spin" />}
                {PHASE_LABEL[state.phase]}
              </span>
            </div>
            <div className="mt-0.5 line-clamp-2 font-mono text-[11px] text-[#9fa4ab]">
              {state.plan?.goal || goalDraft || 'Chưa có mục tiêu'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="icon-btn-sm text-[#9fa4ab] hover:text-[#ebe7e4]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-auto p-4">
          {/* Thiết lập — chỉ hiện khi chưa chạy */}
          {state.phase === 'idle' && (
            <div className="space-y-2 rounded-none border border-[#495059] bg-[#161b22] p-3">
              <label
                htmlFor="orch-goal"
                className="block text-[11px] font-semibold uppercase tracking-wide text-[#6a9fcc]"
              >
                Mục tiêu
              </label>
              <textarea
                id="orch-goal"
                value={goalDraft}
                onChange={(e) => setGoalDraft(e.target.value)}
                rows={3}
                placeholder="Ví dụ: giải thích vì sao Next.js App Router không còn getServerSideProps"
                className="w-full resize-y rounded-none border border-[#495059] bg-[#0d1116] px-2.5 py-2 font-mono text-[13px] text-[#ebe7e4] outline-none placeholder:text-[#9fa4ab]/60 focus:border-[#6a9fcc]"
              />
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-[#9fa4ab]">
                <label className="inline-flex items-center gap-1.5">
                  Số cấu hình
                  <select
                    value={maxRuns}
                    onChange={(e) => setMaxRuns(Number(e.target.value))}
                    className="rounded-none border border-[#495059] bg-[#0d1116] px-1.5 py-0.5 font-mono text-[11px] text-[#ebe7e4] outline-none"
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
                    className="h-3.5 w-3.5 accent-[#6a9fcc]"
                  />
                  Chấm điểm từng kết quả (thêm ~{maxRuns} lượt gọi)
                </label>
              </div>
              <button
                type="button"
                disabled={!goalDraft.trim()}
                onClick={() => onRun({ goal: goalDraft.trim(), maxRuns, judge })}
                className="inline-flex items-center gap-1.5 rounded-none bg-[#6a9fcc] px-3.5 py-1.5 font-mono text-[12px] font-semibold text-[#0d1116] transition-colors hover:bg-[#89b8e0] disabled:opacity-40"
              >
                <Play size={13} /> Chạy lưới
              </button>
              <p className="text-[11px] leading-relaxed text-[#9fa4ab]">
                Mỗi ô trong lưới là MỘT agent giải cùng mục tiêu theo một cấu hình KHÁC NHAU. Kết quả
                được chấm, xếp hạng rồi tổng hợp — bạn nhìn được cả lưới chứ không chỉ câu trả lời
                cuối cùng.
              </p>
            </div>
          )}

          {/* Tiến độ */}
          {state.total > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-[#9fa4ab]">
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
            <div className="rounded-none border border-[#495059] bg-[#161b22] p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#6a9fcc]">
                Lưới tham số
              </div>
              <div className="flex flex-wrap gap-1.5">
                {state.plan.axes.map((a) => (
                  <span
                    key={a.name}
                    className="rounded-none border border-[#495059] bg-[#212730] px-1.5 py-0.5 text-[11px] text-[#ebe7e4]"
                  >
                    <span className="font-medium">{a.name}</span>
                    <span className="text-[#9fa4ab]"> ({a.values.length}): </span>
                    {a.values.join(' / ')}
                  </span>
                ))}
                {!state.plan.axes.length && <span className="text-[11px] text-[#9fa4ab]">Lưới mặc định</span>}
              </div>
              {state.plan.criteria.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[11px] text-[#9fa4ab]">
                  {state.plan.criteria.map((c) => (
                    <li key={c}>· {c}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Bảng kết quả */}
          {rows.length > 0 && (
            <div className="overflow-hidden rounded-none border border-[#495059] bg-[#161b22]">
              <div className="border-b border-[#495059] bg-[#1c2128] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#6a9fcc]">
                Bản ghi theo cấu hình
              </div>
              <ul className="divide-y divide-[#495059]">
                {rows.map((r, i) => (
                  <li key={`${r.cellIndex}-${r.key}`}>
                    <button
                      type="button"
                      onClick={() => setExpanded(expanded === i ? null : i)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[#212730]"
                    >
                      <StatusDot status={r.status} />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[#ebe7e4]">
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
                            className="flex flex-shrink-0 items-center gap-0.5 rounded-none border border-[#e8993a]/40 bg-[#231a10] px-1 py-0.5 text-[10px] font-medium tabular-nums text-[#e8993a]"
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
                      <span className="w-20 flex-shrink-0 text-right text-[10px] tabular-nums text-[#9fa4ab]">
                        {r.status === 'ok' ? `${(r.latencyMs / 1000).toFixed(1)}s · ${r.chars} chữ` : r.status === 'aborted' ? 'đã huỷ' : 'lỗi'}
                      </span>
                    </button>
                    {expanded === i && (
                      <div className="border-t border-[#495059] bg-[#161b22] px-3 py-2">
                        {r.error && <div className="mb-1 text-[11px] text-[#e8704f]">{r.error}</div>}
                        <div className="max-h-56 overflow-auto whitespace-pre-wrap text-[12px] leading-relaxed text-[#7ea3c7]">
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
            <div className="rounded-none border border-[#495059] bg-[#161b22] p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#6a9fcc]">
                Heatmap — điểm trung bình
              </div>
              <div className="overflow-x-auto">
                <SweepHeatmap heatmap={state.heatmap} />
              </div>
            </div>
          )}

          {state.groups.length > 0 && (
            <div className="rounded-none border border-[#495059] bg-[#161b22] p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#6a9fcc]">
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
            <div className="rounded-none border border-[#e8704f]/40 bg-[#241313] p-3">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-[#e8704f]">
                <AlertTriangle size={12} /> Ghi chú
              </div>
              <ul className="space-y-0.5 text-[11px] text-[#e8704f]">
                {state.errors.map((e, i) => (
                  <li key={`${i}-${e}`}>· {e}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Kết quả cuối */}
          {state.answer && (
            <div className="rounded-none border border-[#495059] bg-[#161b22] p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#6a9fcc]">
                Câu trả lời tổng hợp
              </div>
              <div className="claude-prose text-[#ebe7e4] text-xs leading-relaxed">
                <MarkdownRenderer content={state.answer} />
              </div>
            </div>
          )}

          {busy && !rows.length && (
            <div className="flex items-center gap-2 py-8 text-[12px] text-[#9fa4ab]">
              <Loader2 size={14} className="animate-spin text-[#6a9fcc]" /> Đang chuẩn bị lưới tham số…
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#495059] bg-[#1c2128] px-4 py-3">
          {busy ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-none border border-[#495059] bg-[#212730] px-3 py-1.5 font-mono text-[12px] font-medium text-[#ebe7e4] hover:border-[#757d89] hover:bg-[#252f3d]"
            >
              Dừng
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-none border border-[#495059] bg-[#212730] px-3 py-1.5 font-mono text-[12px] font-medium text-[#ebe7e4] hover:border-[#757d89] hover:bg-[#252f3d]"
              >
                Đóng
              </button>
              {state.phase !== 'idle' && (
                <button
                  type="button"
                  disabled={!goalDraft.trim()}
                  onClick={() => onRun({ goal: goalDraft.trim(), maxRuns, judge })}
                  className="rounded-none border border-[#495059] bg-[#212730] px-3 py-1.5 font-mono text-[12px] font-medium text-[#ebe7e4] hover:border-[#757d89] hover:bg-[#252f3d] disabled:opacity-40"
                >
                  Chạy lại
                </button>
              )}
              <button
                type="button"
                onClick={copy}
                disabled={!state.answer}
                className="inline-flex items-center gap-1.5 rounded-none border border-[#495059] bg-[#212730] px-3 py-1.5 font-mono text-[12px] font-medium text-[#ebe7e4] hover:border-[#757d89] hover:bg-[#252f3d] disabled:opacity-40"
              >
                {copied ? <Check size={13} className="text-[#64c2b3]" /> : <Copy size={13} />}
                {copied ? 'Đã chép' : 'Sao chép'}
              </button>
              <button
                type="button"
                onClick={() => {
                  onAdopt(state.answer);
                  onClose();
                }}
                disabled={!state.answer}
                className="rounded-none border border-[#495059] bg-[#212730] px-3 py-1.5 font-mono text-[12px] font-medium text-[#ebe7e4] hover:border-[#757d89] hover:bg-[#252f3d] disabled:opacity-40"
              >
                Đưa vào ô nhập
              </button>
              <button
                type="button"
                onClick={() => {
                  /* Chỉ đóng panel khi THÀNH công — guard bên handler từ chối
                     (busy/race) thì panel ở lại, toast là dấu vết. */
                  void (async () => {
                    if (await onAppendToChat(state.answer)) onClose();
                  })();
                }}
                disabled={!state.answer || chatBusy}
                title={chatBusy ? 'Chờ hết lượt đang chạy của hội thoại rồi thêm' : undefined}
                className="inline-flex items-center gap-1.5 rounded-none bg-[#6a9fcc] px-3.5 py-1.5 font-mono text-[12px] font-semibold text-[#0d1116] transition-colors hover:bg-[#89b8e0] disabled:opacity-40"
              >
                <MessageSquarePlus size={13} />
                Thêm vào hội thoại
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
