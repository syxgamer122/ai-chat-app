/**
 * Worker Protocol — Định nghĩa giao thức RPC hai chiều giữa Main Thread (React)
 * và Dedicated Web Worker Core Engine.
 *
 * Hỗ trợ Epoch-Tagged RPC Messages (turnSeq) và Standby OPFS Gate.
 */

import type { TurnState, PendingToolCall } from './types';

export interface PendingApprovalCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  expectedBaseHash?: string;
  chatId: string;
  activeLeafId: string;
}

export type WorkerRequest =
  | { id: string; type: 'START_TURN'; chatId: string; activeLeafId: string; input: string; turnSeq?: number }
  | { id: string; type: 'STOP_TURN'; chatId: string; turnSeq?: number }
  | { id: string; type: 'APPROVE_TOOL'; chatId: string; toolCallId: string; token: string }
  | { id: string; type: 'DENY_TOOL'; chatId: string; toolCallId: string; reason?: string }
  | { id: string; type: 'SWITCH_CHAT'; chatId: string; activeLeafId?: string }
  | { id: string; type: 'MOUNT_DB'; chatId?: string }
  | { id: string; type: 'UNMOUNT_DB'; chatId?: string }
  | { id: string; type: 'PING' };

export type WorkerResponse =
  | { type: 'STATE_CHANGED'; chatId: string; state: TurnState; snapshotVersion: number; turnSeq?: number }
  | { type: 'STREAM_CHUNK'; chatId: string; textDelta?: string; reasoningDelta?: string; turnSeq?: number }
  | { type: 'REQUIRE_APPROVAL'; chatId: string; call: PendingApprovalCall }
  | { type: 'TURN_SETTLED'; chatId: string; resultLeafId: string; usage?: { promptTokens?: number; completionTokens?: number }; turnSeq?: number }
  | { type: 'TURN_ABORTED_ACK'; chatId: string; turnSeq: number }
  | { type: 'DB_MOUNTED'; chatId?: string }
  | { type: 'DB_UNMOUNTED'; chatId?: string }
  | { type: 'PONG'; id: string }
  | { type: 'ERROR'; chatId: string; error: string; code?: string; turnSeq?: number };
