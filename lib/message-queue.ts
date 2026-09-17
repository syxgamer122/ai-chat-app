/**
 * P3.1 — Steering vs Follow-up queue (port kiến trúc agent loop agent loop).
 *
 * - **Steering** (Enter khi agent đang chạy): inject NGAY sau khi turn hiện
 *   tại xong (kể cả turn đó là tool-call resubmit).
 * - **Follow-up** (Alt+Enter khi agent đang chạy): chỉ inject khi agent đã hết
 *   việc (finishReason !== 'tool-calls') và không còn steering.
 * - `QueueMode`: "one-at-a-time" (mặc định) lấy 1 tin/lần drain; "all" lấy hết.
 *
 * Module thuần, không React/DOM — state sống trong chat-interface (ref), test
 * được bằng vitest trong node. Hàng đợi có trần để composer spam Enter không
 * phình bộ nhớ; tin vượt trần bị bỏ và caller báo UI.
 */

export type QueueMode = 'one-at-a-time' | 'all';

/** Trần mỗi hàng đợi — đủ cho spam Enter, đủ nhỏ để không phình bộ nhớ. */
export const MESSAGE_QUEUE_CAP = 5;

export function isQueueMode(v: unknown): v is QueueMode {
  return v === 'one-at-a-time' || v === 'all';
}

export interface DrainResult {
  /** Các tin được lấy ra (theo thứ tự enqueue). */
  taken: string[];
  /** Các tin còn lại trong hàng đợi. */
  rest: string[];
}

/** Lấy tin khỏi hàng đợi theo mode. Không mutate mảng đầu vào. */
export function drainQueue(queue: readonly string[], mode: QueueMode): DrainResult {
  if (queue.length === 0) return { taken: [], rest: [] };
  if (mode === 'all') return { taken: [...queue], rest: [] };
  return { taken: [queue[0]], rest: queue.slice(1) };
}

export interface EnqueueResult {
  /** Hàng đợi sau khi thêm (không mutate mảng đầu vào). */
  queue: string[];
  /** true khi tin bị bỏ vì hàng đợi đã đầy. */
  dropped: boolean;
}

/** Thêm tin vào cuối hàng đợi; vượt trần thì bỏ tin mới (giữ tin cũ). */
export function enqueueMessage(queue: readonly string[], text: string): EnqueueResult {
  if (queue.length >= MESSAGE_QUEUE_CAP) return { queue: [...queue], dropped: true };
  return { queue: [...queue, text], dropped: false };
}

/**
 * Thứ tự poll trong onFinish (đúng chuẩn): hết tool call → steering? inject +
 * turn mới → không có thì goal-continue? → không thì follow-up? inject.
 * Hàm này chỉ quyết định giữa steering và follow-up khi caller đã biết turn
 * hiện tại KHÔNG phải tool-call resubmit.
 */
export function pickQueuedPrompt(
  steering: readonly string[],
  followUp: readonly string[],
  steeringMode: QueueMode,
  followUpMode: QueueMode,
): { kind: 'steering' | 'follow-up' | null; taken: string[]; steeringRest: string[]; followUpRest: string[] } {
  const s = drainQueue(steering, steeringMode);
  if (s.taken.length > 0) {
    return { kind: 'steering', taken: s.taken, steeringRest: s.rest, followUpRest: [...followUp] };
  }
  const f = drainQueue(followUp, followUpMode);
  if (f.taken.length > 0) {
    return { kind: 'follow-up', taken: f.taken, steeringRest: [...steering], followUpRest: f.rest };
  }
  return { kind: null, taken: [], steeringRest: [...steering], followUpRest: [...followUp] };
}
