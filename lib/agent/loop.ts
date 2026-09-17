/**
 * P1.1 — Agent loop thuần (kiến trúc agent loop nội bộ).
 *
 * Async generator KHÔNG biết gì về React / Next / DOM / AI SDK:
 * - Gọi model qua `streamFn` inject; thực thi tool qua `executeTool` inject.
 * - Tool chạy song song qua `executeToolBatch` (P2.1) — giữ nguyên 2 bất biến:
 *   (1) `tool_execution_end` bắn theo thứ tự HOÀN THÀNH;
 *   (2) message `toolResult` ghi vào transcript theo thứ tự assistant GỌI.
 * - Auto-pilot policy → `beforeToolCall`; merge/log → `afterToolCall`;
 *   goal-loop → `shouldStopAfterTurn`; compaction → `transformContext`;
 *   trần 32 call → `toolBudget`. Loop không import agent-tools/auto-pilot.
 *
 * Bất biến #6: loop chỉ dừng sớm khi MỌI tool result trong batch đều
 * `terminate: true` (kể cả result bị block ở preflight).
 */

import {
  executeToolBatch,
  getToolExecutionMode,
  type ToolBatchItem,
} from '../tool-batch';
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentLoopResult,
  AgentMessage,
  AgentToolCall,
  AgentToolResult,
  ToolCallDecision,
} from './types';
/* P0 #4: kết quả tool là đường vào ngữ cảnh model — che bí mật tại đây.
   Registry là module thuần (không React/Next/DOM) nên loop vẫn framework-free. */
import { redactSecretsDeep } from '@/lib/secret-registry';

export * from './types';

const DEFAULT_MAX_TURNS = 24;

/* ------------------------------------------------------------------ */
/* Hàng đợi event bất đồng bộ                                          */
/* ------------------------------------------------------------------ */

/**
 * Producer (vòng loop) push event; consumer (generator) yield tuần tự.
 * Bắt buộc vì bên trong `Promise.all` không yield được — đây là cách agent loop giữ
 * `tool_execution_end` bắn theo thứ tự hoàn thành trong khi transcript vẫn
 * theo thứ tự source.
 */
class AsyncQueue<T> {
  private buffer: Array<{ value: T; consumed: Promise<void>; resolveConsumed: () => void }> = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  private failure: { error: unknown } | null = null;
  private lastReturned: { resolveConsumed: () => void } | null = null;

  push(item: T): Promise<void> {
    if (this.closed) return Promise.resolve();

    let resolveConsumed!: () => void;
    const consumed = new Promise<void>((resolve) => {
      resolveConsumed = resolve;
    });
    const entry = { value: item, consumed, resolveConsumed };

    const waiter = this.waiters.shift();
    if (waiter) {
      // Event được giao ngay cho một consumer đang chờ. Promise chỉ được
      // resolve khi consumer gọi next() lần kế tiếp, tức là đã xử lý xong
      // subscriber của event hiện tại.
      this.lastReturned = entry;
      waiter({ value: item, done: false });
    } else {
      this.buffer.push(entry);
    }
    return consumed;
  }

  close(): void {
    this.closed = true;
    this.resolvePending();
    this.flush();
  }

  fail(error: unknown): void {
    this.failure = { error };
    this.closed = true;
    this.resolvePending();
    this.flush();
  }

  private resolveLastReturned(): void {
    if (!this.lastReturned) return;
    const returned = this.lastReturned;
    this.lastReturned = null;
    returned.resolveConsumed();
  }

  /** Giải phóng MỌI promise còn treo — nếu không, producer await queue.push
   *  sẽ treo vĩnh viễn khi consumer thoát sớm hoặc loop gặp lỗi. */
  private resolvePending(): void {
    this.resolveLastReturned();
    for (const entry of this.buffer) entry.resolveConsumed();
    this.buffer = [];
  }

  private flush(): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    // Consumer vừa gọi next() sau khi xử lý event trước, nên producer có thể
    // tiếp tục qua barrier của event đó.
    this.resolveLastReturned();

    if (this.buffer.length > 0) {
      const entry = this.buffer.shift()!;
      this.lastReturned = entry;
      return Promise.resolve({ value: entry.value, done: false });
    }
    if (this.failure) return Promise.reject(this.failure.error);
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve, reject) => {
      this.waiters.push((result) => {
        if (this.failure) reject(this.failure.error);
        else resolve(result);
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* agentLoop — async generator chính                                   */
/* ------------------------------------------------------------------ */

export async function* agentLoop(
  config: AgentLoopConfig,
): AsyncGenerator<AgentEvent, AgentLoopResult, void> {
  const queue = new AsyncQueue<AgentEvent>();
  let finalResult: AgentLoopResult = {
    messages: [...config.initialMessages],
    toolCallsUsed: config.toolBudget?.usedBeforeRun ?? 0,
    stopReason: 'completed',
  };

  const task = runLoop(config, queue, (r) => {
    finalResult = r;
  }).then(
    () => queue.close(),
    (error: unknown) => queue.fail(error),
  );
  // Consumer có thể bỏ giữa chừng (return sớm) — nuốt rejection để không
  // thành unhandled; luồng đi đủ sẽ `await task` và rethrow đúng chỗ.
  void task.catch(() => {});

  try {
    for (;;) {
      const item = await queue.next();
      if (item.done) break;
      yield item.value;
    }
  } finally {
    /* Consumer thoát sớm → chặn producer treo; task tự hoàn tất. */
    queue.close();
  }

  await task;
  return finalResult;
}

async function runLoop(
  config: AgentLoopConfig,
  queue: AsyncQueue<AgentEvent>,
  setFinal: (result: AgentLoopResult) => void,
): Promise<void> {
  const signal = config.signal ?? new AbortController().signal;
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const usedBeforeRun = config.toolBudget?.usedBeforeRun ?? 0;
  // Dùng CHUNG tham chiếu với Agent state: subscriber nhận event + đọc state
  // là cùng một mảng (bất biến "message_end là barrier trước preflight").
  // TransformContext trả array mới chỉ để gửi model, transcript gốc giữ nguyên.
  const messages: AgentMessage[] = config.initialMessages as AgentMessage[];
  let toolCallsUsed = 0;
  let stopReason: AgentLoopResult['stopReason'] = 'completed';

  const contextOf = (): AgentContext => ({
    messages,
    toolCallsSoFar: usedBeforeRun + toolCallsUsed,
    signal,
  });

  const stringifyContent = (content: unknown): string =>
    typeof content === 'string' ? content : JSON.stringify(content ?? null);

  await queue.push({ type: 'agent_start' });

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal.aborted) {
      stopReason = 'aborted';
      break;
    }
    await queue.push({ type: 'turn_start', turn });

    const contextForModel = config.transformContext
      ? [...(await config.transformContext(messages, signal))]
      : messages;

    /* ---- Lượt gọi model (streamFn inject) ---- */
    const draft: AgentMessage = { id: `assistant-turn-${turn}`, role: 'assistant', content: '' };
    await queue.push({ type: 'message_start', message: { ...draft } });
    const streamed = await config.streamFn(
      { messages: contextForModel, toolCallsSoFar: usedBeforeRun + toolCallsUsed, signal },
      {
        signal,
        onDelta: (delta) => {
          draft.content += delta;
          void queue.push({ type: 'message_update', message: { ...draft }, delta });
        },
      },
    );
    const assistant: AgentMessage = { ...streamed, role: 'assistant' };
    messages.push(assistant);
    /* Barrier thật sự: producer dừng ở đây tới khi mọi subscriber xử lý xong
       message_end (Agent class)` — beforeToolCall/preflight chạy sau đó mới
       thấy state đã có assistant. */
    await queue.push({ type: 'message_end', message: assistant });

    const calls: AgentToolCall[] = assistant.toolCalls ?? [];
    if (calls.length === 0) {
      await queue.push({ type: 'turn_end', message: assistant, toolResults: [] });
      stopReason = 'no-tool-calls';
      break;
    }

    /* ---- Preflight TUẦN TỰ: budget + beforeToolCall (auto-pilot) ---- */
    const budget = config.toolBudget;
    const remaining = budget
      ? Math.max(0, budget.maxCalls - usedBeforeRun - toolCallsUsed)
      : Number.POSITIVE_INFINITY;
    const decisions: Array<ToolCallDecision | undefined> = [];
    for (let i = 0; i < calls.length; i++) {
      if (i >= remaining) {
        decisions.push({
          block: true,
          reason: `Đã hết ngân sách tool (${budget!.maxCalls} call).`,
          terminate: false,
        });
        continue;
      }
      const decision = config.beforeToolCall
        ? await config.beforeToolCall({ toolCall: calls[i], context: contextOf() })
        : undefined;
      decisions.push(decision);
    }

    /* ---- tool_execution_start cho TẤT CẢ call, đúng thứ tự source ---- */
    const toolResults: Array<AgentToolResult | undefined> = new Array(calls.length);
    const terminateFlags = new Map<string, boolean>();
    const executedIndices: number[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      await queue.push({
        type: 'tool_execution_start',
        toolCallId: call.id,
        toolName: call.name,
        args: call.args,
      });
      const decision = decisions[i];
      if (decision?.block) {
        const result: AgentToolResult = {
          toolCallId: call.id,
          name: call.name,
          content: decision.reason,
          isError: true,
          details: { blocked: true, terminate: decision.terminate ?? false },
        };
        toolResults[i] = result;
        terminateFlags.set(call.id, decision.terminate ?? false);
        await queue.push({
          type: 'tool_execution_end',
          toolCallId: call.id,
          toolName: call.name,
          result,
          isError: true,
        });
      } else {
        executedIndices.push(i);
      }
    }

    /* ---- Thực thi batch (P2.1): song song trừ khi có tool sequential ---- */
    if (executedIndices.length > 0) {
      if (!config.executeTool) {
        for (const i of executedIndices) {
          const call = calls[i];
          const result: AgentToolResult = {
            toolCallId: call.id,
            name: call.name,
            content: `Không có executor cho tool "${call.name}".`,
            isError: true,
          };
          toolResults[i] = result;
          await queue.push({
            type: 'tool_execution_end',
            toolCallId: call.id,
            toolName: call.name,
            result,
            isError: true,
          });
        }
      } else {
        const indexOfCall = new Map<string, number>();
        for (const i of executedIndices) indexOfCall.set(calls[i].id, i);
        const items: ToolBatchItem[] = executedIndices.map((i) => ({
          id: calls[i].id,
          name: calls[i].name,
          args: calls[i].args,
        }));
        await executeToolBatch(items, {
          modeOf:
            config.toolExecution === 'sequential'
              ? () => 'sequential'
              : (config.executionModeOf ?? getToolExecutionMode),
          execute: async (item) => {
            const call = calls[indexOfCall.get(item.id)!];
            return config.executeTool!(call, {
              signal,
              report: (partial) => {
                void queue.push({
                  type: 'tool_execution_update',
                  toolCallId: call.id,
                  toolName: call.name,
                  partial,
                });
              },
            });
          },
          onSettled: async (item, outcome) => {
            const patch = config.afterToolCall
              ? await config.afterToolCall({
                  toolCall: { id: item.id, name: item.name, args: item.args },
                  result: outcome.result,
                  isError: !outcome.ok,
                })
              : undefined;
            /* P0 #4: transcript/event/DB chỉ nhận bản ĐÃ CHE; `afterToolCall`
               (policy của auto-pilot) vẫn thấy kết quả thô ở trên vì nó quyết
               định bằng nội dung, không phải bằng thứ đưa cho model đọc. */
            const result: AgentToolResult = {
              toolCallId: item.id,
              name: item.name,
              content: redactSecretsDeep(outcome.result),
              isError: !outcome.ok,
              details: patch?.details,
            };
            toolResults[indexOfCall.get(item.id)!] = result;
            terminateFlags.set(item.id, patch?.terminate === true);
            await queue.push({
              type: 'tool_execution_end',
              toolCallId: item.id,
              toolName: item.name,
              result,
              isError: !outcome.ok,
            });
          },
        });
      }
    }

    /* ---- Ghi toolResult vào transcript theo THỨ TỰ GỌI (bất biến #1) ---- */
    const settledResults: AgentToolResult[] = [];
    for (let i = 0; i < calls.length; i++) {
      const result = toolResults[i];
      if (!result) continue;
      settledResults.push(result);
      messages.push({
        id: `toolresult-${result.toolCallId}`,
        role: 'toolResult',
        content: stringifyContent(result.content),
        toolResult: result,
      });
    }

    await queue.push({ type: 'turn_end', message: assistant, toolResults: settledResults });
    toolCallsUsed += calls.length;

    /* ---- Bất biến #6: chỉ dừng sớm khi MỌI result terminate ---- */
    if (
      settledResults.length > 0 &&
      settledResults.every((r) => terminateFlags.get(r.toolCallId) === true)
    ) {
      stopReason = 'terminated';
      break;
    }
    if (budget && usedBeforeRun + toolCallsUsed >= budget.maxCalls) {
      stopReason = 'budget-exhausted';
      break;
    }
    if (config.shouldStopAfterTurn) {
      const shouldStop = await config.shouldStopAfterTurn({ context: contextOf() }, signal);
      if (shouldStop) {
        stopReason = 'stopped';
        break;
      }
    }
  }

  if (stopReason === 'completed') stopReason = 'max-turns';
  setFinal({ messages: [...messages], toolCallsUsed: usedBeforeRun + toolCallsUsed, stopReason });
  await queue.push({ type: 'agent_end', messages: [...messages], stopReason });
}