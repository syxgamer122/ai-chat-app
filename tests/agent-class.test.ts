/** P1.2 — Test Agent class + event bus (vitest node). */
import { describe, expect, it } from 'vitest';
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentStreamFn,
} from '@/lib/agent/agent';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const textStream: AgentStreamFn = async (_ctx, { onDelta }) => {
  onDelta('ok');
  return { id: 'a1', role: 'assistant', content: 'ok' };
};

describe('Agent — event bus + barrier', () => {
  it('prompt append user, subscriber thấy state thật, await đúng thứ tự đăng ký', async () => {
    const agent = new Agent({ initialState: [], streamFn: textStream });
    const order: string[] = [];
    agent.subscribe((_e, { messages }) => {
      order.push(`first:${messages.length}`);
    });
    agent.subscribe((_e, { messages }) => {
      order.push(`second:${messages.length}`);
    });

    const result = await agent.prompt('hỏi');

    expect(result.stopReason).toBe('no-tool-calls');
    expect(agent.state.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(order.filter((o) => o.startsWith('first'))).toHaveLength(7); // đủ 7 event
    expect(order[0]).toBe('first:1'); // message_start: state đã có user
  });

  it('message_end là barrier: subscriber chưa xong → preflight chưa chạy', async () => {
    const gate = deferred<void>();
    let toolStarted = false;
    const agent = new Agent({
      initialState: [],
      streamFn: async () => ({
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'fs_read', args: {} }],
      }),
      executeTool: async () => {
        toolStarted = true;
        return 'kq';
      },
    });
    agent.subscribe(async (event) => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        await gate.promise;
      }
    });

    const run = agent.prompt('hỏi');
    await Promise.resolve();
    await Promise.resolve();
    expect(toolStarted).toBe(false);

    gate.resolve();
    await run;
    expect(toolStarted).toBe(true);
  });

  it('subscriber ném lỗi → lastError, isRunning về false, waitForIdle resolve', async () => {
    const agent = new Agent({
      initialState: [],
      streamFn: textStream,
    });
    agent.subscribe(() => {
      throw new Error('subscriber boom');
    });

    await expect(agent.prompt('hỏi')).rejects.toThrow('subscriber boom');
    expect(agent.lastError).toBeInstanceOf(Error);
    expect(agent.isRunning).toBe(false);
    await expect(agent.waitForIdle()).resolves.toBeUndefined();
  });
});

describe('Agent — prompt / continue / abort', () => {
  it('continue() chạy lại khi cuối là user hoặc toolResult; chặn khi cuối là assistant', async () => {
    let calls = 0;
    const mkStream = (): AgentStreamFn => async () => {
      calls++;
      return { id: `a${calls}`, role: 'assistant', content: 'ok' };
    };

    // Cuối là assistant → không được resend.
    const rejected = new Agent({ initialState: [], streamFn: mkStream() });
    await rejected.prompt('hỏi');
    await expect(rejected.continue()).rejects.toThrow('message cuối');

    // Cuối là toolResult (lỗi tool) → retry được.
    const toolResult: AgentMessage = {
      id: 'tr1',
      role: 'toolResult',
      content: 'lỗi',
      toolResult: {
        toolCallId: 't1',
        name: 'fs_read',
        content: 'lỗi',
        isError: true,
      },
    };
    const retried = new Agent({
      initialState: [{ id: 'u1', role: 'user', content: 'hỏi' }, toolResult],
      streamFn: mkStream(),
    });
    const result = await retried.continue();
    expect(result.stopReason).toBe('no-tool-calls');
    expect(calls).toBe(2);
  });

  it('abort() + waitForIdle: streamFn tôn trọng signal → stopReason "aborted"', async () => {
    const agent = new Agent({
      initialState: [],
      streamFn: async (_ctx, { signal }) => {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return { id: 'a1', role: 'assistant', content: 'x' };
      },
    });
    const run = agent.prompt('hỏi');
    await Promise.resolve();
    agent.abort();
    await expect(run).rejects.toThrow('aborted');
    await agent.waitForIdle();
    expect(agent.isRunning).toBe(false);
  });

  it('events phát ra subscriber đủ loại (text path)', async () => {
    const agent = new Agent({ initialState: [], streamFn: textStream });
    const types: AgentEvent['type'][] = [];
    agent.subscribe((event) => types.push(event.type));
    await agent.prompt('hỏi');
    expect(types).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
  });
});