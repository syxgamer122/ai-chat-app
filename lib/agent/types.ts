/**
 * P1.1 — Kiểu dữ liệu của agent loop thuần (port kiến trúc `pi-agent-core`).
 *
 * Loop KHÔNG biết gì về React / Next / DOM / AI SDK: mọi phụ thuộc bên ngoài
 * được inject qua `AgentLoopConfig` (streamFn, executeTool, các hook). Nhờ vậy
 * file này và `loop.ts` test được bằng vitest môi trường node thuần.
 *
 * Tên event giữ dạng Pi: agent_start / turn_* / message_* / tool_execution_*.
 * Khác biệt so với ticket gốc (đã đối chiếu source Pi thật):
 * - `turn_start` không mang số turn (số turn nằm trong event).
 * - `tool_execution_*` dùng `toolName` (không phải `name`).
 * - `message_update` mang `delta: string` (text delta thuần).
 */

export type AgentRole = 'user' | 'assistant' | 'toolResult';

export interface AgentToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface AgentToolResult {
  toolCallId: string;
  name: string;
  /** Payload thô của tool (string / object… do adapter quy định). */
  content: unknown;
  isError: boolean;
  /** Ghi chú từ hook (beforeToolCall block, afterToolCall details…). */
  details?: Record<string, unknown>;
}

/** Cấu trúc tối thiểu P2.2 cần — điền ở adapter, loop chỉ mang theo. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** USD — adapter tính từ catalog giá (P2.3), loop không tự tính. */
  cost?: number;
}

export interface AgentMessage {
  id: string;
  role: AgentRole;
  /** Assistant/toolResult: văn bản; toolResult là bản string hoá content. */
  content: string;
  /** Assistant: các tool call model vừa sinh, đúng thứ tự gọi. */
  toolCalls?: AgentToolCall[];
  /** Bắt buộc khi role === 'toolResult'. */
  toolResult?: AgentToolResult;
  /** Assistant: usage của lần gọi model sinh ra message này (P2.2). */
  usage?: AgentUsage;
}

export interface AgentContext {
  messages: readonly AgentMessage[];
  /** Tổng tool call đã thực thi (kể cả các call của turn hiện tại). */
  toolCallsSoFar: number;
  signal: AbortSignal;
}

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'turn_start'; turn: number }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage; delta: string }
  | { type: 'message_end'; message: AgentMessage }
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      partial: unknown;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: AgentToolResult;
      isError: boolean;
    }
  | { type: 'turn_end'; message: AgentMessage; toolResults: AgentToolResult[] }
  | {
      type: 'agent_end';
      messages: AgentMessage[];
      /** Lý do dừng — subscriber dùng để map status/finishReason khi persist. */
      stopReason?: AgentStopReason;
    };

/** Lý do loop dừng — trả về qua `return` của generator `agentLoop`. */
export type AgentStopReason =
  | 'completed'
  | 'no-tool-calls'
  | 'max-turns'
  | 'terminated'
  | 'budget-exhausted'
  | 'stopped'
  | 'aborted';

export interface AgentLoopResult {
  messages: AgentMessage[];
  /** Tổng call đã dùng: `usedBeforeRun` + call chạy trong loop này. */
  toolCallsUsed: number;
  stopReason: AgentStopReason;
}

export interface AgentStreamHelpers {
  signal: AbortSignal;
  /**
   * Streaming text — loop gom vào draft message và bắn `message_update`.
   * Adapter KHÔNG tự bắn event, chỉ gọi hàm này.
   */
  onDelta: (delta: string) => void;
}

/** Adapter gọi LLM: nhận context đã transform, trả message assistant đủ. */
export type AgentStreamFn = (
  context: AgentContext,
  helpers: AgentStreamHelpers,
) => Promise<AgentMessage>;

export type AgentExecuteFn = (
  call: AgentToolCall,
  helpers: {
    signal: AbortSignal;
    /** Báo tiến độ → `tool_execution_update` (nếu tool hỗ trợ). */
    report: (partial: unknown) => void;
  },
) => Promise<unknown>;

/** Trả về khi beforeToolCall muốn chặn call (auto-pilot deny, budget…). */
export interface ToolCallDecision {
  block: true;
  reason: string;
  /** true → gắn cờ terminate lên result bị block (bất biến #6 vẫn đúng:
   * loop chỉ dừng sớm khi MỌI result trong batch đều terminate). */
  terminate?: boolean;
}

/** Ghi đè sau khi tool chạy xong (merge chi tiết, yêu cầu dừng). */
export interface ToolOutcomePatch {
  terminate?: boolean;
  details?: Record<string, unknown>;
}

export interface AgentLoopConfig {
  initialMessages: readonly AgentMessage[];
  streamFn: AgentStreamFn;
  /** Không có → mọi tool call trả lỗi "không có executor". */
  executeTool?: AgentExecuteFn;
  /** 'parallel' mặc định; 'sequential' ép MỌI batch chạy tuần tự. */
  toolExecution?: 'parallel' | 'sequential';
  /** Map tên tool → mode; mặc định `getToolExecutionMode` (tool-batch.ts). */
  executionModeOf?: (toolName: string) => 'parallel' | 'sequential';
  /** Trần số lượt gọi model. Mặc định 24. */
  maxTurns?: number;
  /**
   * Ngân sách tool call (thay logic trần 32 call rải rác trong route cũ).
   * `usedBeforeRun`: số call đã dùng trước loop này (đếm theo hội thoại —
   * state ngoài nằm ở caller, loop chỉ cộng dồn).
   */
  toolBudget?: { maxCalls: number; usedBeforeRun?: number };
  /** Điểm chặn duy nhất trước khi tool chạy (auto-pilot policy nằm đây). */
  beforeToolCall?: (a: {
    toolCall: AgentToolCall;
    context: AgentContext;
  }) => Promise<ToolCallDecision | undefined>;
  /** Sau khi tool chạy xong (merge details, terminate…). */
  afterToolCall?: (a: {
    toolCall: AgentToolCall;
    result: unknown;
    isError: boolean;
  }) => Promise<ToolOutcomePatch | undefined>;
  /** Điểm cắm sau mỗi turn (goal-loop marker, compaction trigger…). */
  shouldStopAfterTurn?: (a: { context: AgentContext }, signal: AbortSignal) => Promise<boolean>;
  /** Biến đổi context trước mỗi lần gọi model (compaction nằm đây). */
  transformContext?: (
    msgs: readonly AgentMessage[],
    signal: AbortSignal,
  ) => Promise<readonly AgentMessage[]>;
  signal?: AbortSignal;
}