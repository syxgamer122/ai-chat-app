/**
 * React Adapter — useAgentRuntime hook (Tầng 2).
 *
 * Nhiệm vụ:
 * 1. Kết nối AgentRuntimeActor với React 18/19 thông qua `useSyncExternalStore`.
 * 2. Tự động khởi tạo và dọn dẹp Actor theo `chatId`, chống rò rỉ bộ nhớ & stale closure.
 * 3. Tích hợp Web Locks API qua `TabLockCoordinator` phân quyền đa tab LEADER / OBSERVER.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AgentRuntimeActor } from '@/core/agent-runtime/runtime-actor';
import { TurnContext, TurnEvent, TurnState } from '@/core/agent-runtime/types';
import { TabLockCoordinator, TabRuntimeMode } from '@/core/agent-runtime/tab-lock';
import { getOrCreateActor } from '@/core/agent-runtime/actor-registry';

export interface UseAgentRuntimeOptions {
  chatId: string;
  activeLeafId?: string;
  autoAcquireLock?: boolean;
}

export interface UseAgentRuntimeReturn {
  state: TurnState;
  context: TurnContext;
  tabMode: TabRuntimeMode;
  isLeader: boolean;
  isLeaderFrozen: boolean;
  forceStealLock: () => void;
  actor: AgentRuntimeActor;
  send: (event: TurnEvent) => void;
  startTurn: (activeLeafId?: string) => void;
  stopTurn: () => void;
  approveTool: (toolCallId: string, token: string) => void;
  denyTool: (toolCallId: string, reason?: string) => void;
}

export {
  MAX_ACTIVE_ACTORS,
  LruActorRegistry,
  actorRegistry,
  getActor,
  clearActorRegistry,
  getOrCreateActor,
} from '@/core/agent-runtime/actor-registry';

export function useAgentRuntime({
  chatId,
  activeLeafId = '',
  autoAcquireLock = true,
}: UseAgentRuntimeOptions): UseAgentRuntimeReturn {
  // Lấy hoặc tạo Actor singleton tương ứng với chatId
  const actor = useMemo(() => getOrCreateActor(chatId, activeLeafId), [chatId]);

  // Cập nhật activeLeafId vào Actor khi đổi nhánh
  useEffect(() => {
    if (activeLeafId && actor.getContext().activeLeafId !== activeLeafId) {
      actor.updateActiveLeaf(activeLeafId);
    }
  }, [actor, activeLeafId]);

  // Điều phối Multi-Tab Concurrency qua Web Locks API & BroadcastChannel Heartbeat
  const [tabMode, setTabMode] = useState<TabRuntimeMode>('LEADER');
  const [isLeaderFrozen, setIsLeaderFrozen] = useState(false);
  const lockCoordinatorRef = useRef<TabLockCoordinator | null>(null);

  useEffect(() => {
    if (!autoAcquireLock || !chatId) return;

    let mounted = true;
    const coordinator = new TabLockCoordinator();
    lockCoordinatorRef.current = coordinator;

    coordinator.onLeaderFrozen((frozen) => {
      if (mounted) setIsLeaderFrozen(frozen);
    });

    coordinator
      .acquireRuntimeLock(
        chatId,
        () => {
          if (mounted) {
            setTabMode('LEADER');
            setIsLeaderFrozen(false);
          }
        },
        () => {
          if (mounted) setTabMode('OBSERVER');
        },
      )
      .then((mode) => {
        if (mounted) setTabMode(mode);
      })
      .catch(() => {
        if (mounted) setTabMode('OBSERVER');
      });

    return () => {
      mounted = false;
      coordinator.dispose();
    };
  }, [chatId, autoAcquireLock]);

  const forceStealLock = useCallback(() => {
    if (!chatId || !lockCoordinatorRef.current) return;
    lockCoordinatorRef.current
      .forceStealLock(
        chatId,
        () => {
          setTabMode('LEADER');
          setIsLeaderFrozen(false);
        },
        () => setTabMode('OBSERVER'),
      )
      .then((mode) => setTabMode(mode));
  }, [chatId]);

  // Đồng bộ trạng thái Actor vào React bằng useSyncExternalStore
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      return actor.subscribe(() => {
        onStoreChange();
      });
    },
    [actor],
  );

  const getSnapshot = useCallback(() => {
    return actor.getSnapshot();
  }, [actor]);

  const getServerSnapshot = useCallback(() => {
    return actor.getSnapshot();
  }, [actor]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Điều phối Event Wrappers
  const send = useCallback(
    (event: TurnEvent) => {
      actor.send(event);
    },
    [actor],
  );

  const startTurn = useCallback(
    (targetLeafId?: string) => {
      actor.send({
        type: 'START_TURN',
        chatId,
        activeLeafId: targetLeafId || activeLeafId,
      });
    },
    [actor, chatId, activeLeafId],
  );

  const stopTurn = useCallback(() => {
    actor.send({ type: 'STOP' });
  }, [actor]);

  const approveTool = useCallback(
    (toolCallId: string, token: string) => {
      actor.send({
        type: 'USER_APPROVE',
        toolCallId,
        token,
      });
    },
    [actor],
  );

  const denyTool = useCallback(
    (toolCallId: string, reason?: string) => {
      actor.send({
        type: 'USER_DENY',
        toolCallId,
        reason,
      });
    },
    [actor],
  );

  return {
    state: snapshot.state,
    context: snapshot.context,
    tabMode,
    isLeader: tabMode === 'LEADER',
    isLeaderFrozen,
    forceStealLock,
    actor,
    send,
    startTurn,
    stopTurn,
    approveTool,
    denyTool,
  };
}
