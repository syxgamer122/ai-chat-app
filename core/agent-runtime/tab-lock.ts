/**
 * TabLockCoordinator — Điều phối Multi-Tab Concurrency sử dụng Web Locks API
 * và BroadcastChannel Heartbeat để phát hiện Tab Leader bị đóng băng/treo nền.
 */

import { StorageFencing } from './fencing';

export type TabRuntimeMode = 'LEADER' | 'OBSERVER';

export interface LockHeartbeatMessage {
  type: 'HEARTBEAT' | 'FORCE_YIELD';
  chatId: string;
  tabId: string;
  ts: number;
}

export class TabLockCoordinator {
  private abortController: AbortController | null = null;
  private tabId: string = Math.random().toString(36).slice(2, 10);
  private channel: BroadcastChannel | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private checkFrozenTimer: ReturnType<typeof setInterval> | null = null;
  private lastLeaderHeartbeat = 0;
  private onLeaderFrozenCallback?: (frozen: boolean) => void;
  private currentChatId: string | null = null;

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('vyen:lock-heartbeat');
      } catch {
        this.channel = null;
      }
    }
  }

  public onLeaderFrozen(cb: (frozen: boolean) => void): void {
    this.onLeaderFrozenCallback = cb;
  }

  public async acquireRuntimeLock(
    chatId: string,
    onLeader: () => void,
    onLost: () => void,
  ): Promise<TabRuntimeMode> {
    this.currentChatId = chatId;
    if (typeof navigator === 'undefined' || !navigator.locks) {
      await StorageFencing.bumpEpoch(chatId);
      onLeader();
      return 'LEADER';
    }

    this.abortController = new AbortController();

    // Thiết lập listener trên BroadcastChannel
    if (this.channel) {
      this.channel.onmessage = (event) => {
        const msg = event.data as LockHeartbeatMessage;
        if (!msg || msg.chatId !== chatId) return;

        if (msg.type === 'HEARTBEAT') {
          this.lastLeaderHeartbeat = Date.now();
          this.onLeaderFrozenCallback?.(false);
        } else if (msg.type === 'FORCE_YIELD') {
          // Tab khác yêu cầu nhường quyền Leader
          this.release();
          onLost();
        }
      };
    }

    return new Promise<TabRuntimeMode>((resolve) => {
      navigator.locks
        .request(
          `vyen:chat-runtime:${chatId}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              // Lock đã bị tab khác chiếm giữ -> Tab hiện tại đóng vai trò OBSERVER
              this.startObserverWatch(chatId);
              resolve('OBSERVER');
              return;
            }

            // Chiếm lock thành công -> Tab hiện tại đóng vai trò LEADER
            await StorageFencing.bumpEpoch(chatId);
            this.stopObserverWatch();
            this.startLeaderHeartbeat(chatId);
            resolve('LEADER');
            onLeader();

            // Giữ lock cho tới khi signal kích hoạt abort (khi đổi chat hoặc đóng tab)
            return new Promise<void>((keepLock) => {
              this.abortController?.signal.addEventListener('abort', () => {
                this.stopLeaderHeartbeat();
                onLost();
                keepLock();
              });
            });
          },
        )
        .catch(() => {
          this.startObserverWatch(chatId);
          resolve('OBSERVER');
        });
    });
  }

  /**
   * Cưỡng chế chiếm quyền Leader (khi Leader bị đóng băng hoặc treo nền).
   */
  public async forceStealLock(
    chatId: string,
    onLeader: () => void,
    onLost: () => void,
  ): Promise<TabRuntimeMode> {
    this.currentChatId = chatId;
    // Báo cho các tab khác biết có hành động cướp quyền
    try {
      this.channel?.postMessage({
        type: 'FORCE_YIELD',
        chatId,
        tabId: this.tabId,
        ts: Date.now(),
      });
    } catch {}

    this.release();
    this.abortController = new AbortController();

    if (typeof navigator === 'undefined' || !navigator.locks) {
      await StorageFencing.bumpEpoch(chatId);
      onLeader();
      return 'LEADER';
    }

    return new Promise<TabRuntimeMode>((resolve) => {
      navigator.locks
        .request(
          `vyen:chat-runtime:${chatId}`,
          { steal: true },
          async (lock) => {
            if (!lock) {
              this.startObserverWatch(chatId);
              resolve('OBSERVER');
              return;
            }

            await StorageFencing.bumpEpoch(chatId);
            this.stopObserverWatch();
            this.startLeaderHeartbeat(chatId);
            this.onLeaderFrozenCallback?.(false);
            resolve('LEADER');
            onLeader();

            return new Promise<void>((keepLock) => {
              this.abortController?.signal.addEventListener('abort', () => {
                this.stopLeaderHeartbeat();
                onLost();
                keepLock();
              });
            });
          },
        )
        .catch(() => {
          this.startObserverWatch(chatId);
          resolve('OBSERVER');
        });
    });
  }

  private startLeaderHeartbeat(chatId: string): void {
    this.stopLeaderHeartbeat();
    const send = async () => {
      try {
        await StorageFencing.assertValidLeader(chatId);
      } catch {
        this.release();
        return;
      }
      try {
        this.channel?.postMessage({
          type: 'HEARTBEAT',
          chatId,
          tabId: this.tabId,
          ts: Date.now(),
        });
      } catch {}
    };
    send();
    this.heartbeatTimer = setInterval(send, 2000);
  }

  private stopLeaderHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startObserverWatch(chatId: string): void {
    this.stopObserverWatch();
    this.lastLeaderHeartbeat = Date.now();
    this.checkFrozenTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastLeaderHeartbeat;
      if (elapsed > 5000) {
        this.onLeaderFrozenCallback?.(true);
      }
    }, 2000);
  }

  private stopObserverWatch(): void {
    if (this.checkFrozenTimer) {
      clearInterval(this.checkFrozenTimer);
      this.checkFrozenTimer = null;
    }
  }

  public release(): void {
    this.stopLeaderHeartbeat();
    this.stopObserverWatch();
    this.abortController?.abort();
  }

  public dispose(): void {
    this.release();
    if (this.channel) {
      try {
        this.channel.close();
      } catch {}
      this.channel = null;
    }
  }
}
