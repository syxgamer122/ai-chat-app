/**
 * Dedicated Web Worker — Core Agent Runtime Worker.
 *
 * Tách biệt hoàn toàn tính toán nặng (hashing diff, JSON parsing, state machine)
 * khỏi Main UI Thread, đảm bảo giao diện React 19 đạt 120 FPS mượt mà tuyệt đối.
 * Hỗ trợ Epoch-Tagged RPC (turnSeq), Standby OPFS Gate và Turn Aborted Ack.
 */

import { getOrCreateActor, actorRegistry } from './actor-registry';
import { sqliteStorageEngine } from '../storage/sqlite-driver';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

// Lưu vết turnSeq đơn điệu tăng dần theo từng phiên chat
const lastTurnSeqByChat = new Map<string, number>();

// Helper gửi phản hồi về Main Thread
function post(msg: WorkerResponse) {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.postMessage(msg);
  }
}

export function handleWorkerRequest(req: WorkerRequest, respond: (res: WorkerResponse) => void = post): void {
  switch (req.type) {
    case 'PING': {
      respond({ type: 'PONG', id: req.id });
      break;
    }

    case 'MOUNT_DB': {
      sqliteStorageEngine.openDatabase(req.chatId);
      respond({ type: 'DB_MOUNTED', chatId: req.chatId });
      break;
    }

    case 'UNMOUNT_DB': {
      sqliteStorageEngine.closeDatabase(req.chatId);
      respond({ type: 'DB_UNMOUNTED', chatId: req.chatId });
      break;
    }

    case 'SWITCH_CHAT': {
      const actor = getOrCreateActor(req.chatId, req.activeLeafId || '');
      respond({
        type: 'STATE_CHANGED',
        chatId: req.chatId,
        state: actor.getState(),
        snapshotVersion: actor.getSnapshot().version,
      });
      break;
    }

    case 'START_TURN': {
      const turnSeq = req.turnSeq ?? 0;
      const currentLast = lastTurnSeqByChat.get(req.chatId) || 0;

      // Bỏ qua các yêu cầu cũ bị hoãn trong microtask queue
      if (req.turnSeq !== undefined && req.turnSeq < currentLast) {
        return;
      }

      if (req.turnSeq !== undefined) {
        lastTurnSeqByChat.set(req.chatId, req.turnSeq);
      }

      try {
        const actor = getOrCreateActor(req.chatId, req.activeLeafId);
        actor.send({ type: 'START_TURN', chatId: req.chatId, activeLeafId: req.activeLeafId });
        respond({
          type: 'STATE_CHANGED',
          chatId: req.chatId,
          state: actor.getState(),
          snapshotVersion: actor.getSnapshot().version,
          turnSeq,
        });
      } catch (err) {
        respond({
          type: 'ERROR',
          chatId: req.chatId,
          error: err instanceof Error ? err.message : String(err),
          turnSeq,
        });
      }
      break;
    }

    case 'STOP_TURN': {
      const actor = actorRegistry.get(req.chatId);
      if (actor) {
        actor.send({ type: 'STOP' });
        respond({
          type: 'STATE_CHANGED',
          chatId: req.chatId,
          state: actor.getState(),
          snapshotVersion: actor.getSnapshot().version,
          turnSeq: req.turnSeq,
        });
      }

      // Luôn gửi TURN_ABORTED_ACK phản hồi tường minh về Main Thread
      if (req.turnSeq !== undefined) {
        respond({
          type: 'TURN_ABORTED_ACK',
          chatId: req.chatId,
          turnSeq: req.turnSeq,
        });
      }
      break;
    }

    case 'APPROVE_TOOL': {
      const actor = actorRegistry.get(req.chatId);
      if (actor) {
        actor.send({
          type: 'USER_APPROVE',
          toolCallId: req.toolCallId,
          token: req.token,
        });
        respond({
          type: 'STATE_CHANGED',
          chatId: req.chatId,
          state: actor.getState(),
          snapshotVersion: actor.getSnapshot().version,
        });
      }
      break;
    }

    case 'DENY_TOOL': {
      const actor = actorRegistry.get(req.chatId);
      if (actor) {
        actor.send({
          type: 'USER_DENY',
          toolCallId: req.toolCallId,
          reason: req.reason,
        });
        respond({
          type: 'STATE_CHANGED',
          chatId: req.chatId,
          state: actor.getState(),
          snapshotVersion: actor.getSnapshot().version,
        });
      }
      break;
    }
  }
}

// Khởi tạo listener khi chạy trong worker context thực tế
if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  (self as any).addEventListener('message', (event: MessageEvent) => {
    if (event.data && typeof event.data === 'object' && 'type' in event.data) {
      handleWorkerRequest(event.data as WorkerRequest, post);
    }
  });
}
