import { DagEngineError, ExecutionTimeoutError } from './types';

export interface ConcurrencySlot {
  release: () => void;
}

/**
 * AsyncSemaphore limits concurrent execution of tasks up to a configured ceiling.
 * Supports timeouts, AbortSignal cancellation, and fair FIFO queuing.
 */
export class AsyncSemaphore {
  private readonly _maxSlots: number;
  private _availableSlots: number;
  private readonly waiters: Array<(slot: ConcurrencySlot) => void> = [];

  constructor(maxSlots: number) {
    this._maxSlots = Math.max(1, Math.floor(maxSlots));
    this._availableSlots = this._maxSlots;
  }

  public get maxSlots(): number {
    return this._maxSlots;
  }

  public get currentCapacity(): number {
    return this._availableSlots;
  }

  public get activeCount(): number {
    return this._maxSlots - this._availableSlots;
  }

  public get waitingCount(): number {
    return this.waiters.length;
  }

  /**
   * Acquires a concurrency slot. Returns a release handle.
   * Throws ExecutionTimeoutError if timeoutMs is exceeded.
   * Throws DagEngineError if AbortSignal is triggered.
   */
  public async acquire(timeoutMs?: number, signal?: AbortSignal): Promise<ConcurrencySlot> {
    if (signal?.aborted) {
      throw new DagEngineError('Semaphore acquisition aborted by signal.');
    }

    if (this._availableSlots > 0) {
      this._availableSlots--;
      return this.createSlot();
    }

    return new Promise<ConcurrencySlot>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const fulfill = (slot: ConcurrencySlot) => {
        cleanup();
        resolve(slot);
      };

      const onAbort = () => {
        cleanup();
        const idx = this.waiters.indexOf(fulfill);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
        reject(new DagEngineError('Semaphore acquisition aborted by signal.'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (timeoutMs && timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          const idx = this.waiters.indexOf(fulfill);
          if (idx !== -1) {
            this.waiters.splice(idx, 1);
          }
          reject(new ExecutionTimeoutError('Semaphore slot acquisition', timeoutMs));
        }, timeoutMs);
      }

      this.waiters.push(fulfill);
    });
  }

  /**
   * Runs a task inside a semaphore slot and guarantees slot release upon completion.
   */
  public async runExclusive<T>(
    fn: () => Promise<T>,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<T> {
    const slot = await this.acquire(timeoutMs, signal);
    try {
      return await fn();
    } finally {
      slot.release();
    }
  }

  private createSlot(): ConcurrencySlot {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;

        if (this.waiters.length > 0) {
          const nextWaiter = this.waiters.shift()!;
          nextWaiter(this.createSlot());
        } else {
          this._availableSlots = Math.min(this._maxSlots, this._availableSlots + 1);
        }
      },
    };
  }
}
