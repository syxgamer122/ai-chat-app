/**
 * P1.2 — `Agent` class + event bus (port agent loop sang web).
 *
 * UI chỉ việc `new Agent(...)`, `subscribe()` rồi gọi `prompt()`/`continue()`.
 * Vòng lặp thuần nằm ở `loop.ts`; class này chỉ đóng gói state + điều phối:
 * - Subscriber được await ĐÚNG thứ tự đăng ký.
 * - `message_end` của assistant là BARRIER: toàn bộ subscriber phải xong rồi
 *   generator mới bước tiếp → `beforeToolCall` luôn thấy state đã có message đó.
 * - `abort()` cắt signal; `waitForIdle()` đợi run hiện tại (kể cả khi lỗi).
 * - `continue()` retry sau lỗi: yêu cầu message cuối là user hoặc toolResult.
 */

import {
  agentLoop,
  type AgentEvent,
  type AgentExecuteFn,
  type AgentLoopConfig,
  type AgentLoopResult,
  type AgentMessage,
  type AgentStreamFn,
} from './loop';

export type {
  AgentEvent,
  AgentExecuteFn,
  AgentLoopConfig,
  AgentLoopResult,
  AgentMessage,
  AgentStreamFn,
} from './loop';

export type AgentSubscriber = (
  event: AgentEvent,
  context: { messages: readonly AgentMessage[]; agent: Agent },
) => unknown;

export interface AgentConfig
  extends Omit<
    AgentLoopConfig,
    'initialMessages' | 'streamFn' | 'executeTool' | 'signal'
  > {
  initialState?: readonly AgentMessage[];
  streamFn: AgentStreamFn;
  executeTool?: AgentExecuteFn;
}

let seq = 0;
function newId(prefix: string): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${++seq}`;
  } catch {
    return `${prefix}-${Date.now()}-${++seq}`;
  }
}

export class Agent {
  private readonly config: AgentConfig;
  private messages: AgentMessage[];
  private subscribers: Array<{ fn: AgentSubscriber }> = [];
  private controller: AbortController | null = null;
  private runPromise: Promise<AgentLoopResult> | null = null;
  private idleResolvers: Array<() => void> = [];

  /** Lỗi của run gần nhất (null khi thành công). */
  lastError: unknown = null;

  constructor(config: AgentConfig) {
    this.config = config;
    this.messages = [...(config.initialState ?? [])];
  }

  /** State chỉ đọc — subscriber đọc trực tiếp, UI render từ đây. */
  get state(): { messages: readonly AgentMessage[] } {
    return { messages: this.messages };
  }

  get isRunning(): boolean {
    return this.runPromise !== null;
  }

  /** Đăng ký subscriber; trả hàm hủy. Thứ tự đăng ký = thứ tự await. */
  subscribe(fn: AgentSubscriber): () => void {
    const entry = { fn };
    this.subscribers.push(entry);
    return () => {
      const i = this.subscribers.indexOf(entry);
      if (i >= 0) this.subscribers.splice(i, 1);
    };
  }

  /** Thêm user message rồi chạy một turn. Ném nếu agent đang bận. */
  prompt(content: string): Promise<AgentLoopResult> {
    if (this.isRunning) {
      return Promise.reject(new Error('Agent đang bận — dùng steering/follow-up queue (P3.1).'));
    }
    this.messages.push({ id: newId('u'), role: 'user', content });
    return this.run();
  }

  /**
   * Retry/continue sau lỗi. Yêu cầu message cuối là user hoặc toolResult —
   * nếu cuối là assistant (đã có câu trả lời) thì không được tự resend.
   */
  continue(): Promise<AgentLoopResult> {
    if (this.isRunning) {
      return Promise.reject(new Error('Agent đang bận.'));
    }
    const last = this.messages[this.messages.length - 1];
    if (!last || (last.role !== 'user' && last.role !== 'toolResult')) {
      return Promise.reject(
        new Error('agent.continue() yêu cầu message cuối là user hoặc toolResult.'),
      );
    }
    return this.run();
  }

  /** Cắt ngang run hiện tại; streamFn/executeTool phải tôn trọng signal. */
  abort(): void {
    this.controller?.abort();
  }

  /** Luôn resolve khi agent về idle (kể cả run lỗi/abort). */
  waitForIdle(): Promise<void> {
    return this.runPromise ? this.runPromise.then(() => undefined, () => undefined) : Promise.resolve();
  }

  private run(): Promise<AgentLoopResult> {
    if (this.runPromise) return this.runPromise;

    const controller = new AbortController();
    this.controller = controller;
    const generator = agentLoop({
      ...this.config,
      initialMessages: this.messages, // cùng tham chiếu — subscriber thấy state thật
      signal: controller.signal,
    });

    this.runPromise = (async () => {
      let result: AgentLoopResult | undefined;
      this.lastError = null;
      try {
        for (;;) {
          const item = await generator.next();
          if (item.done) {
            result = item.value;
            break;
          }
          const event = item.value;
          // BARRIER: await hết subscriber (theo thứ tự đăng ký) rồi mới
          // generator.next() lần kế tiếp — tức trước preflight/beforeToolCall.
          const snapshot = [...this.subscribers];
          for (const { fn } of snapshot) {
            await fn(event, { messages: this.messages, agent: this });
          }
        }
        if (result?.stopReason === 'aborted') {
          // Loop thuần trả kết quả 'aborted' để generator vẫn kết thúc được;
          // nhưng với API `prompt()`/`continue()` của Agent, một cú abort là
          // lỗi hủy rõ ràng — reject để caller không tưởng nhầm turn thành công.
          throw new Error('aborted');
        }
        return result as AgentLoopResult;
      } catch (error) {
        this.lastError = error;
        throw error;
      } finally {
        this.controller = null;
        this.runPromise = null;
        const resolvers = this.idleResolvers.splice(0);
        for (const resolve of resolvers) resolve();
      }
    })();
    return this.runPromise;
  }
}