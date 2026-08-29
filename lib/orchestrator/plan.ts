/**
 * Hợp đồng plan của orchestrator — port phần **chưa có** của
 * Untrivial-ai/agent-orchestrator sang KODA.
 *
 * Ở AO, orchestrator là MỘT session (`kind: orchestrator`) làm 3 việc:
 *   1. **Plan**  — phân rã task thành việc cần làm.
 *   2. **Spawn** — tạo N session agent, mỗi session có workspace/context RIÊNG
 *                  (cô lập: agent này không thấy transcript của agent kia).
 *   3. **Review** — gom kết quả (messages + changed files) rồi sửa lỗi CI,
 *                  merge conflict, review code.
 *
 * KODA đã có sẵn phần reconciler (lib/run-lifecycle.ts) và plan tracker
 * (lib/subtask-plan.ts) — module này CHỈ lấy phần còn thiếu: **hợp đồng dữ
 * liệu của bước Plan**, đủ chặt để một LLM sinh ra và đủ lỏng để parse được
 * ngay cả khi model trả JSON rác.
 *
 * Quan trọng: đây là plan cho **một lượt quét**, không phải plan công việc dài
 * hạn — nó mô tả LƯỚI THAM SỐ (mượn từ vectorbt) chứ không phải backlog.
 */

import { z } from 'zod';
import { MAX_AXES, MAX_CELLS_LIMIT, MAX_VALUES_PER_AXIS, type Axis } from './grid';

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export const AxisSchema = z.object({
  name: z.string().min(1).max(32),
  values: z.array(z.string().min(1).max(120)).min(1).max(MAX_VALUES_PER_AXIS),
});

export const SubtaskSchema = z.object({
  id: z.string().min(1).max(48),
  title: z.string().min(1).max(160),
  brief: z.string().max(600).optional(),
});

export const OrchestratorPlanSchema = z.object({
  /** Mục tiêu đã được diễn đạt lại, ngắn gọn. */
  goal: z.string().min(1).max(400),
  /** Các trục của lưới tham số. Tối đa MAX_AXES. */
  axes: z.array(AxisSchema).max(MAX_AXES).default([]),
  /** Việc cần làm — chỉ dùng để hiển thị tiến độ, không spawn agent riêng. */
  subtasks: z.array(SubtaskSchema).max(8).default([]),
  /** Tiêu chí chấm điểm do chính planner đề xuất (truyền cho judge). */
  criteria: z.array(z.string().min(1).max(160)).max(6).default([]),
});

export type OrchestratorPlan = z.infer<typeof OrchestratorPlanSchema>;
export type PlanSubtask = z.infer<typeof SubtaskSchema>;

/* ------------------------------------------------------------------ */
/* Lưới mặc định — chạy được ngay cả khi planner hỏng                  */
/* ------------------------------------------------------------------ */

/**
 * Lưới dự phòng: 2 trục × (3 × 2) = 6 cấu hình.
 *
 * Chọn đúng 2 trục vì heatmap cần 2 chiều để có nghĩa (vectorbt
 * `.vbt.heatmap(x_level, y_level)`), và chọn đúng 6 ô vì đó là trần chi phí
 * mặc định (MAX_CELLS_DEFAULT). Deterministic → planner hỏng vẫn cho kết quả
 * ổn định, reproduce được, và test được không cần mock LLM.
 */
export const DEFAULT_AXES: readonly Axis[] = Object.freeze([
  { name: 'góc tiếp cận', values: ['trực tiếp', 'từng bước', 'phản biện'] },
  { name: 'độ chi tiết', values: ['ngắn gọn', 'chi tiết'] },
]);

export const DEFAULT_CRITERIA: readonly string[] = Object.freeze([
  'Trả lời đúng trọng tâm câu hỏi',
  'Có lập luận/căn cứ, không khẳng định suông',
  'Đầy đủ nhưng không lan man',
]);

export function defaultPlan(goal: string): OrchestratorPlan {
  return {
    goal: goal.trim().slice(0, 400) || 'Mục tiêu chưa đặt tên',
    axes: DEFAULT_AXES.map((a) => ({ name: a.name, values: a.values.slice() })),
    subtasks: [],
    criteria: DEFAULT_CRITERIA.slice(),
  };
}

/* ------------------------------------------------------------------ */
/* Parse                                                               */
/* ------------------------------------------------------------------ */

/** Parse an toàn. Rác / sai shape → null (KHÔNG đoán). */
export function parsePlan(raw: unknown): OrchestratorPlan | null {
  const r = OrchestratorPlanSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Parse có nới: nhận object thô từ LLM, thử schema; thất bại → lùi về lưới
 * mặc định với `goal` đã cho. Không bao giờ throw — planner là thành phần hay
 * hỏng nhất (model yếu hay trả JSON kèm text thừa).
 */
export function coercePlan(raw: unknown, goal: string): OrchestratorPlan {
  const cleanGoal = goal.trim().slice(0, 400) || 'Mục tiêu chưa đặt tên';
  const parsed = parsePlan(raw);
  if (!parsed) return defaultPlan(cleanGoal);

  return {
    goal: parsed.goal.trim() || cleanGoal,
    // Lưới rỗng = planner quên sinh trục → dùng mặc định thay vì chạy 0 ô.
    axes: parsed.axes.length ? parsed.axes : defaultPlan(cleanGoal).axes,
    subtasks: parsed.subtasks,
    criteria: parsed.criteria.length ? parsed.criteria : DEFAULT_CRITERIA.slice(),
  };
}

/* ------------------------------------------------------------------ */
/* Gợi ý cho từng mức của trục                                         */
/* ------------------------------------------------------------------ */

/**
 * Hướng dẫn ngắn cho các mức do CHÚNG TA định nghĩa sẵn. Mục đích: hai cell
 * khác nhau phải cho ra hai câu trả lời THỰC SỰ khác nhau, chứ không phải
 * cùng một câu trả lời được viết lại — nếu không thì cả lưới vô nghĩa.
 *
 * Mức do planner tự đặt tên (không nằm trong bảng) → không có gợi ý, model tự
 * hiểu theo tên; đó là behaviour chấp nhận được.
 */
const HINTS: Record<string, string> = Object.freeze({
  'trực tiếp': 'Trả lời thẳng vào câu hỏi ngay từ câu đầu tiên, không dạo đầu.',
  'từng bước': 'Trình bày theo bước đánh số, nêu rõ giả thiết ở mỗi bước rồi mới đi tiếp.',
  'phản biện': 'Nêu trước câu trả lời phổ biến nhất, chỉ ra điểm yếu của nó, rồi mới chốt lại.',
  'ngắn gọn': 'Tối đa khoảng 150 từ. Kết luận lên đầu, bỏ giải thích phụ.',
  'chi tiết': 'Triển khai đầy đủ, kèm ví dụ cụ thể và các lưu ý/ngoại lệ.',
  'thực dụng': 'Ưu tiên điều làm được ngay; bỏ qua lý thuyết không dùng tới.',
  'học thuật': 'Dùng khái niệm chính xác, phân biệt rõ điều đã biết và điều đang giả định.',
  'thận trọng': 'Nêu rõ rủi ro, mặt trái và điều kiện để câu trả lời không còn đúng.',
});

export function hintFor(value: string): string | null {
  return HINTS[value.trim().toLowerCase()] ?? null;
}

/**
 * Danh sách gợi ý cho một cell — đưa thẳng vào system prompt của worker.
 * Chỉ trả về dòng cho những mức CÓ gợi ý, để prompt không bị nhiễu bởi
 * những dòng "hãy làm theo tên gọi" vô nghĩa.
 */
export function hintsForCoords(coords: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(coords)) {
    const hint = hintFor(value);
    if (hint) out.push(`- ${name} = ${value}: ${hint}`);
  }
  return out;
}

export const MAX_RUNS_LIMIT = MAX_CELLS_LIMIT;
