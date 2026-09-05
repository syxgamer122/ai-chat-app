/**
 * Comprehensive Unit Test Suite for Completion Summary Generator (Milestone 3).
 * Conforms strictly to ORIGINAL_REQUEST.md R3, PROJECT.md, and .opencode/commands/teamwork.md.
 *
 * Covers:
 * 1. Strict Line Count Invariant (<= 20 lines):
 *    - Empty run summary <= 20 lines.
 *    - Standard 3-milestone run summary <= 20 lines.
 *    - Extreme stress run (20 milestones, 60 files, 25 test commands) strictly <= 20 lines.
 * 2. Mandatory Content Verification:
 *    - Execution status (COMPLETED, BLOCKED_429, FAILED).
 *    - Milestones completed vs blocked.
 *    - Modified files with diff stats (+/- lines).
 *    - Real verification commands and exit codes.
 *    - Direct reference / link to teamwork/PROGRESS.md.
 * 3. Versatile Input Handling:
 *    - Accepts Milestone[] and ProgressMilestoneRow[].
 *    - Accepts string[] and FileChangeStat[] for changed files.
 *    - Accepts VerificationSummaryItem[] and string for test results.
 */

import { describe, expect, it } from 'vitest';

import {
  generateCompletionSummary,
  SummaryOptions,
} from '@/lib/teamwork/summary';
import { FileChangeStat, Milestone } from '@/lib/teamwork/types';

describe('Teamwork Completion Summary Generator', () => {
  describe('Strict Line Count Constraint (<= 20 lines)', () => {
    it('produces summary <= 20 lines for minimal/empty input', () => {
      const summary = generateCompletionSummary({
        status: 'COMPLETED',
      });

      const lineCount = summary.split('\n').length;
      expect(lineCount).toBeLessThanOrEqual(20);
      expect(summary).toContain('Status: COMPLETED');
      expect(summary).toContain('teamwork/PROGRESS.md');
    });

    it('produces summary <= 20 lines for standard 3-milestone run', () => {
      const milestones: Milestone[] = [
        {
          id: 'M1',
          title: 'Data Models',
          goal: 'Setup types and locks',
          ownedFiles: ['lib/teamwork/types.ts', 'lib/teamwork/file-lock.ts'],
          verifyCommand: 'npm test tests/teamwork-file-lock.test.ts',
          status: 'done',
          criticVerdict: 'PASS',
          retryCount: 0,
        },
        {
          id: 'M2',
          title: 'Headless Tools',
          goal: 'Implement tools',
          ownedFiles: ['lib/teamwork/tools.ts'],
          verifyCommand: 'npm test tests/teamwork-tools.test.ts',
          status: 'done',
          criticVerdict: 'PASS',
          retryCount: 0,
        },
        {
          id: 'M3',
          title: 'Critic & Rate Limit',
          goal: 'Implement critic and 429',
          ownedFiles: ['lib/teamwork/critic.ts', 'lib/teamwork/rate-limit.ts'],
          verifyCommand: 'npm test tests/teamwork-critic.test.ts',
          status: 'done',
          criticVerdict: 'PASS',
          retryCount: 0,
        },
      ];

      const changedFiles: FileChangeStat[] = [
        { file: 'lib/teamwork/types.ts', additions: 120, deletions: 10 },
        { file: 'lib/teamwork/file-lock.ts', additions: 85, deletions: 5 },
        { file: 'lib/teamwork/tools.ts', additions: 250, deletions: 20 },
        { file: 'lib/teamwork/critic.ts', additions: 180, deletions: 0 },
        { file: 'lib/teamwork/rate-limit.ts', additions: 140, deletions: 0 },
      ];

      const testResults = [
        { command: 'npm test tests/teamwork-file-lock.test.ts', exitCode: 0, verdict: 'PASS', passed: 8, failed: 0 },
        { command: 'npm test tests/teamwork-tools.test.ts', exitCode: 0, verdict: 'PASS', passed: 14, failed: 0 },
        { command: 'npm test tests/teamwork-critic.test.ts', exitCode: 0, verdict: 'PASS', passed: 10, failed: 0 },
      ];

      const summary = generateCompletionSummary({
        status: 'COMPLETED',
        milestones,
        changedFiles,
        testResults,
        durationMs: 45_200,
      });

      const lines = summary.split('\n');
      expect(lines.length).toBeLessThanOrEqual(20);
      expect(summary).toContain('Status: COMPLETED (45.2s)');
      expect(summary).toContain('Milestones (3/3 done)');
      expect(summary).toContain('Changed Files (5)');
      expect(summary).toContain('Full report: teamwork/PROGRESS.md');
    });

    it('guarantees strictly <= 20 lines under extreme massive stress (25 milestones, 60 files, 30 tests)', () => {
      // Create a massive list of milestones, files, and tests that would normally span 100+ lines
      const massiveMilestones = Array.from({ length: 25 }, (_, i) => ({
        id: `M${i + 1}`,
        title: `Feature ${i + 1}`,
        status: i < 15 ? ('done' as const) : ('blocked' as const),
        criticVerdict: i < 15 ? ('PASS' as const) : ('FAIL-BLOCKED' as const),
      }));

      const massiveFiles = Array.from({ length: 60 }, (_, i) => ({
        file: `src/module_${i + 1}/component_${i + 1}.tsx`,
        additions: i * 5 + 1,
        deletions: i * 2,
      }));

      const massiveTests = Array.from({ length: 30 }, (_, i) => ({
        command: `npm test tests/module_${i + 1}.test.ts`,
        exitCode: i < 20 ? 0 : 1,
        verdict: i < 20 ? 'PASS' : 'FAIL',
      }));

      const summary = generateCompletionSummary({
        status: 'BLOCKED_429',
        blockReason: 'OpenAI TPM rate limit exceeded',
        milestones: massiveMilestones,
        changedFiles: massiveFiles,
        testResults: massiveTests,
        progressFilePath: 'teamwork/PROGRESS.md',
      });

      const lines = summary.split('\n');
      expect(lines.length).toBeLessThanOrEqual(20);
      expect(summary).toContain('Status: BLOCKED_429');
      expect(summary).toContain('Reason: OpenAI TPM rate limit exceeded');
      expect(summary).toContain('Full report: teamwork/PROGRESS.md');
    });
  });

  describe('Content Verification & Formatting', () => {
    it('formats file diff stats accurately with +lines / -lines', () => {
      const summary = generateCompletionSummary({
        status: 'COMPLETED',
        changedFiles: [
          { file: 'lib/core.ts', additions: 52, deletions: 12 },
          { file: 'tests/core.test.ts', additions: 80, deletions: 0 },
        ],
      });

      expect(summary).toContain('`lib/core.ts`: +52 / -12');
      expect(summary).toContain('`tests/core.test.ts`: +80 / -0');
    });

    it('supports string paths for changed files gracefully', () => {
      const summary = generateCompletionSummary({
        status: 'COMPLETED',
        changedFiles: ['lib/auth.ts', 'lib/token.ts'],
      });

      expect(summary).toContain('`lib/auth.ts`');
      expect(summary).toContain('`lib/token.ts`');
    });

    it('formats real test verification outcomes with exit codes and verdicts', () => {
      const summary = generateCompletionSummary({
        status: 'COMPLETED',
        testResults: [
          { command: 'npm test tests/critic.test.ts', exitCode: 0, verdict: 'PASS', passed: 12, failed: 0 },
          { command: 'npx tsc --noEmit', exitCode: 0, verdict: 'PASS' },
        ],
      });

      expect(summary).toContain('`npm test tests/critic.test.ts` -> PASS (exit 0) [passed: 12, failed: 0]');
      expect(summary).toContain('`npx tsc --noEmit` -> PASS (exit 0)');
    });

    it('formats custom progressFilePath when provided', () => {
      const summary = generateCompletionSummary({
        status: 'COMPLETED',
        progressFilePath: 'custom/dir/PROGRESS.md',
      });

      expect(summary).toContain('Full report: custom/dir/PROGRESS.md');
    });

    it('formats blocked rate-limit stoppage summary accurately', () => {
      const summary = generateCompletionSummary({
        status: 'BLOCKED_429',
        blockReason: 'HTTP 429 Too Many Requests: TPM limit reached',
        milestones: [
          { id: 'M1', status: 'done', criticVerdict: 'PASS' },
          { id: 'M2', status: 'blocked', criticVerdict: 'FAIL-BLOCKED' },
        ],
      });

      expect(summary).toContain('### Teamwork Execution Summary: BLOCKED_429');
      expect(summary).toContain('Reason: HTTP 429 Too Many Requests');
      expect(summary).toContain('Milestones (1/2 done)');
      expect(summary).toContain('M2: blocked [Critic: FAIL-BLOCKED]');
      expect(summary.split('\n').length).toBeLessThanOrEqual(20);
    });
  });
});
