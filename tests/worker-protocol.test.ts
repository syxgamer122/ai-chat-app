import { describe, it } from 'vitest';
import assert from 'node:assert';
import { handleWorkerRequest } from '../core/agent-runtime/worker';
import type { WorkerResponse } from '../core/agent-runtime/worker-protocol';

describe('Worker Protocol & RPC (Phase 5 M2)', () => {
  it('PING returns PONG with matching requestId', () => {
    let pongReceived: WorkerResponse | null = null;
    handleWorkerRequest({ id: 'req-ping-1', type: 'PING' }, (res) => {
      pongReceived = res;
    });
    assert.ok(pongReceived);
    assert.strictEqual((pongReceived as any).type, 'PONG');
    assert.strictEqual((pongReceived as any).id, 'req-ping-1');
  });

  it('SWITCH_CHAT initializes actor and reports idle state', () => {
    let stateReceived: WorkerResponse | null = null;
    handleWorkerRequest({ id: 'req-init', type: 'SWITCH_CHAT', chatId: 'worker-chat-1', activeLeafId: 'leaf-1' }, (res) => {
      stateReceived = res;
    });
    assert.ok(stateReceived);
    assert.strictEqual((stateReceived as any).type, 'STATE_CHANGED');
    assert.strictEqual((stateReceived as any).chatId, 'worker-chat-1');
    assert.strictEqual((stateReceived as any).state, 'idle');
  });

  it('START_TURN transitions actor to streaming state', () => {
    let startRes: WorkerResponse | null = null;
    handleWorkerRequest({ id: 'req-start', type: 'START_TURN', chatId: 'worker-chat-1', activeLeafId: 'leaf-1', input: 'Hello' }, (res) => {
      startRes = res;
    });
    assert.ok(startRes);
    assert.strictEqual((startRes as any).type, 'STATE_CHANGED');
    assert.strictEqual((startRes as any).chatId, 'worker-chat-1');
    assert.strictEqual((startRes as any).state, 'streaming');
  });

  it('STOP_TURN transitions actor to aborted state', () => {
    let abortRes: WorkerResponse | null = null;
    handleWorkerRequest({ id: 'req-abort', type: 'STOP_TURN', chatId: 'worker-chat-1' }, (res) => {
      abortRes = res;
    });
    assert.ok(abortRes);
    assert.strictEqual((abortRes as any).type, 'STATE_CHANGED');
    assert.strictEqual((abortRes as any).chatId, 'worker-chat-1');
    assert.strictEqual((abortRes as any).state, 'aborted');
  });
});
