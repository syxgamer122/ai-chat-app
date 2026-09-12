/**
 * Rate Limit & Overload Protection for Teamwork Multi-Agent Runtime Engine.
 * Conforms strictly to ORIGINAL_REQUEST.md R3, PROJECT.md, and .opencode/agents/teamwork-orchestrator.md.
 *
 * Implements:
 * 1. isRateLimitError(err): Robust detection of HTTP 429, status code 429, and provider overload patterns.
 *    Integrates @/lib/upstream-status-rules (restateUpstreamStatus) to normalize mislabeled gateway errors.
 * 2. handleRateLimit(error, options): Halts execution immediately without retry spam, updates teamwork/PROGRESS.md
 *    status to BLOCKED_429, and logs timestamp and diagnostics.
 * 3. RateLimitManager: Helper tracking pause states, cooldown periods, and resume conditions.
 */

import { restateUpstreamStatus } from '@/lib/upstream-status-rules';
import {
  generateProgressMd,
  parseProgressMd,
  readTeamworkArtifacts,
  updateProgressState,
  writeTeamworkArtifacts,
} from './artifacts';
import { ProgressState, RateLimitStatus } from './types';

/**
 * Regular expression matching rate limit, quota, and overload keywords across providers.
 */
const RATE_LIMIT_TEXT_PATTERN =
  /\b(rate[_\s-]?limit(?:ed)?|too\s+many\s+requests|overloaded|quota\s*(?:exceeded|reached)?|insufficient[_\s-]?(?:quota|balance|credit)|tpm\b|rpm\b|tokens\s+per\s+minute|requests\s+per\s+minute|resource[_\s-]?exhausted|capacity[_\s-]?exceeded)\b|额度不足|余额不足|请求过多|请求频率/i;

/**
 * Detects whether an arbitrary error represents an HTTP 429 or provider rate limit / overload.
 */
export function isRateLimitError(err: unknown): boolean {
  if (err === null || err === undefined) {
    return false;
  }

  // 1. Direct number status code
  if (typeof err === 'number') {
    return err === 429;
  }

  // 2. Direct string message
  if (typeof err === 'string') {
    if (/\b429\b/.test(err) && RATE_LIMIT_TEXT_PATTERN.test(err)) {
      return true;
    }
    return RATE_LIMIT_TEXT_PATTERN.test(err);
  }

  // 3. Object or Error inspection
  if (typeof err === 'object') {
    const errorObj = err as Record<string, unknown>;

    // Extract potential HTTP status code
    let statusCode: number | undefined = undefined;
    if (typeof errorObj.status === 'number') {
      statusCode = errorObj.status;
    } else if (typeof errorObj.statusCode === 'number') {
      statusCode = errorObj.statusCode;
    } else if (typeof errorObj.code === 'number') {
      statusCode = errorObj.code;
    } else if (typeof errorObj.code === 'string' && /^\d+$/.test(errorObj.code)) {
      statusCode = parseInt(errorObj.code, 10);
    }

    // Check nested response status
    if (!statusCode && errorObj.response && typeof errorObj.response === 'object') {
      const resp = errorObj.response as Record<string, unknown>;
      if (typeof resp.status === 'number') statusCode = resp.status;
      else if (typeof resp.statusCode === 'number') statusCode = resp.statusCode;
    }

    // Check nested cause status
    if (!statusCode && errorObj.cause && typeof errorObj.cause === 'object') {
      const cause = errorObj.cause as Record<string, unknown>;
      if (typeof cause.status === 'number') statusCode = cause.status;
      else if (typeof cause.statusCode === 'number') statusCode = cause.statusCode;
    }

    // Direct 429 status match
    if (statusCode === 429) {
      return true;
    }

    // Extract textual message/body representation
    const textParts: string[] = [];
    if (typeof errorObj.message === 'string') textParts.push(errorObj.message);
    if (typeof errorObj.name === 'string') textParts.push(errorObj.name);
    if (typeof errorObj.code === 'string') textParts.push(errorObj.code);
    if (typeof errorObj.details === 'string') textParts.push(errorObj.details);
    if (typeof errorObj.body === 'string') textParts.push(errorObj.body);

    if (errorObj.error && typeof errorObj.error === 'object') {
      const inner = errorObj.error as Record<string, unknown>;
      if (typeof inner.message === 'string') textParts.push(inner.message);
      if (typeof inner.code === 'string') textParts.push(inner.code);
    }

    const combinedText = textParts.join(' ');

    // 4. Integrate @/lib/upstream-status-rules: Check status restatement
    if (statusCode !== undefined && combinedText) {
      const restated = restateUpstreamStatus(statusCode, combinedText);
      if (restated.status === 429) {
        return true;
      }
    }

    // 5. Check error code constants
    if (
      typeof errorObj.code === 'string' &&
      /^(rate_limit_exceeded|insufficient_quota|quota_exceeded|RATE_LIMIT_EXCEEDED|TOO_MANY_REQUESTS)$/i.test(
        errorObj.code,
      )
    ) {
      return true;
    }

    // 6. Check regex text match
    if (RATE_LIMIT_TEXT_PATTERN.test(combinedText)) {
      return true;
    }

    // Also check String(err)
    const errString = String(err);
    if (RATE_LIMIT_TEXT_PATTERN.test(errString)) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts a concise error message for rate-limit logging.
 */
function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message) return obj.message;
    if (typeof obj.statusText === 'string' && obj.statusText) return obj.statusText;
  }
  return String(error || 'HTTP 429 Too Many Requests');
}

export interface RateLimitHandleOptions {
  /** Absolute path to workspace root */
  workspaceRoot: string;
  /** Optional milestone ID that was running when rate limit was hit */
  milestoneId?: string;
  /** Optional custom note to record in PROGRESS.md */
  note?: string;
  /** Optional callback invoked immediately when execution is halted */
  onHalt?: () => void;
  /** Suggested cooldown time in ms before retrying */
  cooldownMs?: number;
}

export interface RateLimitHandleResult {
  halted: boolean;
  status: 'BLOCKED_429';
  timestamp: string;
  note: string;
  milestoneId?: string;
  cooldownMs: number;
}

/**
 * Halts execution immediately upon encountering a 429/overload error,
 * records the blocked state in teamwork/PROGRESS.md, and prevents aggressive retry loops.
 */
export async function handleRateLimit(
  error: unknown,
  options: RateLimitHandleOptions,
): Promise<RateLimitHandleResult> {
  const timestamp = new Date().toISOString();
  const rawMsg = extractErrorMessage(error);
  const cooldownMs = options.cooldownMs ?? 60_000;

  const note =
    options.note ||
    `Execution halted at ${timestamp} due to 429 Rate Limit: ${rawMsg}. Paused to prevent retry spam.`;

  // 1. Invoke onHalt callback immediately
  if (options.onHalt) {
    try {
      options.onHalt();
    } catch {
      // ignore callback errors during halt
    }
  }

  // 2. Update teamwork/PROGRESS.md
  try {
    const artifacts = await readTeamworkArtifacts(options.workspaceRoot);
    let currentState: ProgressState;

    if (artifacts.progressMd) {
      currentState = parseProgressMd(artifacts.progressMd);
    } else {
      currentState = {
        title: 'Teamwork Execution',
        milestones: [],
        rateLimitStatus: 'HEALTHY',
        lastUpdated: timestamp,
        executionLogs: [],
        fileStats: [],
      };
    }

    const updatedState = updateProgressState(currentState, {
      rateLimitStatus: 'BLOCKED_429',
      rateLimitNote: note,
      lastUpdated: timestamp,
      milestoneId: options.milestoneId,
      status: options.milestoneId ? 'blocked' : undefined,
      notes: options.milestoneId ? `Halted on 429 rate limit` : undefined,
      logEntry: {
        agent: 'orchestrator',
        action: 'rate_limit_halt',
        details: `429 Too Many Requests detected. Halted execution safely. ${rawMsg}`,
        timestamp,
        milestoneId: options.milestoneId || 'General',
      },
    });

    const newProgressMd = generateProgressMd(updatedState);
    await writeTeamworkArtifacts(options.workspaceRoot, {
      progressMd: newProgressMd,
    });
  } catch (fsErr) {
    // Gracefully handle filesystem update errors without throwing
    console.warn(`[TeamworkRateLimit] Failed to persist PROGRESS.md update: ${String(fsErr)}`);
  }

  return {
    halted: true,
    status: 'BLOCKED_429',
    timestamp,
    note,
    milestoneId: options.milestoneId,
    cooldownMs,
  };
}

/**
 * Historical record of a rate limit incident.
 */
export interface RateLimitRecord {
  timestamp: number;
  isoTime: string;
  error: string;
  milestoneId?: string;
  cooldownMs: number;
  context?: Record<string, unknown>;
}

/**
 * RateLimitManager helper for tracking rate limit pauses and resume conditions.
 */
export class RateLimitManager {
  private paused: boolean = false;
  private pauseReason?: string;
  private pauseTimestamp?: number;
  private currentCooldownMs: number;
  private readonly defaultCooldownMs: number;
  private readonly records: RateLimitRecord[] = [];

  constructor(options?: { defaultCooldownMs?: number }) {
    this.defaultCooldownMs = options?.defaultCooldownMs ?? 60_000;
    this.currentCooldownMs = this.defaultCooldownMs;
  }

  /**
   * Records a rate limit event and transitions to paused state.
   */
  public recordRateLimit(
    error: unknown,
    context?: { milestoneId?: string; cooldownMs?: number; timestamp?: number; [key: string]: unknown },
  ): RateLimitRecord {
    const now = typeof context?.timestamp === 'number' ? context.timestamp : Date.now();
    const isoTime = new Date(now).toISOString();
    const errorMsg = extractErrorMessage(error);
    const cooldownMs = context?.cooldownMs ?? this.defaultCooldownMs;

    this.paused = true;
    this.pauseReason = `429 Rate Limit: ${errorMsg}`;
    this.pauseTimestamp = now;
    this.currentCooldownMs = cooldownMs;

    const record: RateLimitRecord = {
      timestamp: now,
      isoTime,
      error: errorMsg,
      milestoneId: context?.milestoneId,
      cooldownMs,
      context,
    };

    this.records.push(record);
    return record;
  }

  public isPaused(): boolean {
    return this.paused;
  }

  public getPauseReason(): string | undefined {
    return this.pauseReason;
  }

  public getPauseTimestamp(): number | undefined {
    return this.pauseTimestamp;
  }

  /**
   * Checks whether the cooldown period has elapsed and execution can safely resume.
   */
  public canResume(now: number = Date.now()): boolean {
    if (!this.paused) return true;
    if (!this.pauseTimestamp) return true;
    return now - this.pauseTimestamp >= this.currentCooldownMs;
  }

  /**
   * Returns remaining milliseconds to wait before resuming, or 0 if ready.
   */
  public getWaitRecommendation(now: number = Date.now()): number {
    if (!this.paused || !this.pauseTimestamp) return 0;
    const elapsed = now - this.pauseTimestamp;
    const remaining = this.currentCooldownMs - elapsed;
    return Math.max(0, remaining);
  }

  /**
   * Resumes execution after rate limit condition has subsided.
   */
  public resume(): void {
    this.paused = false;
    this.pauseReason = undefined;
    this.pauseTimestamp = undefined;
  }

  /**
   * Clears state and all history records.
   */
  public reset(): void {
    this.resume();
    this.records.length = 0;
  }

  public getHistory(): RateLimitRecord[] {
    return [...this.records];
  }

  public getRecordCount(): number {
    return this.records.length;
  }
}
