/**
 * AgentRuntimeActor — Actor singleton theo chatId hỗ trợ useSyncExternalStore.
 */

import { TurnContext, TurnEvent, TurnState } from './types';
import { createInitialContext, transitionTurnState } from './state-machine';

export class AgentRuntimeActor {
  private state: TurnState = 'idle';
  private context: TurnContext;
  private listeners = new Set<(state: TurnState, context: TurnContext) => void>();
  private snapshotVersion = 0;
  private snapshot: { state: TurnState; context: TurnContext; version: number };

  constructor(chatId: string, activeLeafId = '') {
    this.context = createInitialContext(chatId, activeLeafId);
    this.snapshot = { state: this.state, context: this.context, version: 0 };
  }

  public getState(): TurnState {
    return this.state;
  }

  public getContext(): TurnContext {
    return this.context;
  }

  public getSnapshot(): { state: TurnState; context: TurnContext; version: number } {
    return this.snapshot;
  }

  public subscribe(listener: (state: TurnState, context: TurnContext) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.state, this.context);
    }
  }

  public send(event: TurnEvent): void {
    const prevState = this.state;
    const prevContext = this.context;
    const { nextState, nextContext } = transitionTurnState(this.state, this.context, event);
    this.state = nextState;
    this.context = nextContext;
    if (prevState !== this.state || event.type === 'STREAM_DELTA' || nextContext !== prevContext) {
      this.snapshotVersion++;
      this.snapshot = { state: this.state, context: this.context, version: this.snapshotVersion };
      this.emit();
    }
  }

  public updateActiveLeaf(activeLeafId: string): void {
    if (this.context.activeLeafId !== activeLeafId) {
      this.context = {
        ...this.context,
        activeLeafId,
      };
      this.snapshotVersion++;
      this.snapshot = { state: this.state, context: this.context, version: this.snapshotVersion };
      this.emit();
    }
  }

  public dispose(): void {
    if (this.context.abortController) {
      this.context.abortController.abort();
    }
    // Dọn dẹp tiến trình con trên OS gắn với chatId này (chống Zombie Process khi LRU Eviction)
    if (typeof window !== 'undefined' && (window as any).vyen?.shell?.killByChatId) {
      (window as any).vyen.shell.killByChatId(this.context.chatId).catch(() => {});
    }
    this.listeners.clear();
  }
}
