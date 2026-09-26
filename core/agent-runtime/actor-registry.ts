/**
 * Core Agent Runtime — Actor Registry & LRU Eviction (Layer 1: Zero React Dependencies).
 */

import { AgentRuntimeActor } from './runtime-actor';

export const MAX_ACTIVE_ACTORS = 10;

/**
 * LRU Actor Registry — Giới hạn tối đa 10 active actors trong tab.
 * Khi vượt ngưỡng, actor ít dùng nhất sẽ bị evict và gọi actor.dispose()
 * để giải phóng toàn bộ AbortController, subscriptions và listeners.
 */
export class LruActorRegistry {
  private actors = new Map<string, AgentRuntimeActor>();
  private readonly maxActors: number;

  constructor(maxActors = MAX_ACTIVE_ACTORS) {
    this.maxActors = maxActors;
  }

  get(chatId: string): AgentRuntimeActor | undefined {
    const actor = this.actors.get(chatId);
    if (actor) {
      // Làm mới thứ tự truy cập (MRU): xóa và chèn lại vào cuối
      this.actors.delete(chatId);
      this.actors.set(chatId, actor);
    }
    return actor;
  }

  has(chatId: string): boolean {
    return this.actors.has(chatId);
  }

  get size(): number {
    return this.actors.size;
  }

  set(chatId: string, actor: AgentRuntimeActor): void {
    if (this.actors.has(chatId)) {
      this.actors.delete(chatId);
    } else if (this.actors.size >= this.maxActors) {
      // Evict actor cũ nhất (phần tử đầu tiên theo thứ tự lặp)
      const oldestKey = this.actors.keys().next().value;
      if (oldestKey) {
        const evicted = this.actors.get(oldestKey);
        evicted?.dispose();
        this.actors.delete(oldestKey);
      }
    }
    this.actors.set(chatId, actor);
  }

  delete(chatId: string): boolean {
    const actor = this.actors.get(chatId);
    if (actor) {
      actor.dispose();
      return this.actors.delete(chatId);
    }
    return false;
  }

  clear(): void {
    for (const actor of this.actors.values()) {
      actor.dispose();
    }
    this.actors.clear();
  }

  values(): IterableIterator<AgentRuntimeActor> {
    return this.actors.values();
  }
}

/** Registry lưu trữ Actor singleton theo chatId với LRU Eviction */
export const actorRegistry = new LruActorRegistry(MAX_ACTIVE_ACTORS);

export function getActor(chatId: string): AgentRuntimeActor | undefined {
  return actorRegistry.get(chatId);
}

export function clearActorRegistry(chatId?: string): void {
  if (chatId) {
    actorRegistry.delete(chatId);
  } else {
    actorRegistry.clear();
  }
}

export function getOrCreateActor(chatId: string, activeLeafId = ''): AgentRuntimeActor {
  let actor = actorRegistry.get(chatId);
  if (!actor) {
    actor = new AgentRuntimeActor(chatId, activeLeafId);
    actorRegistry.set(chatId, actor);
  }
  return actor;
}
