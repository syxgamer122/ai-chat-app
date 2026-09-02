/**
 * Structured Plan / Sub-task Tracker — giúp model phân rã task phức tạp
 * thành các subtask có thể theo dõi tiến độ.
 *
 * Port mô hình Plandex plans + Cline sub-agents về mô hình single-agent của
 * Vyen: KHÔNG tạo agent con hay chạy song song. Thay vào đó cung cấp tool
 * để model TỰ phân rã và track tiến độ trong cùng conversation.
 *
 * Thuần function, không Dexie/React — test được trong node.
 */

export type SubtaskStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

export interface Subtask {
  id: string;
  title: string;
  description?: string;
  status: SubtaskStatus;
  /** File paths liên quan (cho UI highlight). */
  files?: string[];
}

export interface Plan {
  title: string;
  subtasks: Subtask[];
  createdAt: number;
  updatedAt: number;
}

export function emptyPlan(title: string): Plan {
  const now = Date.now();
  return { title, subtasks: [], createdAt: now, updatedAt: now };
}

/** Tạo subtask ID đơn giản, deterministic từ index. */
export function subtaskId(index: number): string {
  return `st-${index + 1}`;
}

/** Thêm subtask vào plan. Trả plan mới (immutable). */
export function addSubtask(
  plan: Plan,
  title: string,
  opts?: { description?: string; files?: string[] },
): Plan {
  const sub: Subtask = {
    id: subtaskId(plan.subtasks.length),
    title,
    status: 'pending',
    ...(opts?.description ? { description: opts.description } : {}),
    ...(opts?.files?.length ? { files: opts.files } : {}),
  };
  return {
    ...plan,
    subtasks: [...plan.subtasks, sub],
    updatedAt: Date.now(),
  };
}

/** Cập nhật status của một subtask. Trả plan mới hoặc null nếu ID không tồn tại. */
export function updateSubtaskStatus(
  plan: Plan,
  id: string,
  status: SubtaskStatus,
): Plan | null {
  const idx = plan.subtasks.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const updated = [...plan.subtasks];
  updated[idx] = { ...updated[idx], status };
  return { ...plan, subtasks: updated, updatedAt: Date.now() };
}

/** Thống kê tiến độ plan. */
export interface PlanProgress {
  total: number;
  done: number;
  failed: number;
  inProgress: number;
  pending: number;
  skipped: number;
  percentComplete: number;
}

export function planProgress(plan: Plan): PlanProgress {
  const total = plan.subtasks.length;
  const done = plan.subtasks.filter((s) => s.status === 'done').length;
  const failed = plan.subtasks.filter((s) => s.status === 'failed').length;
  const inProgress = plan.subtasks.filter((s) => s.status === 'in_progress').length;
  const pending = plan.subtasks.filter((s) => s.status === 'pending').length;
  const skipped = plan.subtasks.filter((s) => s.status === 'skipped').length;
  return {
    total,
    done,
    failed,
    inProgress,
    pending,
    skipped,
    percentComplete: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

/**
 * Serialize plan thành text ngắn gọn để chèn vào system prompt hoặc tool result.
 * Format: checkbox list với status icon.
 */
export function formatPlanSummary(plan: Plan): string {
  const icons: Record<SubtaskStatus, string> = {
    pending: '○',
    in_progress: '◐',
    done: '●',
    failed: '✗',
    skipped: '⊘',
  };
  const lines = plan.subtasks.map(
    (s) => `${icons[s.status]} [${s.id}] ${s.title}${s.status === 'in_progress' ? ' ← đang làm' : ''}`,
  );
  const prog = planProgress(plan);
  return [
    `[PLAN] ${plan.title} (${prog.done}/${prog.total} xong, ${prog.percentComplete}%)`,
    ...lines,
  ].join('\n');
}

/** Parse plan từ JSON (lưu trong ChatSession). An toàn với input rác. */
export function parsePlan(raw: unknown): Plan | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.title !== 'string') return null;
  if (!Array.isArray(p.subtasks)) return null;
  const validStatuses: SubtaskStatus[] = ['pending', 'in_progress', 'done', 'failed', 'skipped'];
  const subtasks: Subtask[] = [];
  for (const s of p.subtasks) {
    if (!s || typeof s !== 'object') continue;
    const st = s as Record<string, unknown>;
    if (typeof st.id !== 'string' || typeof st.title !== 'string') continue;
    const status = validStatuses.includes(st.status as SubtaskStatus) ? (st.status as SubtaskStatus) : 'pending';
    subtasks.push({
      id: st.id,
      title: st.title,
      status,
      ...(typeof st.description === 'string' ? { description: st.description } : {}),
      ...(Array.isArray(st.files) ? { files: st.files.filter((f): f is string => typeof f === 'string') } : {}),
    });
  }
  return {
    title: p.title,
    subtasks,
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
  };
}
