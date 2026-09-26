/**
 * tests/fencing-atomic-transaction.test.ts
 *
 * Kiểm tra Atomic Fenced SQL Transaction & Standby OPFS Mode (Sprint 6.1).
 * Đảm bảo loại bỏ hoàn toàn Async IO Fencing Window và NoModificationAllowedError.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { SqliteStorageEngine } from '../core/storage/sqlite-driver';
import { FencingConflictError } from '../core/agent-runtime/fencing';

describe('=== RUNNING ATOMIC FENCED TRANSACTION TESTS (PHASE 6 SPRINT 6.1) ===', () => {
  it('1. Standby OPFS Gate: openDatabase and closeDatabase', async () => {
    const engine = new SqliteStorageEngine();
    assert.equal(engine.isDatabaseOpen(), false);

    await engine.openDatabase('chat-1');
    assert.equal(engine.isDatabaseOpen(), true);

    await engine.closeDatabase('chat-1');
    assert.equal(engine.isDatabaseOpen(), false);
  });

  it('2. executeAtomicFencedTransaction: Thành công khi Epoch hợp lệ', async () => {
    const engine = new SqliteStorageEngine();
    const chatId = 'chat-concurrency-1';
    const epoch = 1000;

    let executed = false;
    const result = await engine.executeAtomicFencedTransaction(chatId, epoch, async () => {
      executed = true;
      await engine.saveMessage({
        id: 'msg-1',
        chatId,
        parentId: '__ROOT__',
        role: 'user',
        content: 'Fenced transaction test',
        createdAt: Date.now(),
      });
      return 'OK';
    });

    assert.equal(executed, true);
    assert.equal(result, 'OK');
    const thread = await engine.getActiveThread('msg-1');
    assert.equal(thread.length, 1);
    assert.equal(thread[0].content, 'Fenced transaction test');
  });

  it('3. executeAtomicFencedTransaction: Bị chặn và ném FencingConflictError khi Tab khác steal lock trước khi commit', async () => {
    const engine = new SqliteStorageEngine();
    const chatId = 'chat-concurrency-2';
    const localEpoch = 1000;

    // Tab B cướp quyền và bump epoch lên 2000 TRONG LÚC Tab A đang chạy async IO
    let thrownError: unknown = null;
    try {
      await engine.executeAtomicFencedTransaction(chatId, localEpoch, async () => {
        // Mô phỏng Tab B steal lock giữa chừng
        await engine.setFencingEpoch(chatId, 2000);
        return 'SHOULD_FAIL';
      });
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError instanceof FencingConflictError, 'Phải ném FencingConflictError');
    assert.equal((thrownError as FencingConflictError).chatId, chatId);
    assert.equal((thrownError as FencingConflictError).currentEpoch, localEpoch);
    assert.equal((thrownError as FencingConflictError).storageEpoch, 2000);
  });

  it('4. executeAtomicFencedTransaction: Bị chặn ngay từ đầu nếu localEpoch < storageEpoch', async () => {
    const engine = new SqliteStorageEngine();
    const chatId = 'chat-concurrency-3';
    await engine.setFencingEpoch(chatId, 3000);

    let executed = false;
    let thrownError: unknown = null;
    try {
      await engine.executeAtomicFencedTransaction(chatId, 1500, async () => {
        executed = true;
      });
    } catch (err) {
      thrownError = err;
    }

    assert.equal(executed, false, 'TransactionFn không được phép thực thi');
    assert.ok(thrownError instanceof FencingConflictError);
  });
});
