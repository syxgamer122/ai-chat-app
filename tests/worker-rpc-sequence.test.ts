/**
 * tests/worker-rpc-sequence.test.ts
 *
 * Kiểm tra Epoch-Tagged RPC Messages (turnSeq) & TURN_ABORTED_ACK (Sprint 6.1).
 * Đảm bảo loại bỏ hoàn toàn hiện tượng kẹt hàng đợi Worker RPC và desync khi Stop/Resubmit.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { handleWorkerRequest } from '../core/agent-runtime/worker';
import { sqliteStorageEngine } from '../core/storage/sqlite-driver';
import type { WorkerResponse } from '../core/agent-runtime/worker-protocol';

describe('=== RUNNING WORKER RPC SEQUENCE & ABORT ACK TESTS (PHASE 6 SPRINT 6.1) ===', () => {
  it('1. MOUNT_DB and UNMOUNT_DB lifecycle', () => {
    const responses: WorkerResponse[] = [];
    const mockPost = (r: WorkerResponse) => responses.push(r);

    handleWorkerRequest({ id: 'req-1', type: 'MOUNT_DB', chatId: 'chat-test' }, mockPost);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].type, 'DB_MOUNTED');
    assert.equal(sqliteStorageEngine.isDatabaseOpen(), true);

    handleWorkerRequest({ id: 'req-2', type: 'UNMOUNT_DB', chatId: 'chat-test' }, mockPost);
    assert.equal(responses.length, 2);
    assert.equal(responses[1].type, 'DB_UNMOUNTED');
    assert.equal(sqliteStorageEngine.isDatabaseOpen(), false);
  });

  it('2. START_TURN tags response with matching turnSeq', () => {
    const responses: WorkerResponse[] = [];
    const mockPost = (r: WorkerResponse) => responses.push(r);

    handleWorkerRequest(
      {
        id: 'start-1',
        type: 'START_TURN',
        chatId: 'chat-seq-1',
        activeLeafId: 'leaf-1',
        input: 'Hello',
        turnSeq: 10,
      },
      mockPost
    );

    assert.equal(responses.length, 1);
    assert.equal(responses[0].type, 'STATE_CHANGED');
    assert.equal(responses[0].turnSeq, 10);
  });

  it('3. Stale START_TURN with smaller turnSeq is completely ignored', () => {
    const responses: WorkerResponse[] = [];
    const mockPost = (r: WorkerResponse) => responses.push(r);

    // Turn 15 đã được xử lý
    handleWorkerRequest(
      {
        id: 'start-15',
        type: 'START_TURN',
        chatId: 'chat-seq-2',
        activeLeafId: 'leaf-1',
        input: 'Turn 15',
        turnSeq: 15,
      },
      mockPost
    );
    assert.equal(responses.length, 1);

    // Message cũ turn 12 bị kẹt microtask queue tới muộn
    handleWorkerRequest(
      {
        id: 'start-12',
        type: 'START_TURN',
        chatId: 'chat-seq-2',
        activeLeafId: 'leaf-1',
        input: 'Turn 12 (Stale)',
        turnSeq: 12,
      },
      mockPost
    );

    // Không sinh thêm response nào do đã bị drop
    assert.equal(responses.length, 1);
  });

  it('4. STOP_TURN responds with explicit TURN_ABORTED_ACK', () => {
    const responses: WorkerResponse[] = [];
    const mockPost = (r: WorkerResponse) => responses.push(r);

    handleWorkerRequest(
      {
        id: 'stop-1',
        type: 'STOP_TURN',
        chatId: 'chat-seq-1',
        turnSeq: 10,
      },
      mockPost
    );

    const abortAck = responses.find((r) => r.type === 'TURN_ABORTED_ACK');
    assert.ok(abortAck, 'Phải có phản hồi TURN_ABORTED_ACK');
    assert.equal(abortAck?.turnSeq, 10);
    assert.equal(abortAck?.chatId, 'chat-seq-1');
  });
});
