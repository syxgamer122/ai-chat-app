/**
 * StuckDetector — phát hiện vòng lặp vô nghĩa từ event stream.
 *
 * StuckDetector phân loại "kẹt" theo pattern LẶP trong event
 * stream (mẫu 4-4, 3-3, 4-2...). Vyen đang chỉ có 2 heuristics rời rạc:
 * goal-loop (3 câu trả lời y hệt) và debug-loop (3 lần cùng exit code + cùng
 * stderr). Cả hai chỉ nhìn 1 chiều. StuckDetector nhìn TOÀN BỘ stream và
 * phân loại cụ thể:
 *
 * - repetition_4_4: 2 khối [action-obs-action-obs] y hệt liên tiếp → chắc chắn
 *   kẹt (pattern `repetition_4_4`).
 * - repetition_3_3: 2 khối [action-obs-action] y hệt (lượt kết thúc bằng
 *   action chưa có obs — pattern `repetition_3_3`).
 * - action_error_loop: cùng tool lỗi lặp lại N lần liên tiếp → đổi hướng thay
 *   vì gọi lại.
 * - message_loop: assistant text y hệt liên tiếp (nâng cấp ý tưởng goal-loop
 *   từ 3 lên cấu hình được, và nhận diện qua hash thay vì text).
 *
 * Phân loại đúng giúp steering tốt hơn: "bạn đang gọi X lặp lại gây lỗi Y, hãy
 * dùng cách khác" thay vì một câu "hãy thử tiếp" chung chung.
 */

import { getRecentEvents, type AgentRuntimeEvent } from '@/lib/agent-runtime/event-stream';

/* ------------------------------------------------------------------ */
/* Loại kẹt                                                            */
/* ------------------------------------------------------------------ */

export type StuckPattern =
  | 'repetition_4_4'
  | 'repetition_3_3'
  | 'action_error_loop'
  | 'message_loop';

export interface StuckDetection {
  stuck: boolean;
  pattern?: StuckPattern;
  /** Mô tả tiếng Việt ngắn gọn để chèn vào steering message. */
  detail: string;
  /** Hash chuỗi khiến agent kẹt — giúp steering nêu đích danh. */
  repeatedTool?: string;
  repeatedError?: string;
}

/* ------------------------------------------------------------------ */
/* Cấu hình                                                            */
/* ------------------------------------------------------------------ */

/** Số khối lặp liên tiếp để kết luận kẹt (mặc định 2). */
export const STUCK_LOOP_REPEATS = 2;

/** Số lần cùng tool lỗi liên tiếp để tính là action_error_loop. */
export const STUCK_ERROR_LOOP_THRESHOLD = 3;

/** Số assistant message y hệt liên tiếp để tính message_loop. */
export const STUCK_MESSAGE_LOOP_THRESHOLD = 3;

/* ------------------------------------------------------------------ */
/* Phân tích                                                           */
/* ------------------------------------------------------------------ */

/** So 2 event "y hệt": cùng type + cùng hash nội dung (+ cùng tool). */
function identical(a: AgentRuntimeEvent, b: AgentRuntimeEvent): boolean {
  return a.contentHash === b.contentHash && a.type === b.type && a.toolName === b.toolName;
}

/** Lấy N event cuối theo đúng thứ tự cũ → mới. */
function tail(events: readonly AgentRuntimeEvent[], n: number): AgentRuntimeEvent[] {
  return events.slice(Math.max(0, events.length - n));
}

/**
 * Phân tích stream và trả về chẩn đoán kẹt. THUẦN với events truyền vào —
 * caller (client) gọi với getEventStream() hoặc tự dựng mảng từ transcript.
 * Không có gì kẹt → { stuck: false, detail: '' }.
 */
export function detectStuck(events: readonly AgentRuntimeEvent[]): StuckDetection {
  // 1. repetition_4_4 — 2 khối [action obs action obs] y hệt liên tiếp.
  const window8 = tail(events, 8);
  if (window8.length === 8) {
    const [a1, o1, a2, o2, a3, o3, a4, o4] = window8;
    if (
      a1.type === 'agent_action' &&
      o1.type === 'agent_observation' &&
      a2.type === 'agent_action' &&
      o2.type === 'agent_observation' &&
      identical(a1, a2) &&
      identical(a1, a3) &&
      identical(o1, o2) &&
      identical(o1, o3) &&
      identical(a2, a4) &&
      identical(o2, o4)
    ) {
      return {
        stuck: true,
        pattern: 'repetition_4_4',
        detail: `Agent lặp lại chính xác chuỗi gọi "${a1.toolName ?? 'tool'}" và nhận cùng kết quả nhiều lần liên tiếp — không tiến triển.`,
        repeatedTool: a1.toolName,
      };
    }
  }

  // 2. action_error_loop — cùng tool lỗi N lần liên tiếp (không cần obs giống hệt).
  const errorLoop = detectActionErrorLoop(events);
  if (errorLoop) return errorLoop;

  // 3. repetition_3_3 — 2 khối [action obs action] y hệt (lượt kết thúc bằng action).
  const window6 = tail(events, 6);
  if (window6.length === 6) {
    const [a1, o1, a2, o2, a3, o3] = window6;
    if (
      a1.type === 'agent_action' &&
      o1.type === 'agent_observation' &&
      a2.type === 'agent_action' &&
      o2.type === 'agent_observation' &&
      identical(a1, a2) &&
      identical(a1, a3) &&
      identical(o1, o2)
    ) {
      return {
        stuck: true,
        pattern: 'repetition_3_3',
        detail: `Agent lặp lại chuỗi gọi "${a1.toolName ?? 'tool'}" → nhận kết quả → gọi lại y hệt nhiều lần liên tiếp.`,
        repeatedTool: a1.toolName,
      };
    }
  }

  // 4. message_loop — assistant text y hệt liên tiếp.
  const messageLoop = detectMessageLoop(events);
  if (messageLoop) return messageLoop;

  return { stuck: false, detail: '' };
}

/**
 * Phát hiện cùng một tool trả lỗi N lần liên tiếp (các event `agent_error`).
 * Khác repetition_4_4: lỗi có thể khác nội dung, chỉ cần CÙNG TOOL là đủ để
 * cảnh báo sớm trước khi rơi vào vòng lặp đầy đủ.
 */
function detectActionErrorLoop(events: readonly AgentRuntimeEvent[]): StuckDetection | null {
  // Chỉ xét dãyy lỗi cuối cùng (bị ngắt bởi bất kỳ event nào khác loại).
  let i = events.length - 1;
  while (i >= 0 && events[i].type === 'agent_error') i -= 1;
  const errorRun = events.slice(i + 1);
  if (errorRun.length < STUCK_ERROR_LOOP_THRESHOLD) return null;

  const tool = errorRun[0].toolName;
  if (!tool) return null;
  if (!errorRun.every((e) => e.toolName === tool)) return null;

  const lastError = errorRun[errorRun.length - 1].payload.replace(/\s+/g, ' ').trim();
  const briefError = lastError.length > 200 ? `${lastError.slice(0, 200)}…` : lastError;
  return {
    stuck: true,
    pattern: 'action_error_loop',
    detail: `Tool "${tool}" lỗi ${errorRun.length} lần liên tiếp (lỗi cuối: ${briefError}). Cần ĐỔI HƯỚNG tiếp cận thay vì gọi lại.`,
    repeatedTool: tool,
    repeatedError: briefError,
  };
}

/** Assistant message y hệt STUCK_MESSAGE_LOOP_THRESHOLD lần liên tiếp. */
function detectMessageLoop(events: readonly AgentRuntimeEvent[]): StuckDetection | null {
  let i = events.length - 1;
  while (i >= 0 && events[i].type === 'assistant_message') i -= 1;
  const run = events.slice(i + 1);
  if (run.length < STUCK_MESSAGE_LOOP_THRESHOLD) return null;
  const firstHash = run[0].contentHash;
  if (!run.every((e) => e.contentHash === firstHash)) return null;
  return {
    stuck: true,
    pattern: 'message_loop',
    detail: `Assistant trả lời y hệt ${run.length} lần liên tiếp — không tiến triển về nội dung.`,
  };
}

/* ------------------------------------------------------------------ */
/* API tiện dụng cho caller                                            */
/* ------------------------------------------------------------------ */

/**
 * Đánh giá hội thoại theo stream đã ghi. Wrapper thuận tiện — kết quả tương
 * đương detectStuck(getRecentEvents(conversationId, 12)).
 */
export function detectStuckForConversation(
  conversationId: string | null | undefined,
): StuckDetection {
  // 12 event: đủ chứa pattern 4-4 và vài event ngữ cảnh.
  return detectStuck(getRecentEvents(conversationId, 12));
}

/**
 * Build steering message khi phát hiện kẹt — CHÈN VÀO lượt tiếp theo để model
 * tự đổi hướng. Không chèn khi không kẹt (undefined).
 */
export function buildStuckSteering(detection: StuckDetection): string | undefined {
  if (!detection.stuck) return undefined;
  return [
    '[PHÁT HIỆN BẤT THƯỜNG] Vòng lặp agent hiện đang không tiến triển:',
    `- ${detection.detail}`,
    'YÊU CẦU: đổi hướng tiếp cận RÕ RỆT — chiến lược khác, tool khác, hoặc khai báo chặn với người dùng thay vì lặp lại cùng hành động.',
  ].join('\n');
}
