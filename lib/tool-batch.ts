/**
 * P2.1 — Parallel tool execution (port kiến trúc agent loop agent loop).
 *
 * Thuật toán đúng theo chuẩn:
 * 1. Preflight TUẦN TỰ: gán id, bắn `onStart` theo đúng thứ tự source.
 * 2. Nếu BẤT KỲ tool nào trong batch có mode `sequential` → cả batch chạy tuần tự.
 * 3. Còn lại chạy `Promise.all`; `onSettled` bắn NGAY khi từng tool xong
 *    (thứ tự hoàn thành — tương đương `tool_execution_end` của agent loop).
 * 4. Kết quả trả về LUÔN theo thứ tự source (bất biến transcript deterministic).
 *
 * File thuần, không import AI SDK / DOM — test được bằng vitest trong node.
 */

export type ToolExecutionMode = 'parallel' | 'sequential';

/**
 * Tool ghi/side-effect ngoài process PHẢI chạy tuần tự (tránh race cùng file,
 * modal duyệt chồng nhau). Tool chỉ đọc / thuần validation chạy song song.
 * Tên lạ (mcp__*, tool tương lai) mặc định parallel — Loop cũng vậy.
 */
const SEQUENTIAL_TOOLS: ReadonlySet<string> = new Set([
  // Ghi file qua staging — race trên cùng file.
  'fs_edit',
  'fs_write',
  // Side-effect ngoài process.
  'shell_run',
  'git_add',
  'git_commit',
  'bg_run',
  'bg_stop',
  // Subagent có context riêng nhưng tốn + khó trace khi chồng nhau.
  'delegate',
  // Plan tools đổi state plan chung.
  'plan_create',
  'plan_update',
]);

export function getToolExecutionMode(toolName: string): ToolExecutionMode {
  return SEQUENTIAL_TOOLS.has(toolName) ? 'sequential' : 'parallel';
}

export interface ToolBatchItem {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolBatchOutcome extends ToolBatchItem {
  /** true = execute resolve; false = execute ném (đã gom thành result lỗi). */
  ok: boolean;
  result: unknown;
  durationMs: number;
}

export interface ToolBatchOptions {
  modeOf?: (toolName: string) => ToolExecutionMode;
  execute: (item: ToolBatchItem, index: number) => Promise<unknown>;
  /** Bắn tuần tự theo thứ tự source (preflight). */
  onStart?: (item: ToolBatchItem, index: number) => void;
  /** Bắn ngay khi từng tool xong (thứ tự hoàn thành). Có thể await — hook
   * async (afterToolCall của agent loop) hoàn tất trước khi tool coi là settled.
   * Giá trị trả về bị bỏ qua (unknown để caller tự do ghi log/đếm). */
  onSettled?: (item: ToolBatchItem, outcome: ToolBatchOutcome) => unknown;
}

function errorResultOf(err: unknown): Record<string, unknown> {
  return { note: err instanceof Error ? err.message : String(err ?? 'Công cụ thất bại.') };
}

/**
 * Chạy một batch tool call. Không bao giờ reject: lỗi từng tool gom vào outcome.
 * Mảng trả về cùng độ dài + cùng thứ tự với `items`.
 */
export async function executeToolBatch(
  items: readonly ToolBatchItem[],
  opts: ToolBatchOptions,
): Promise<ToolBatchOutcome[]> {
  const modeOf = opts.modeOf ?? getToolExecutionMode;
  const outcomes = new Array<ToolBatchOutcome>(items.length);

  // Preflight tuần tự — kể cả ở chế độ parallel.
  items.forEach((item, index) => opts.onStart?.(item, index));

  const runOne = async (item: ToolBatchItem, index: number): Promise<ToolBatchOutcome> => {
    const startedAt = Date.now();
    try {
      const result = await opts.execute(item, index);
      return { ...item, ok: true, result, durationMs: Date.now() - startedAt };
    } catch (err) {
      return { ...item, ok: false, result: errorResultOf(err), durationMs: Date.now() - startedAt };
    }
  };

  const needsSequential = items.some((item) => modeOf(item.name) === 'sequential');

  if (needsSequential || items.length <= 1) {
    for (let index = 0; index < items.length; index++) {
      const outcome = await runOne(items[index], index);
      outcomes[index] = outcome;
      await opts.onSettled?.(items[index], outcome);
    }
    return outcomes;
  }

  await Promise.all(
    items.map(async (item, index) => {
      const outcome = await runOne(item, index);
      outcomes[index] = outcome;
      await opts.onSettled?.(item, outcome);
    }),
  );
  return outcomes;
}
