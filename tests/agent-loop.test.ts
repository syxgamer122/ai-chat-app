/**
 * P1.1 — Test agent loop thuần (vitest node, không jsdom/DOM).
 * streamFn/executeTool đều fake — assert thứ tự event + bất biến loop.
 */
import { describe, expect, it } from 'vitest';
import {
  agentLoop,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentExecuteFn,
  type AgentMessage,
  type AgentStreamFn,
} from '@/lib/agent/loop';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const USER: AgentMessage = { id: 'u1', role: 'user', content: 'Làm giúp' };

/** Chạy loop gom hết event + kết quả return. */
async function run(config: Partial<AgentLoopConfig> & { streamFn: AgentStreamFn }) {
  const events: AgentEvent[] = [];
  const gen = agentLoop({ initialMessages: [USER], ...config });
  for (;;) {
    const item = await gen.next();
    if (item.done) return { events, result: item.value };
    events.push(item.value);
  }
}

/** streamFn kịch bản theo số lần gọi. */
function scriptedStreamFn(script: Array<() => AgentMessage>): AgentStreamFn {
  let call = 0;
  return async (_context, helpers) => {
    const message = script[Math.min(call, script.length - 1)]();
    call++;
    if (message.content) helpers.onDelta(message.content);
    return message;
  };
}

describe('agentLoop — thứ tự event', () => {
  it('text thuần: agent_start → turn_start → message_* → turn_end → agent_end', async () => {
    const { events, result } = await run({
      streamFn: scriptedStreamFn([() => ({ id: 'a1', role: 'assistant', content: 'Xin chào' })]),
    });
    expect(events.map((e) => e.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(result.stopReason).toBe('no-tool-calls');
    expect(result.toolCallsUsed).toBe(0);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const turnEnd = events.find((e) => e.type === 'turn_end') as Extract<
      AgentEvent,
      { type: 'turn_end' }
    >;
    expect(turnEnd.toolResults).toEqual([]);
  });

  it('streaming delta gom thành message + bắn message_update', async () => {
    const { events } = await run({
      streamFn: async (_c, { onDelta }) => {
        onDelta('Xin ');
        onDelta('chào');
        return { id: 'a1', role: 'assistant', content: 'Xin chào' };
      },
    });
    const updates = events.filter((e) => e.type === 'message_update') as Array<
      Extract<AgentEvent, { type: 'message_update' }>
    >;
    expect(updates.map((u) => u.delta)).toEqual(['Xin ', 'chào']);
    const end = events.find((e) => e.type === 'message_end') as Extract<
      AgentEvent,
      { type: 'message_end' }
    >;
    expect(end.message.content).toBe('Xin chào');
  });
});

describe('agentLoop — tool + song song (P2.1 kế thừa)', () => {
  it('2 fs_read delay ngược: end theo thứ tự HOÀN THÀNH, transcript theo thứ tự GỌI', async () => {
    const { events, result } = await run({
      streamFn: scriptedStreamFn([
        () => ({
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 't1', name: 'fs_read', args: { slow: true } },
            { id: 't2', name: 'fs_read', args: { slow: false } },
          ],
        }),
        () => ({ id: 'a2', role: 'assistant', content: 'Xong' }),
      ]),
      executeTool: async (call) => {
        await sleep((call.args as { slow?: boolean }).slow ? 120 : 30);
        return `kq-${call.id}`;
      },
    });

    const types = events.map((e) => e.type);
    // start cả hai trước (preflight) — end t2 (30ms) trước end t1 (120ms).
    const startT1 = types.indexOf('tool_execution_start');
    const startT2 = types.lastIndexOf('tool_execution_start');
    expect(startT1).toBeGreaterThanOrEqual(0);
    expect(startT2).toBeGreaterThan(startT1);
    expect(types.indexOf('tool_execution_end', startT2)).toBeLessThan(
      types.lastIndexOf('tool_execution_end'),
    );

    // Transcript: toolResult t1 TRƯỚC t2 dù t2 xong trước (bất biến #1).
    const results = result.messages.filter((m) => m.role === 'toolResult');
    expect(results.map((m) => m.toolResult?.toolCallId)).toEqual(['t1', 't2']);
    expect(results[0].content).toBe('kq-t1');
    expect(result.stopReason).toBe('no-tool-calls');
    expect(result.toolCallsUsed).toBe(2);
  });

  it('beforeToolCall block → tool không chạy, transcript có result lỗi, loop tiếp tục', async () => {
    let executed = 0;
    const { result } = await run({
      streamFn: scriptedStreamFn([
        () => ({
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'fs_write', args: {} }],
        }),
        () => ({ id: 'a2', role: 'assistant', content: 'Đã chặn' }),
      ]),
      executeTool: async () => {
        executed++;
        return 'không được chạy';
      },
      beforeToolCall: async () => ({ block: true, reason: 'Auto-pilot: fs_write cần duyệt' }),
    });
    expect(executed).toBe(0);
    const tr = result.messages.find((m) => m.role === 'toolResult');
    expect(tr?.toolResult?.isError).toBe(true);
    expect(tr?.toolResult?.content).toBe('Auto-pilot: fs_write cần duyệt');
    expect(result.stopReason).toBe('no-tool-calls');
  });

  it('bất biến #6: MỌI result terminate → dừng sớm; trộn terminate → tiếp tục', async () => {
    let streamCalls = 0;
    const toolAssistant: AgentMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 't1', name: 'fs_read', args: {} },
        { id: 't2', name: 'fs_read', args: {} },
      ],
    };
    const mkStream = (): AgentStreamFn => async () => {
      streamCalls++;
      if (streamCalls === 1) return toolAssistant;
      return { id: `a${streamCalls}`, role: 'assistant', content: 'Tiếp' };
    };
    const executeTool: AgentExecuteFn = async (call) => `kq-${call.id}`;

    // Cả hai terminate → streamFn chỉ gọi 1 lần.
    const all = await run({ streamFn: mkStream(), executeTool, afterToolCall: async () => ({ terminate: true }) });
    expect(streamCalls).toBe(1);
    expect(all.result.stopReason).toBe('terminated');

    // Trộn: chỉ t1 terminate → vẫn gọi streamFn lần 2 (bất biến #6).
    streamCalls = 0;
    const mixed = await run({
      streamFn: mkStream(),
      executeTool,
      afterToolCall: async ({ toolCall }) => (toolCall.id === 't1' ? { terminate: true } : undefined),
    });
    expect(streamCalls).toBe(2);
    expect(mixed.result.stopReason).toBe('no-tool-calls');
  });

  it('afterToolCall merge details vào result + event end', async () => {
    const { events } = await run({
      streamFn: scriptedStreamFn([
        () => ({
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'web_search', args: {} }],
        }),
        () => ({ id: 'a2', role: 'assistant', content: 'ok' }),
      ]),
      executeTool: async () => 'kết quả',
      afterToolCall: async () => ({ details: { usageNote: 'đã log' } }),
    });
    const end = events.filter((e) => e.type === 'tool_execution_end').pop() as Extract<
      AgentEvent,
      { type: 'tool_execution_end' }
    >;
    expect(end.result.details).toEqual({ usageNote: 'đã log' });
    expect(end.isError).toBe(false);
  });

  it('tool_execution_update bắn khi report tiến độ', async () => {
    const { events } = await run({
      streamFn: scriptedStreamFn([
        () => ({
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'shell_run', args: {} }],
        }),
        () => ({ id: 'a2', role: 'assistant', content: 'ok' }),
      ]),
      executeTool: async (_call, { report }) => {
        report({ line: '50%' });
        return 'xong';
      },
    });
    const update = events.find((e) => e.type === 'tool_execution_update') as Extract<
      AgentEvent,
      { type: 'tool_execution_update' }
    >;
    expect(update.partial).toEqual({ line: '50%' });
    expect(update.toolCallId).toBe('t1');
  });

  it('tool sequential (fs_write) ép cả batch tuần tự', async () => {
    let running = 0;
    let overlap = false;
    const { result } = await run({
      streamFn: scriptedStreamFn([
        () => ({
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'w1', name: 'fs_write', args: {} },
            { id: 'w2', name: 'fs_write', args: {} },
          ],
        }),
        () => ({ id: 'a2', role: 'assistant', content: 'ok' }),
      ]),
      executeTool: async () => {
        running++;
        if (running > 1) overlap = true;
        await sleep(20);
        running--;
        return 'ghi';
      },
    });
    expect(overlap).toBe(false);
    expect(result.toolCallsUsed).toBe(2);
  });
});

describe('agentLoop — điểm dừng', () => {
  it('transformContext biến đổi context trước khi gọi model', async () => {
    const seen: number[] = [];
    await run({
      streamFn: async (context) => {
        seen.push(context.messages.length);
        return { id: 'a1', role: 'assistant', content: 'ok' };
      },
      transformContext: async (msgs) => [...msgs, { id: 'sys', role: 'user', content: '(nén)' }],
    });
    expect(seen).toEqual([2]);
  });

  it('shouldStopAfterTurn true → dừng với stopReason "stopped"', async () => {
    const { result } = await run({
      streamFn: scriptedStreamFn([
        () => ({
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'fs_read', args: {} }],
        }),
      ]),
      executeTool: async () => 'kq',
      shouldStopAfterTurn: async () => true,
    });
    expect(result.stopReason).toBe('stopped');
    expect(result.messages.filter((m) => m.role === 'toolResult')).toHaveLength(1);
  });

  it('toolBudget: call vượt trần bị block, hết ngân sách → budget-exhausted', async () => {
    const executed: string[] = [];
    const { result } = await run({
      streamFn: scriptedStreamFn([
        () => ({
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 't1', name: 'fs_read', args: {} },
            { id: 't2', name: 'fs_read', args: {} },
            { id: 't3', name: 'fs_read', args: {} },
          ],
        }),
        () => ({
          id: 'a2',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't4', name: 'fs_read', args: {} }],
        }),
      ]),
      executeTool: async (call) => {
        executed.push(call.id);
        return `kq-${call.id}`;
      },
      toolBudget: { maxCalls: 2 },
    });
    expect(executed).toEqual(['t1', 't2']);
    const tr3 = result.messages.find((m) => m.id === 'toolresult-t3');
    expect(tr3?.toolResult?.isError).toBe(true);
    expect(String(tr3?.toolResult?.content)).toContain('ngân sách');
    expect(result.stopReason).toBe('budget-exhausted');
    expect(result.toolCallsUsed).toBe(3);
  });

  it('usedBeforeRun cộng dồn ngân sách theo hội thoại', async () => {
    const { result } = await run({
      streamFn: scriptedStreamFn([
        () => ({
          id: 'a1',
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'fs_read', args: {} }],
        }),
      ]),
      executeTool: async () => 'kq',
      toolBudget: { maxCalls: 3, usedBeforeRun: 3 },
    });
    const tr = result.messages.find((m) => m.role === 'toolResult');
    expect(tr?.toolResult?.isError).toBe(true);
    expect(result.stopReason).toBe('budget-exhausted');
    expect(result.toolCallsUsed).toBe(4);
  });

  it('maxTurns chặn vòng lặp vô hạn', async () => {
    let calls = 0;
    const { result } = await run({
      maxTurns: 3,
      streamFn: async () => {
        calls++;
        return {
          id: `a${calls}`,
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `t${calls}`, name: 'fs_read', args: {} }],
        };
      },
      executeTool: async () => 'kq',
    });
    expect(calls).toBe(3);
    expect(result.stopReason).toBe('max-turns');
  });

  it('abort trước khi chạy → stopReason "aborted", không gọi model', async () => {
    const controller = new AbortController();
    controller.abort();
    let modelCalled = 0;
    const { result } = await run({
      signal: controller.signal,
      streamFn: async () => {
        modelCalled++;
        return { id: 'a1', role: 'assistant', content: 'x' };
      },
    });
    expect(modelCalled).toBe(0);
    expect(result.stopReason).toBe('aborted');
  });

  it('streamFn ném lỗi → generator reject đúng chỗ', async () => {
    await expect(
      run({
        streamFn: async () => {
          throw new Error('upstream 500');
        },
      }),
    ).rejects.toThrow('upstream 500');
  });
});