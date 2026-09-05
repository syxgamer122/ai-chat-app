/**
 * Comprehensive Unit Test Suite for Rate Limit & 429 Handling (Milestone 3).
 * Conforms strictly to ORIGINAL_REQUEST.md R3, PROJECT.md, and .opencode/agents/teamwork-orchestrator.md.
 *
 * Covers:
 * 1. 429 Error Detection (isRateLimitError):
 *    - Direct number status (429).
 *    - Objects with status, statusCode, code, response.status, cause.status.
 *    - Error text / messages with rate limit, overload, quota, or TPM keywords.
 *    - Error status restatement integration via @/lib/upstream-status-rules (e.g. 500/502/403 with quota/rate-limit body).
 *    - Non-429 errors (TypeError, 404, generic 500, network error) correctly rejected.
 * 2. Safe Halt & Lifecycle Stoppage (handleRateLimit):
 *    - Immediate execution halt without retry spam.
 *    - Updates teamwork/PROGRESS.md rateLimitStatus to BLOCKED_429.
 *    - Sets rateLimitNote and records timestamp.
 *    - Transitions active milestone status to 'blocked'.
 *    - Invokes onHalt callback.
 *    - Gracefully handles missing or existing PROGRESS.md files.
 * 3. RateLimitManager State & Cooldown Helper:
 *    - Records incidents with timestamps and context.
 *    - Manages paused state and pause reasons.
 *    - Calculates canResume and wait recommendations.
 *    - Resumes and resets cleanly.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseProgressMd,
  writeTeamworkArtifacts,
} from '@/lib/teamwork/artifacts';
import {
  handleRateLimit,
  isRateLimitError,
  RateLimitManager,
} from '@/lib/teamwork/rate-limit';

describe('Teamwork Rate Limit & Overload Protection', () => {
  describe('isRateLimitError', () => {
    it('detects numeric 429 status code', () => {
      expect(isRateLimitError(429)).toBe(true);
      expect(isRateLimitError(200)).toBe(false);
      expect(isRateLimitError(500)).toBe(false);
      expect(isRateLimitError(404)).toBe(false);
    });

    it('detects error objects with status or statusCode === 429', () => {
      expect(isRateLimitError({ status: 429 })).toBe(true);
      expect(isRateLimitError({ statusCode: 429 })).toBe(true);
      expect(isRateLimitError({ code: 429 })).toBe(true);
      expect(isRateLimitError({ code: '429' })).toBe(true);
      expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
      expect(isRateLimitError({ cause: { status: 429 } })).toBe(true);
    });

    it('detects rate limit and quota string messages', () => {
      expect(isRateLimitError('Error: Rate limit exceeded. Please try again in 20s.')).toBe(true);
      expect(isRateLimitError('Too Many Requests: 429 quota exhausted')).toBe(true);
      expect(isRateLimitError('LLM provider is currently overloaded')).toBe(true);
      expect(isRateLimitError('insufficient_quota: you exceeded your current quota')).toBe(true);
      expect(isRateLimitError('Tokens per minute (TPM) limit reached')).toBe(true);
      expect(isRateLimitError('Resource exhausted: capacity exceeded')).toBe(true);
      expect(isRateLimitError('请求频率过高')).toBe(true);
      expect(isRateLimitError('额度不足')).toBe(true);
    });

    it('detects rate-limit error code constants on Error instances', () => {
      const err1 = new Error('Request throttled');
      (err1 as unknown as { code: string }).code = 'rate_limit_exceeded';
      expect(isRateLimitError(err1)).toBe(true);

      const err2 = new Error('Quota issue');
      (err2 as unknown as { code: string }).code = 'insufficient_quota';
      expect(isRateLimitError(err2)).toBe(true);
    });

    it('integrates upstream status restatement: mislabeled 500 with rate-limit body becomes 429', () => {
      // Gateway returned 500 but body clearly stated rate limit
      const mislabeledError = {
        status: 500,
        message: 'Internal server error: rate limit exceeded for model gpt-4o',
      };
      expect(isRateLimitError(mislabeledError)).toBe(true);
    });

    it('integrates upstream status restatement: mislabeled 403 with quota body becomes 429', () => {
      // Free gateway returned 403 with insufficient quota
      const quotaError = {
        status: 403,
        message: 'Forbidden: insufficient balance / quota exhausted',
      };
      expect(isRateLimitError(quotaError)).toBe(true);
    });

    it('returns false for standard non-rate-limit errors', () => {
      expect(isRateLimitError(null)).toBe(false);
      expect(isRateLimitError(undefined)).toBe(false);
      expect(isRateLimitError(new TypeError('Cannot read property of undefined'))).toBe(false);
      expect(isRateLimitError(new Error('ENOENT: no such file or directory'))).toBe(false);
      expect(isRateLimitError({ status: 404, message: 'Not found' })).toBe(false);
      expect(isRateLimitError({ status: 500, message: 'Database query timeout' })).toBe(false);
    });
  });

  describe('handleRateLimit', () => {
    let workspaceRoot: string;

    beforeEach(async () => {
      workspaceRoot = path.resolve(os.tmpdir(), `teamwork-ratelimit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await fs.mkdir(workspaceRoot, { recursive: true });
    });

    it('halts execution immediately and invokes onHalt callback', async () => {
      const onHalt = vi.fn();
      const error = new Error('Rate limit exceeded: 429 too many requests');

      const result = await handleRateLimit(error, {
        workspaceRoot,
        milestoneId: 'M2',
        onHalt,
      });

      expect(result.halted).toBe(true);
      expect(result.status).toBe('BLOCKED_429');
      expect(result.milestoneId).toBe('M2');
      expect(result.cooldownMs).toBe(60_000);
      expect(onHalt).toHaveBeenCalledTimes(1);
    });

    it('updates teamwork/PROGRESS.md status to BLOCKED_429 and records timestamp', async () => {
      // Pre-seed a progress board
      const initialProgress = `# Progress: Test Run

## Bảng trạng thái Milestone
| Milestone | Worker | Trạng thái | File sở hữu | Critic Verdict | Lần thử | Ghi chú |
|---|---|---|---|---|---|---|
| M1: Setup | worker | done | file1.ts | PASS | 1/2 | Finished |
| M2: Core | worker | doing | file2.ts | pending | 1/2 | Running |

## Trạng thái Rate Limit & Hệ thống
- Status: HEALTHY
- Lần cập nhật cuối: 2026-09-03T10:00:00.000Z
- Ghi chú 429: None

## Nhật ký thực thi chi tiết
*Chưa có nhật ký thực thi.*

## Thống kê File thay đổi
*Chưa có file thay đổi.*
`;
      await writeTeamworkArtifacts(workspaceRoot, { progressMd: initialProgress });

      const err = { status: 429, message: 'TPM quota reached on OpenAI API' };
      const result = await handleRateLimit(err, {
        workspaceRoot,
        milestoneId: 'M2',
        note: 'Paused on OpenAI TPM limit. Waiting for user instruction.',
      });

      expect(result.halted).toBe(true);

      // Read back persisted PROGRESS.md
      const progressPath = path.join(workspaceRoot, 'teamwork', 'PROGRESS.md');
      const updatedContent = await fs.readFile(progressPath, 'utf8');
      const state = parseProgressMd(updatedContent);

      expect(state.rateLimitStatus).toBe('BLOCKED_429');
      expect(state.rateLimitNote).toContain('Paused on OpenAI TPM limit');

      // Milestone M2 should be updated to blocked
      const m2 = state.milestones.find((m) => m.milestoneId === 'M2');
      expect(m2).toBeDefined();
      expect(m2?.status).toBe('blocked');

      // Execution log should record rate limit halt
      const lastLog = state.executionLogs[state.executionLogs.length - 1];
      expect(lastLog.action).toBe('rate_limit_halt');
      expect(lastLog.agent).toBe('orchestrator');
    });

    it('creates fresh PROGRESS.md if none existed prior to rate limit halt', async () => {
      const err = new Error('HTTP 429 Too Many Requests');
      const result = await handleRateLimit(err, {
        workspaceRoot,
        note: 'Immediate stoppage on rate limit',
      });

      expect(result.halted).toBe(true);
      const progressPath = path.join(workspaceRoot, 'teamwork', 'PROGRESS.md');
      const content = await fs.readFile(progressPath, 'utf8');
      expect(content).toContain('Status: BLOCKED_429');
      expect(content).toContain('Immediate stoppage on rate limit');
    });
  });

  describe('RateLimitManager Helper', () => {
    let manager: RateLimitManager;

    beforeEach(() => {
      manager = new RateLimitManager({ defaultCooldownMs: 10_000 });
    });

    it('starts unpaused with empty history', () => {
      expect(manager.isPaused()).toBe(false);
      expect(manager.getPauseReason()).toBeUndefined();
      expect(manager.getRecordCount()).toBe(0);
      expect(manager.canResume()).toBe(true);
      expect(manager.getWaitRecommendation()).toBe(0);
    });

    it('records rate limit incident and transitions to paused state', () => {
      const record = manager.recordRateLimit('HTTP 429: Too Many Requests', {
        milestoneId: 'M1',
        model: 'gpt-4o',
      });

      expect(manager.isPaused()).toBe(true);
      expect(manager.getPauseReason()).toContain('429 Rate Limit');
      expect(manager.getRecordCount()).toBe(1);
      expect(record.error).toContain('Too Many Requests');
      expect(record.milestoneId).toBe('M1');
    });

    it('manages cooldown timer accurately', () => {
      const startTime = 1_000_000;
      manager.recordRateLimit('Throttled', { timestamp: startTime, cooldownMs: 5_000 });

      // Before cooldown elapses
      const midTime = startTime + 2_000;
      const canResumeMid = manager.canResume(midTime);
      expect(canResumeMid).toBe(false);

      // After cooldown elapses
      const postTime = startTime + 10_000;
      const canResumePost = manager.canResume(postTime);
      expect(canResumePost).toBe(true);
    });

    it('resumes and resets state cleanly', () => {
      manager.recordRateLimit('429');
      expect(manager.isPaused()).toBe(true);

      manager.resume();
      expect(manager.isPaused()).toBe(false);
      expect(manager.getPauseReason()).toBeUndefined();
      expect(manager.getRecordCount()).toBe(1); // history preserved

      manager.reset();
      expect(manager.isPaused()).toBe(false);
      expect(manager.getRecordCount()).toBe(0); // history cleared
    });
  });
});
