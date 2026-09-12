import {
  DagEngineError,
  IRetryPolicy,
  JitterStrategy,
  RetryPolicyOptions,
} from './types';

/**
 * RetryPolicy implements exponential backoff with configurable jitter strategies.
 * Prevents thundering herds and synchronized retry storms.
 *
 * Strategies:
 * - 'full': delay in [0, rawBackoff]
 * - 'equal': delay in [rawBackoff / 2, rawBackoff]
 * - 'authoritative': rawBackoff ± jitter clamped to [0, maxDelayMs]
 * - 'decorrelated': sleep_i = min(max, random(base, sleep_{i-1} * 3))
 * - 'none': rawBackoff deterministically
 */
export class RetryPolicy implements IRetryPolicy {
  public readonly maxRetries: number;
  public readonly baseDelayMs: number;
  public readonly maxDelayMs: number;
  public readonly factor: number;
  public readonly jitterStrategy: JitterStrategy;
  public readonly jitterRatio: number;
  private readonly isRetryableFilter?: (error: unknown) => boolean;
  private prevSleepMs: number;

  constructor(options?: Partial<RetryPolicyOptions>) {
    this.maxRetries = options?.maxRetries ?? 3;
    this.baseDelayMs = Math.max(1, options?.baseDelayMs ?? 1000);
    this.maxDelayMs = Math.max(this.baseDelayMs, options?.maxDelayMs ?? 30000);
    this.factor = Math.max(1, options?.factor ?? 2);
    this.jitterStrategy =
      options?.jitterStrategy ?? options?.jitterType ?? 'authoritative';
    this.jitterRatio = Math.min(1, Math.max(0, options?.jitterRatio ?? 0.2));
    this.isRetryableFilter = options?.isRetryable;
    this.prevSleepMs = this.baseDelayMs;
  }

  /**
   * Determines whether an operation should be retried given the attempt number and error.
   */
  public shouldRetry(attempt: number, error?: unknown): boolean {
    if (attempt > this.maxRetries) {
      return false;
    }
    if (this.isRetryableFilter) {
      return this.isRetryableFilter(error);
    }
    return true;
  }

  /**
   * Computes the jittered backoff delay in milliseconds for the given attempt.
   * Clamped strictly within [0, maxDelayMs].
   */
  public computeDelay(attempt: number): number {
    const safeExponent = Math.min(50, Math.max(0, attempt - 1));
    const rawBackoff = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * Math.pow(this.factor, safeExponent)
    );

    let finalDelay: number;

    switch (this.jitterStrategy) {
      case 'full': {
        finalDelay = Math.random() * rawBackoff;
        break;
      }
      case 'equal': {
        const half = rawBackoff / 2;
        finalDelay = half + Math.random() * half;
        break;
      }
      case 'decorrelated': {
        const next =
          Math.random() * (this.prevSleepMs * 3 - this.baseDelayMs) + this.baseDelayMs;
        finalDelay = Math.min(this.maxDelayMs, Math.max(this.baseDelayMs, next));
        this.prevSleepMs = finalDelay;
        break;
      }
      case 'none': {
        finalDelay = rawBackoff;
        break;
      }
      case 'authoritative':
      default: {
        // delay = min(maxDelayMs, base * factor^(attempt - 1)) ± jitterRatio
        // (first attempt waits exactly `base`, matching the documented retry schedule)
        const jitterRange = rawBackoff * this.jitterRatio;
        const delta = (Math.random() * 2 - 1) * jitterRange;
        finalDelay = rawBackoff + delta;
        break;
      }
    }

    return Math.round(Math.min(this.maxDelayMs, Math.max(0, finalDelay)));
  }

  /**
   * Waits for the computed backoff delay with abort signal cancellation.
   */
  public async waitDelay(attempt: number, signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) {
      throw new DagEngineError('Retry wait aborted by signal.');
    }

    const delay = this.computeDelay(attempt);
    if (delay <= 0) {
      return 0;
    }

    return new Promise<number>((resolve, reject) => {
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

      const onAbort = () => {
        cleanup();
        reject(new DagEngineError('Retry wait aborted by signal.'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      timer = setTimeout(() => {
        cleanup();
        resolve(delay);
      }, delay);
    });
  }
}
