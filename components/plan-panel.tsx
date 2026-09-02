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

/**
 * Checklist tiến độ của plan hiện tại — promise trong khối [PLANNING] của
 * system prompt ("Người dùng sẽ thấy checklist tiến độ trong UI") được minh
 * thực bởi component này. Dữ liệu do plan_create/plan_update ghi vào kv
 * (key `plan:<chatId>`), chat-interface nạp và cập nhật qua props.
 */

const STATUS_META: Record<
  SubtaskStatus,
  { Icon: typeof Circle; className: string; label: string }
> = {
  pending: { Icon: Circle, className: "text-zinc-400", label: "Chờ" },
  in_progress: { Icon: Loader2, className: "animate-spin text-blue-500", label: "Đang làm" },
  done: { Icon: CheckCircle2, className: "text-emerald-500", label: "Xong" },
  failed: { Icon: XCircle, className: "text-red-500", label: "Lỗi" },
  skipped: { Icon: CircleMinus, className: "text-zinc-400", label: "Bỏ qua" },
};

interface PlanPanelProps {
  plan: Plan;
  onHide: () => void;
}

export function PlanPanel({ plan, onHide }: PlanPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const prog = planProgress(plan);
  const anyActive = prog.done + prog.failed + prog.skipped < prog.total;

  return (
    <div
      className="mx-auto w-full max-w-3xl px-3 pb-2"
      role="region"
      aria-label={`Kế hoạch: ${plan.title}`}
    >
      <div className="rounded-xl border border-zinc-200 bg-white/80 text-sm shadow-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/70">
        <div className="flex items-center gap-2 px-3 py-2">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" />
            )}
            <ListTodo
              className={`h-4 w-4 flex-shrink-0 ${
                anyActive ? "text-blue-500 dark:text-blue-400" : "text-emerald-500"
              }`}
              aria-hidden
            />
            <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">
              {plan.title}
            </span>
            <span className="ml-auto flex-shrink-0 text-xs tabular-nums text-zinc-500">
              {prog.done}/{prog.total} · {prog.percentComplete}%
            </span>
          </button>
          <button
            type="button"
            onClick={onHide}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
            aria-label="Ẩn kế hoạch"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Thanh tiến độ mảnh — luôn hiển thị kể cả khi thu gọn */}
        <div className="h-1 overflow-hidden rounded-b-xl bg-zinc-100 dark:bg-zinc-800">
          <div
            className={`h-full rounded transition-all duration-500 ${
              anyActive
                ? "bg-gradient-to-r from-blue-500 to-emerald-500"
                : "bg-emerald-500"
            }`}
            style={{ width: `${prog.percentComplete}%` }}
          />
        </div>

        {expanded && (
          <ol className="space-y-1 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
            {plan.subtasks.map((st) => {
              const meta = STATUS_META[st.status];
              const { Icon } = meta;
              return (
                <li key={st.id} className="flex items-start gap-2">
                  <Icon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${meta.className}`} aria-hidden />
                  <div className="min-w-0">
                    <span
                      className={`text-[13px] leading-5 ${
                        st.status === "done"
                          ? "text-zinc-400 line-through dark:text-zinc-500"
                          : st.status === "in_progress"
                            ? "font-medium text-zinc-800 dark:text-zinc-100"
                            : "text-zinc-600 dark:text-zinc-300"
                      }`}
                    >
                      {st.title}
                    </span>
                    {st.description && (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">{st.description}</p>
                    )}
                    {st.files && st.files.length > 0 && (
                      <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
                        {st.files.join(" · ")}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
