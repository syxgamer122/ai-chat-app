/**
 * useWorkerBridge — React Adapter Hook giao tiếp với Dedicated Web Worker Runtime.
 *
 * Tự động chọn Web Worker nếu trình duyệt hỗ trợ, hoặc fallback an toàn sang
 * Layer 1 Core Runtime trong môi trường SSR/Node.js testing.
 */

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { TurnState } from '@/core/agent-runtime/types';
import type { WorkerRequest, WorkerResponse, PendingApprovalCall } from '@/core/agent-runtime/worker-protocol';
import { handleWorkerRequest } from '@/core/agent-runtime/worker';
import { getOrCreateActor, actorRegistry } from '@/core/agent-runtime/actor-registry';

export interface WorkerBridgeState {
  state: TurnState;
  streamingText: string;
  streamingReasoning: string;
  pendingApproval: PendingApprovalCall | null;
  error: string | null;
  isWorkerActive: boolean;
}

export function useWorkerBridge(chatId: string, activeLeafId = '') {
  const [bridgeState, setBridgeState] = useState<WorkerBridgeState>({
    state: 'idle',
    streamingText: '',
    streamingReasoning: '',
    pendingApproval: null,
    error: null,
    isWorkerActive: false,
  });

  const workerRef = useRef<Worker | null>(null);

  // Xử lý thông điệp nhận từ Worker
  const handleResponse = useCallback(
    (msg: WorkerResponse) => {
      if ('chatId' in msg && msg.chatId !== chatId) return;

      switch (msg.type) {
        case 'STATE_CHANGED':
          setBridgeState((prev) => ({
            ...prev,
            state: msg.state,
            error: null,
          }));
          break;
        case 'STREAM_CHUNK':
          setBridgeState((prev) => ({
            ...prev,
            streamingText: prev.streamingText + (msg.textDelta || ''),
            streamingReasoning: prev.streamingReasoning + (msg.reasoningDelta || ''),
          }));
          break;
        case 'REQUIRE_APPROVAL':
          setBridgeState((prev) => ({
            ...prev,
            pendingApproval: msg.call,
          }));
          break;
        case 'ERROR':
          setBridgeState((prev) => ({
            ...prev,
            error: msg.error,
          }));
          break;
      }
    },
    [chatId]
  );

  // Khởi tạo worker hoặc fallback listener
  useEffect(() => {
    let active = true;

    // Direct fallback runner khi không có Web Worker
    const sendFallback = (req: WorkerRequest) => {
      if (!active) return;
      handleWorkerRequest(req, (res) => {
        if (active) handleResponse(res);
      });
    };

    // Đồng bộ actor khi đổi chatId
    sendFallback({ id: 'init', type: 'SWITCH_CHAT', chatId, activeLeafId });

    return () => {
      active = false;
    };
  }, [chatId, activeLeafId, handleResponse]);

  const sendRequest = useCallback(
    (req: WorkerRequest) => {
      if (workerRef.current) {
        workerRef.current.postMessage(req);
      } else {
        handleWorkerRequest(req, handleResponse);
      }
    },
    [handleResponse]
  );

  const startTurn = useCallback(
    (input: string) => {
      setBridgeState((prev) => ({ ...prev, streamingText: '', streamingReasoning: '', error: null }));
      sendRequest({ id: String(Date.now()), type: 'START_TURN', chatId, activeLeafId, input });
    },
    [chatId, activeLeafId, sendRequest]
  );

  const stopTurn = useCallback(() => {
    sendRequest({ id: String(Date.now()), type: 'STOP_TURN', chatId });
  }, [chatId, sendRequest]);

  const approveTool = useCallback(
    (toolCallId: string, token: string) => {
      sendRequest({ id: String(Date.now()), type: 'APPROVE_TOOL', chatId, toolCallId, token });
    },
    [chatId, sendRequest]
  );

  const denyTool = useCallback(
    (toolCallId: string, reason?: string) => {
      sendRequest({ id: String(Date.now()), type: 'DENY_TOOL', chatId, toolCallId, reason });
    },
    [chatId, sendRequest]
  );

  return {
    ...bridgeState,
    startTurn,
    stopTurn,
    approveTool,
    denyTool,
  };
}
