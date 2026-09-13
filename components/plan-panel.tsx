"use client";

import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleMinus,
  ListTodo,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
import type { Plan, SubtaskStatus } from "@/lib/subtask-plan";
import { planProgress } from "@/lib/subtask-plan";
import { EvidenceBadge } from "@/components/evidence-badge";

/**
 * Checklist tiến độ của plan hiện tại — promise trong khối [PLANNING] của
 * system prompt ("Người dùng sẽ thấy checklist tiến độ trong UI") được minh
 * thực bởi component này. Dữ liệu do plan_create/plan_update ghi vào kv
 * (key `plan:<chatId>`), chat-interface nạp và cập nhật qua props.
 *
 * Phase-TODO Discipline (Oh My Hermes port):
 * - Ép tối đa 1 item active (in_progress) tại một thời điểm
 * - Tự động thu gọn (fold) khi danh sách vượt quá 8 dòng
 * - Hiển thị badge bậc thang bằng chứng (Evidence Ladder)
 */

const STATUS_META: Record<
  SubtaskStatus,
  { Icon: typeof Circle; className: string; label: string }
> = {
  pending: { Icon: Circle, className: "text-[#9fa4ab]", label: "Chờ" },
  in_progress: { Icon: Loader2, className: "animate-spin text-[#6a9fcc]", label: "Đang làm" },
  done: { Icon: CheckCircle2, className: "text-[#5db87a]", label: "Xong" },
  failed: { Icon: XCircle, className: "text-[#e8704f]", label: "Lỗi" },
  skipped: { Icon: CircleMinus, className: "text-[#9fa4ab]", label: "Bỏ qua" },
};

interface PlanPanelProps {
  plan: Plan;
  onHide: () => void;
}

export function PlanPanel({ plan, onHide }: PlanPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [showAllTasks, setShowAllTasks] = useState(false);
  const prog = planProgress(plan);
  const anyActive = prog.done + prog.failed + prog.skipped < prog.total;

  // Tính evidence level của toàn plan
  const planEvidence = prog.done === prog.total && prog.total > 0
    ? 'verified'
    : anyActive
      ? 'running'
      : 'prepared';

  // Phase-TODO discipline: tìm item in_progress ĐẦU TIÊN làm active item duy nhất
  let foundActive = false;
  const normalizedSubtasks = plan.subtasks.map((st) => {
    if (st.status === 'in_progress') {
      if (!foundActive) {
        foundActive = true;
        return { ...st, isActive: true };
      }
      return { ...st, isActive: false, status: 'pending' as SubtaskStatus };
    }
    return { ...st, isActive: false };
  });

  // Fold khi quá 8 dòng
  const FOLD_LIMIT = 8;
  const isFolded = normalizedSubtasks.length > FOLD_LIMIT && !showAllTasks;
  const visibleTasks = isFolded ? normalizedSubtasks.slice(0, FOLD_LIMIT) : normalizedSubtasks;

  return (
    <div
      className="mx-auto w-full max-w-thread px-4 pb-2 font-mono"
      role="region"
      aria-label={`Kế hoạch: ${plan.title}`}
    >
      <div className="rounded-none border border-[#495059] bg-[#212730] text-xs">
        <div className="flex items-center gap-2 px-3 py-2">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-[#9fa4ab]" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-[#9fa4ab]" />
            )}
            <ListTodo
              className={`h-3.5 w-3.5 flex-shrink-0 ${
                anyActive ? "text-[#6a9fcc]" : "text-[#5db87a]"
              }`}
              aria-hidden
            />
            <span className="truncate font-semibold text-[#ebe7e4]">
              <span className="text-[#6a9fcc] mr-1">$</span>
              {plan.title}
            </span>
            <EvidenceBadge level={planEvidence} className="ml-1" />
            <span className="ml-auto flex-shrink-0 text-[11px] tabular-nums text-[#6a9fcc]">
              {prog.done}/{prog.total} · {prog.percentComplete}%
            </span>
          </button>
          <button
            type="button"
            onClick={onHide}
            className="rounded-none p-1 text-[#9fa4ab] hover:bg-[#252f3d] hover:text-[#ebe7e4]"
            aria-label="Ẩn kế hoạch"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Thanh tiến độ mảnh — luôn hiển thị kể cả khi thu gọn */}
        <div className="h-1 overflow-hidden bg-[#161d27]">
          <div
            className={`h-full ${anyActive ? "bg-[#6a9fcc]" : "bg-[#5db87a]"}`}
            style={{ width: `${Math.max(0, Math.min(100, prog.percentComplete))}%` }}
          />
        </div>

        {expanded && (
          <div className="border-t border-[#495059] bg-[#161d27] px-3 py-2">
            <ol className="space-y-1.5">
              {visibleTasks.map((st) => {
                const meta = STATUS_META[st.status];
                const { Icon } = meta;
                return (
                  <li
                    key={st.id}
                    className={`flex items-start gap-2 rounded px-1.5 py-0.5 transition-colors ${
                      st.isActive ? "bg-[#6a9fcc]/10 border border-[#6a9fcc]/30" : ""
                    }`}
                  >
                    <Icon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${meta.className}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[12px] leading-5 ${
                            st.status === "done"
                              ? "text-[#9fa4ab] line-through"
                              : st.isActive
                                ? "font-semibold text-[#ebe7e4]"
                                : "text-[#9fa4ab]"
                          }`}
                        >
                          {st.title}
                        </span>
                        {st.isActive && (
                          <span className="text-[10px] uppercase tracking-wider text-[#6a9fcc] font-semibold">
                            [active]
                          </span>
                        )}
                      </div>
                      {st.description && (
                        <p className="text-[11px] text-[#9fa4ab]">{st.description}</p>
                      )}
                      {st.files && st.files.length > 0 && (
                        <p className="mt-0.5 truncate font-mono text-[10.5px] text-[#6a9fcc]">
                          {st.files.join(" · ")}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>

            {/* Nút toggle fold khi danh sách quá 8 items */}
            {normalizedSubtasks.length > FOLD_LIMIT && (
              <div className="mt-2 pt-1 border-t border-[#495059]/40 text-center">
                <button
                  type="button"
                  onClick={() => setShowAllTasks(!showAllTasks)}
                  className="text-[11px] text-[#6a9fcc] hover:text-[#ebe7e4] transition-colors"
                >
                  {showAllTasks
                    ? "▲ Thu gọn danh sách (hiện 8 mục đầu)"
                    : `▼ Xem thêm ${normalizedSubtasks.length - FOLD_LIMIT} công việc nữa...`}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
