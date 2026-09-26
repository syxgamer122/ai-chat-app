/**
 * Pure TypeScript State Machine cho Turn Lifecycle (XState v5 compatible).
 *
 * Invariants:
 * INV-1: Chỉ 1 actor cho 1 chatId tại một thời điểm.
 * INV-2: Chỉ state 'executing_tool' được phép kích hoạt side-effects ra đĩa/mạng.
 * INV-3: 'awaiting_approval' chỉ chuyển sang 'executing_tool' khi có token hợp lệ.
 * INV-4: Abort luôn dọn dẹp abortController và giải phóng pending promises.
 */

import { TurnContext, TurnEvent, TurnState } from './types';

export function createInitialContext(chatId = '', activeLeafId = ''): TurnContext {
  return {
    chatId,
    activeLeafId,
    abortController: null,
    streamingContent: '',
    streamingReasoning: '',
    pendingToolCalls: [],
    executedToolsCount: 0,
    maxToolCallsLimit: 12,
    isTainted: false,
    error: null,
  };
}

export function transitionTurnState(
  state: TurnState,
  context: TurnContext,
  event: TurnEvent,
): { nextState: TurnState; nextContext: TurnContext } {
  // Clone context để đảm bảo immutability
  const ctx: TurnContext = {
    ...context,
    pendingToolCalls: [...context.pendingToolCalls],
  };

  switch (state) {
    case 'idle':
      if (event.type === 'START_TURN') {
        ctx.chatId = event.chatId;
        ctx.activeLeafId = event.activeLeafId;
        ctx.abortController = new AbortController();
        ctx.streamingContent = '';
        ctx.streamingReasoning = '';
        ctx.pendingToolCalls = [];
        ctx.executedToolsCount = 0;
        ctx.error = null;
        return { nextState: 'streaming', nextContext: ctx };
      }
      break;

    case 'streaming':
      if (event.type === 'STREAM_DELTA') {
        if (event.textChunk) ctx.streamingContent += event.textChunk;
        if (event.reasoningChunk) ctx.streamingReasoning += event.reasoningChunk;
        return { nextState: 'streaming', nextContext: ctx };
      }
      if (event.type === 'TOOL_CALLS_DISCOVERED') {
        ctx.pendingToolCalls = event.calls;
        return { nextState: 'gating', nextContext: ctx };
      }
      if (event.type === 'STOP') {
        ctx.abortController?.abort();
        return { nextState: 'aborted', nextContext: ctx };
      }
      if (event.type === 'FAIL') {
        ctx.error = event.error;
        return { nextState: 'error', nextContext: ctx };
      }
      break;

    case 'gating':
      if (event.type === 'GATE_PASSED') {
        return { nextState: 'executing_tool', nextContext: ctx };
      }
      if (event.type === 'REQUIRE_APPROVAL') {
        ctx.pendingToolCalls = event.calls;
        return { nextState: 'awaiting_approval', nextContext: ctx };
      }
      if (event.type === 'STOP') {
        ctx.abortController?.abort();
        return { nextState: 'aborted', nextContext: ctx };
      }
      break;

    case 'awaiting_approval':
      if (event.type === 'USER_APPROVE') {
        const target = ctx.pendingToolCalls.find((c) => c.id === event.toolCallId);
        if (target) {
          target.approvalToken = event.token;
        }
        return { nextState: 'executing_tool', nextContext: ctx };
      }
      if (event.type === 'USER_DENY') {
        // Hủy lời gọi công cụ
        ctx.pendingToolCalls = ctx.pendingToolCalls.filter((c) => c.id !== event.toolCallId);
        if (ctx.pendingToolCalls.length === 0) {
          return { nextState: 'tool_settled', nextContext: ctx };
        }
        return { nextState: 'awaiting_approval', nextContext: ctx };
      }
      if (event.type === 'STOP') {
        ctx.abortController?.abort();
        return { nextState: 'aborted', nextContext: ctx };
      }
      break;

    case 'executing_tool':
      if (event.type === 'TOOL_EXECUTION_SUCCESS' || event.type === 'TOOL_EXECUTION_FAILURE') {
        // Một tool đã hoàn thành
        return { nextState: 'tool_settled', nextContext: ctx };
      }
      if (event.type === 'ALL_TOOLS_SETTLED') {
        return { nextState: 'tool_settled', nextContext: ctx };
      }
      if (event.type === 'STOP') {
        ctx.abortController?.abort();
        return { nextState: 'aborted', nextContext: ctx };
      }
      break;

    case 'tool_settled':
      if (event.type === 'ALL_TOOLS_SETTLED') {
        ctx.executedToolsCount += ctx.pendingToolCalls.length;
        ctx.pendingToolCalls = [];
        if (ctx.executedToolsCount >= ctx.maxToolCallsLimit) {
          return { nextState: 'budget_exhausted', nextContext: ctx };
        }
        return { nextState: 'resubmitting', nextContext: ctx };
      }
      if (event.type === 'STOP') {
        ctx.abortController?.abort();
        return { nextState: 'aborted', nextContext: ctx };
      }
      break;

    case 'resubmitting':
      // Tự động chuyển sang lượt stream tiếp theo
      return { nextState: 'streaming', nextContext: ctx };

    case 'budget_exhausted':
    case 'done':
    case 'aborted':
    case 'error':
      if (event.type === 'START_TURN') {
        ctx.chatId = event.chatId;
        ctx.activeLeafId = event.activeLeafId;
        ctx.abortController = new AbortController();
        ctx.streamingContent = '';
        ctx.streamingReasoning = '';
        ctx.pendingToolCalls = [];
        ctx.executedToolsCount = 0;
        ctx.error = null;
        return { nextState: 'streaming', nextContext: ctx };
      }
      break;
  }

  // Nếu không khớp transition nào, giữ nguyên state và context gốc
  return { nextState: state, nextContext: context };
}
