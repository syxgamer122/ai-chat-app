/**
 * Types & Event Signatures cho Core Agent Runtime (Tầng 1 - Zero React Dependencies).
 */

export type TurnState =
  | 'idle'
  | 'streaming'
  | 'gating'
  | 'awaiting_approval'
  | 'executing_tool'
  | 'tool_settled'
  | 'resubmitting'
  | 'budget_exhausted'
  | 'done'
  | 'aborted'
  | 'error';

export interface PendingToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  approvalToken?: string;
}

export interface TurnContext {
  chatId: string;
  activeLeafId: string;
  abortController: AbortController | null;
  streamingContent: string;
  streamingReasoning: string;
  pendingToolCalls: PendingToolCall[];
  executedToolsCount: number;
  maxToolCallsLimit: number;
  isTainted: boolean;
  error: Error | null;
}

export type TurnEvent =
  | { type: 'START_TURN'; chatId: string; activeLeafId: string }
  | { type: 'STREAM_DELTA'; textChunk?: string; reasoningChunk?: string }
  | { type: 'TOOL_CALLS_DISCOVERED'; calls: PendingToolCall[] }
  | { type: 'GATE_PASSED'; autoApprovedCalls?: string[] }
  | { type: 'REQUIRE_APPROVAL'; calls: PendingToolCall[] }
  | { type: 'USER_APPROVE'; toolCallId: string; token: string }
  | { type: 'USER_DENY'; toolCallId: string; reason?: string }
  | { type: 'TOOL_EXECUTION_SUCCESS'; toolCallId: string; result: unknown }
  | { type: 'TOOL_EXECUTION_FAILURE'; toolCallId: string; error: string }
  | { type: 'ALL_TOOLS_SETTLED' }
  | { type: 'STOP' }
  | { type: 'FAIL'; error: Error };
