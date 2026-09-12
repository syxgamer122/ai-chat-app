/** P1.2 — Test persistence subscriber (mock Dexie, node thuần). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentMessage } from '@/lib/agent/types';
import { createPersistenceSubscriber } from '@/lib/agent/persistence-subscriber';

const { appendMessage, getMock } = vi.hoisted(() => ({
  appendMessage: vi.fn(),
  getMock: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  ROOT_KEY: '__ROOT__',
  appendMessage,
  db: { messages: { get: getMock } },
}));

const assistantWithTool: AgentMessage = {
  id: 'a1',
  role: 'assistant',
  content: 'đang làm',
  toolCalls: [{ id: 't1', name: 'fs_read', args: { path: 'README.md' } }],
};
const toolResult: AgentMessage = {
  id: 'toolresult-t1',
  role: 'toolResult',
  content: 'nội dung file',
  toolResult: {
    toolCallId: 't1',
    name: 'fs_read',
    content: 'nội dung file',
    isError: false,
  },
};
const user: AgentMessage = { id: 'u1', role: 'user', content: 'đọc file' };

const endEvent = (
  messages: AgentMessage[],
  stopReason?: 'aborted',
): Extract<AgentEvent, { type: 'agent_end' }> => ({
  type: 'agent_end',
  messages,
  ...(stopReason ? { stopReason } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockResolvedValue(null);
});

describe('createPersistenceSubscriber', () => {
  it('persist user + assistant qua appendMessage, fold toolResult vào toolInvocations', async () => {
    const sub = createPersistenceSubscriber({ chatId: 'c1' });
    await sub(endEvent([user, assistantWithTool, toolResult]));

    expect(appendMessage).toHaveBeenCalledTimes(2);
    const [userCall, assistantCall] = appendMessage.mock.calls;
    expect(userCall[0]).toMatchObject({
      id: 'u1',
      chatId: 'c1',
      role: 'user',
      parentId: '__ROOT__',
      status: 'complete',
      finishReason: 'stop',
    });
    expect(assistantCall[0]).toMatchObject({
      id: 'a1',
      role: 'assistant',
      parentId: 'u1',
      status: 'complete',
    });
    expect(assistantCall[0].toolInvocations).toEqual([
      {
        toolCallId: 't1',
        toolName: 'fs_read',
        args: { path: 'README.md' },
        state: 'call-result',
        result: 'nội dung file',
      },
    ]);
  });

  it('idempotent: gọi 2 lần + DB đã có row → không chèn trùng', async () => {
    const sub = createPersistenceSubscriber({ chatId: 'c1' });
    await sub(endEvent([user, assistantWithTool]));
    await sub(endEvent([user, assistantWithTool]));
    expect(appendMessage).toHaveBeenCalledTimes(2);

    getMock.mockResolvedValue({ id: 'u1' });
    await sub(endEvent([user]));
    expect(appendMessage).toHaveBeenCalledTimes(2);
  });

  it('lỗi persist không làm fail turn (gọi onError)', async () => {
    const onError = vi.fn();
    appendMessage.mockRejectedValueOnce(new Error('IDB failed'));
    const sub = createPersistenceSubscriber({ chatId: 'c1', onError });
    await sub(endEvent([user], 'aborted'));
    expect(onError).toHaveBeenCalled();
  });

  it('abort map sang status/finishReason đúng', async () => {
    const sub = createPersistenceSubscriber({ chatId: 'c1' });
    await sub(endEvent([user], 'aborted'));
    expect(appendMessage.mock.calls[0][0]).toMatchObject({
      status: 'aborted',
      finishReason: 'abort',
    });
  });
});