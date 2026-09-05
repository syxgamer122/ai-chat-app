/**
 * Teamwork Engine Unit & Integration Test Suite.
 * Conforms strictly to ORIGINAL_REQUEST.md, PROJECT.md, and .opencode/commands/teamwork.md.
 *
 * Tests:
 * 1. Phase 1 Triad Generation & 4-Element Validation (REQUEST.md, PLAN.md, PROGRESS.md).
 * 2. Phase 1 Pause Gate & Approval (zero source code modifications before approval).
 * 3. Exclusive File Locking & Concurrency Cap (max 2 parallel workers, disjoint sets only).
 * 4. Adversarial Critic PASS requirement for marking milestone done, bounded retry (<= 1 retry).
 * 5. Rate-limit 429 safe halt & PROGRESS.md logging (no retry spam, BLOCKED_429 state).
 * 6. Compact summary generation (strictly <= 20 lines) linking to teamwork/PROGRESS.md.
 * 7. Headless CLI Runner arguments, dry-run, and execution semantics.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parsePlanMd,
  parseProgressMd,
  parseRequestMd,
  readTeamworkArtifacts,
} from '@/lib/teamwork/artifacts';
import { runCli } from '@/lib/teamwork/cli';
import {
  TeamworkEngine,
  TeamworkGoalInput,
  validateFourElements,
} from '@/lib/teamwork/engine';
import { FileLockManager } from '@/lib/teamwork/file-lock';
import { generateCompletionSummary } from '@/lib/teamwork/summary';
import { HeadlessToolRunner } from '@/lib/teamwork/tools';
import { CriticResult, Milestone } from '@/lib/teamwork/types';

describe('TeamworkEngine Test Suite', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vyen-teamwork-engine-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore temporary directory cleanup failures
    }
  });

  describe('1. Phase 1 Triad Generation & 4-Element Validation', () => {
    it('validates 4-element check (purpose, file scope, testable criteria, working directory)', () => {
      // All 4 present
      const valid = validateFourElements({
        purpose: 'Add search feature',
        files: ['lib/search.ts'],
        acceptanceCriteria: [{ description: 'Search works', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
      });
      expect(valid.valid).toBe(true);
      expect(valid.missingElements).toHaveLength(0);

      // Missing purpose
      const noPurpose = validateFourElements({
        files: ['lib/search.ts'],
        acceptanceCriteria: [{ description: 'Test', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
      });
      expect(noPurpose.valid).toBe(false);
      expect(noPurpose.missingElements).toContain('Mục đích (Purpose)');

      // Missing files
      const noFiles = validateFourElements({
        purpose: 'Add search feature',
        files: [],
        acceptanceCriteria: [{ description: 'Test', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
      });
      expect(noFiles.valid).toBe(false);
      expect(noFiles.missingElements).toContain('Phạm vi file (Target File Scope)');

      // Missing acceptance criteria
      const noCriteria = validateFourElements({
        purpose: 'Add search feature',
        files: ['lib/search.ts'],
        acceptanceCriteria: [],
        workingDirectory: tmpDir,
      });
      expect(noCriteria.valid).toBe(false);
      expect(noCriteria.missingElements).toContain('Tiêu chí nghiệm thu test được (Testable Acceptance Criteria)');

      // Missing working directory
      const noWd = validateFourElements({
        purpose: 'Add search feature',
        files: ['lib/search.ts'],
        acceptanceCriteria: [{ description: 'Test', verifyCommand: 'npm test' }],
        workingDirectory: '',
      });
      expect(noWd.valid).toBe(false);
      expect(noWd.missingElements).toContain('Thư mục làm việc (Working Directory)');
    });

    it('generates teamwork/REQUEST.md, teamwork/PLAN.md, and teamwork/PROGRESS.md on Phase 1', async () => {
      const engine = new TeamworkEngine({
        workspaceRoot: tmpDir,
        confirmPrompt: async () => false, // Pause and stop at gate
      });

      const goal: TeamworkGoalInput = {
        purpose: 'Build payment gateway integration',
        files: ['lib/payment.ts', 'tests/payment.test.ts'],
        acceptanceCriteria: [
          { description: 'Processes card charge', verifyCommand: 'npm test tests/payment.test.ts' },
        ],
        workingDirectory: tmpDir,
        milestones: [
          {
            id: 'M1',
            title: 'Payment Gateway Client',
            goal: 'Implement payment client',
            ownedFiles: ['lib/payment.ts'],
            verifyCommand: 'npm test tests/payment.test.ts',
          },
        ],
      };

      const result = await engine.run(goal);
      expect(result.status).toBe('FAILED'); // Because confirmation was false

      // Verify triad files exist on disk
      const artifacts = await readTeamworkArtifacts(tmpDir);
      expect(artifacts.requestMd).toBeDefined();
      expect(artifacts.planMd).toBeDefined();
      expect(artifacts.progressMd).toBeDefined();

      // Check parsed REQUEST.md
      const req = parseRequestMd(artifacts.requestMd!);
      expect(req.title).toBe('Build payment gateway integration');
      expect(req.acceptanceCriteria).toHaveLength(1);
      expect(req.acceptanceCriteria[0].verifyCommand).toBe('npm test tests/payment.test.ts');

      // Check parsed PLAN.md
      const plan = parsePlanMd(artifacts.planMd!);
      expect(plan.milestones).toHaveLength(1);
      expect(plan.milestones[0].id).toBe('M1');
      expect(plan.milestones[0].ownedFiles).toContain('lib/payment.ts');

      // Check parsed PROGRESS.md
      const progress = parseProgressMd(artifacts.progressMd!);
      expect(progress.rateLimitStatus).toBe('HEALTHY');
      expect(progress.milestones).toHaveLength(1);
    });
  });

  describe('2. Phase 1 Pause Gate & Approval', () => {
    it('halts and awaits user approval; touches zero source files if rejected', async () => {
      let workerCalled = false;
      const engine = new TeamworkEngine({
        workspaceRoot: tmpDir,
        confirmPrompt: async () => false, // User rejects plan
        workerExecutor: async () => {
          workerCalled = true;
          return { filesTouched: ['lib/auth.ts'] };
        },
      });

      const goal: TeamworkGoalInput = {
        purpose: 'Add authentication',
        files: ['lib/auth.ts'],
        acceptanceCriteria: [{ description: 'JWT auth works', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
      };

      const result = await engine.run(goal);
      expect(result.status).toBe('FAILED');
      expect(result.changedFiles).toHaveLength(0);
      expect(workerCalled).toBe(false);

      const events = engine.getEvents().map((e) => e.type);
      expect(events).toContain('plan_created');
      expect(events).not.toContain('plan_confirmed');
      expect(events).not.toContain('worker_start');
    });

    it('proceeds to Phase 2 when user approves plan', async () => {
      let workerCalled = false;
      let criticCalled = false;

      const engine = new TeamworkEngine({
        workspaceRoot: tmpDir,
        confirmPrompt: async () => true, // User approves plan
        workerExecutor: async () => {
          workerCalled = true;
          return { filesTouched: ['lib/auth.ts'] };
        },
      });

      // Override critic to return PASS
      (engine.getCritic() as unknown as { verifyMilestone: () => Promise<CriticResult> }).verifyMilestone = async () => {
        criticCalled = true;
        return {
          verdict: 'PASS',
          command: 'npm test',
          exitCode: 0,
          outputPreview: 'All tests passed (1/1)',
          issues: [],
          passCriteriaMet: true,
        };
      };

      const goal: TeamworkGoalInput = {
        purpose: 'Add authentication',
        files: ['lib/auth.ts'],
        acceptanceCriteria: [{ description: 'JWT auth works', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
      };

      const result = await engine.run(goal);
      expect(result.status).toBe('COMPLETED');
      expect(workerCalled).toBe(true);
      expect(criticCalled).toBe(true);

      const events = engine.getEvents().map((e) => e.type);
      expect(events).toContain('plan_created');
      expect(events).toContain('plan_confirmed');
      expect(events).toContain('worker_start');
      expect(events).toContain('critic_start');
      expect(events).toContain('milestone_completed');
    });

    it('handles dry-run option: generates plan and exits cleanly without modifying files', async () => {
      let workerCalled = false;
      const engine = new TeamworkEngine({
        workspaceRoot: tmpDir,
        workerExecutor: async () => {
          workerCalled = true;
          return { filesTouched: ['lib/feature.ts'] };
        },
      });

      const result = await engine.run('Explore codebase architecture', { dryRun: true });
      expect(result.status).toBe('COMPLETED');
      expect(result.changedFiles).toHaveLength(0);
      expect(workerCalled).toBe(false);

      const artifacts = await readTeamworkArtifacts(tmpDir);
      expect(artifacts.planMd).toBeDefined();
    });
  });

  describe('3. Exclusive File Locking & Concurrency Cap', () => {
    it('allows 2 parallel workers on completely disjoint file sets', () => {
      const lockMgr = new FileLockManager({ concurrencyCap: 2, workspaceRoot: tmpDir });

      expect(lockMgr.canAcquire('worker-1', ['lib/auth.ts'])).toBe(true);
      lockMgr.acquire('worker-1', ['lib/auth.ts']);

      expect(lockMgr.canAcquire('worker-2', ['lib/payment.ts'])).toBe(true);
      lockMgr.acquire('worker-2', ['lib/payment.ts']);

      expect(lockMgr.getActiveWorkers()).toHaveLength(2);
      expect(lockMgr.isLocked('lib/auth.ts')).toBe(true);
      expect(lockMgr.isLocked('lib/payment.ts')).toBe(true);

      // Third worker blocked by concurrency limit
      expect(lockMgr.canAcquire('worker-3', ['lib/notifications.ts'])).toBe(false);
      expect(() => lockMgr.acquire('worker-3', ['lib/notifications.ts'])).toThrow(/Concurrency limit reached/);

      lockMgr.release('worker-1');
      expect(lockMgr.isLocked('lib/auth.ts')).toBe(false);
      expect(lockMgr.canAcquire('worker-3', ['lib/notifications.ts'])).toBe(true);
    });

    it('rejects parallel execution when workers touch overlapping files', () => {
      const lockMgr = new FileLockManager({ concurrencyCap: 2, workspaceRoot: tmpDir });

      lockMgr.acquire('worker-1', ['lib/shared.ts', 'lib/a.ts']);
      expect(lockMgr.canAcquire('worker-2', ['lib/shared.ts'])).toBe(false);
      expect(() => lockMgr.acquire('worker-2', ['lib/shared.ts'])).toThrow(/File lock conflict/);
    });

    it('throws ownership violation when worker touches undeclared file', async () => {
      const engine = new TeamworkEngine({
        workspaceRoot: tmpDir,
        confirmPrompt: async () => true,
        workerExecutor: async () => {
          // Attempting to modify undeclared file
          return { filesTouched: ['lib/secret.ts'] };
        },
      });

      const goal: TeamworkGoalInput = {
        purpose: 'Restricted worker test',
        files: ['lib/allowed.ts'],
        acceptanceCriteria: [{ description: 'Test', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
      };

      await expect(engine.run(goal)).rejects.toThrow(/Ownership violation/);
    });

    it('executes up to 2 independent milestones concurrently when files are completely disjoint', async () => {
      let activeWorkersCount = 0;
      let maxActiveWorkers = 0;
      const executionTimes: Record<string, { start: number; end: number }> = {};

      const engine = new TeamworkEngine({
        workspaceRoot: tmpDir,
        concurrencyCap: 2,
        confirmPrompt: async () => true,
        workerExecutor: async (milestone) => {
          activeWorkersCount++;
          if (activeWorkersCount > maxActiveWorkers) {
            maxActiveWorkers = activeWorkersCount;
          }
          const start = Date.now();
          await new Promise((r) => setTimeout(r, 40));
          const end = Date.now();
          executionTimes[milestone.id] = { start, end };
          activeWorkersCount--;
          return { filesTouched: milestone.ownedFiles };
        },
      });

      (engine.getCritic() as unknown as { verifyMilestone: () => Promise<CriticResult> }).verifyMilestone = async () => ({
        verdict: 'PASS',
        command: 'npm test',
        exitCode: 0,
        outputPreview: 'Pass',
        issues: [],
        passCriteriaMet: true,
      });

      const goal: TeamworkGoalInput = {
        purpose: 'Concurrent independent milestones',
        files: ['lib/modA.ts', 'lib/modB.ts'],
        acceptanceCriteria: [{ description: 'Test', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
        milestones: [
          {
            id: 'M1',
            title: 'Task A',
            ownedFiles: ['lib/modA.ts'],
            verifyCommand: 'npm test',
            dependsOn: 'None',
          },
          {
            id: 'M2',
            title: 'Task B',
            ownedFiles: ['lib/modB.ts'],
            verifyCommand: 'npm test',
            dependsOn: 'None',
          },
        ],
      };

      const result = await engine.run(goal);
      expect(result.status).toBe('COMPLETED');
      expect(result.milestones).toHaveLength(2);
      expect(result.milestones.map((m) => m.status)).toEqual(['done', 'done']);
      // Verified concurrent execution: 2 workers active simultaneously
      expect(maxActiveWorkers).toBe(2);
    });

    it('serializes dependent milestones even when file scopes are disjoint', async () => {
      let activeWorkersCount = 0;
      let maxActiveWorkers = 0;
      const executionOrder: string[] = [];

      const engine = new TeamworkEngine({
        workspaceRoot: tmpDir,
        concurrencyCap: 2,
        confirmPrompt: async () => true,
        workerExecutor: async (milestone) => {
          activeWorkersCount++;
          if (activeWorkersCount > maxActiveWorkers) {
            maxActiveWorkers = activeWorkersCount;
          }
          executionOrder.push(`${milestone.id}-start`);
          await new Promise((r) => setTimeout(r, 30));
          executionOrder.push(`${milestone.id}-end`);
          activeWorkersCount--;
          return { filesTouched: milestone.ownedFiles };
        },
      });

      (engine.getCritic() as unknown as { verifyMilestone: () => Promise<CriticResult> }).verifyMilestone = async () => ({
        verdict: 'PASS',
        command: 'npm test',
        exitCode: 0,
        outputPreview: 'Pass',
        issues: [],
        passCriteriaMet: true,
      });

      const goal: TeamworkGoalInput = {
        purpose: 'Dependent milestones',
        files: ['lib/step1.ts', 'lib/step2.ts'],
        acceptanceCriteria: [{ description: 'Test', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
        milestones: [
          {
            id: 'M1',
            title: 'Step 1',
            ownedFiles: ['lib/step1.ts'],
            verifyCommand: 'npm test',
            dependsOn: 'None',
          },
          {
            id: 'M2',
            title: 'Step 2',
            ownedFiles: ['lib/step2.ts'],
            verifyCommand: 'npm test',
            dependsOn: 'M1',
          },
        ],
      };

      const result = await engine.run(goal);
      expect(result.status).toBe('COMPLETED');
      expect(maxActiveWorkers).toBe(1);
      expect(executionOrder).toEqual(['M1-start', 'M1-end', 'M2-start', 'M2-end']);
    });
  });

  describe('4. Adversarial Critic PASS Requirement & Bounded Retry', () => {
    it('marks milestone done ONLY when Critic returns PASS', async () => {
      let criticAttempts = 0;
      const engine = new TeamworkEngine({
        workspaceRoot: tmpDir,
        confirmPrompt: async () => true,
      });

      (engine.getCritic() as unknown as { verifyMilestone: () => Promise<CriticResult> }).verifyMilestone = async () => {
        criticAttempts++;
        return {
          verdict: 'PASS',
          command: 'npm test',
          exitCode: 0,
          outputPreview: 'Tests passed (5/5)',
          issues: [],
          passCriteriaMet: true,
        };
      };

      const result = await engine.run({
        purpose: 'Verify critic test',
        files: ['lib/test.ts'],
        acceptanceCriteria: [{ description: 'Test', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
      });

      expect(result.status).toBe('COMPLETED');
      expect(criticAttempts).toBe(1);
      expect(result.milestones[0].status).toBe('done');
      expect(result.milestones[0].criticVerdict).toBe('PASS');
    });

    it('retries milestone once upon Critic FAIL-BLOCKED and succeeds on attempt 2', async () => {
      let criticCalls = 0;
      let workerCalls = 0;

      const engine = new TeamworkEngine({
        workspaceRoot: tmpDir,
        confirmPrompt: async () => true,
        workerExecutor: async (m, attempt, tools, feedback) => {
          workerCalls++;
          if (attempt === 2) {
            expect(feedback).toContain('Fix failing assertion');
          }
          return { filesTouched: ['lib/calc.ts'] };
        },
      });

      (engine.getCritic() as unknown as { verifyMilestone: () => Promise<CriticResult> }).verifyMilestone = async () => {
        criticCalls++;
        if (criticCalls === 1) {
          return {
            verdict: 'FAIL-BLOCKED',
            command: 'npm test',
            exitCode: 1,
            outputPreview: 'AssertionError: expected 2 to be 4',
            issues: [
              {
                severity: 'blocker',
                fileLocation: 'lib/calc.ts:10',
                description: 'Fix failing assertion',
              },
            ],
            passCriteriaMet: false,
            remediation: 'Fix failing assertion in lib/calc.ts:10',
          };
        }
        return {
          verdict: 'PASS',
          command: 'npm test',
          exitCode: 0,
          outputPreview: 'All tests passed (2/2)',
          issues: [],
          passCriteriaMet: true,
        };
      };

      const result = await engine.run({
        purpose: 'Retry test',
        files: ['lib/calc.ts'],
        acceptanceCriteria: [{ description: 'Test', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
      });

      expect(result.status).toBe('COMPLETED');
      expect(workerCalls).toBe(2);
      expect(criticCalls).toBe(2);
      expect(result.milestones[0].status).toBe('done');
      expect(result.milestones[0].retryCount).toBe(2);

      const events = engine.getEvents().map((e) => e.type);
      expect(events).toContain('milestone_retry');
      expect(events).toContain('milestone_completed');
    });

    it('marks milestone failed and halts workflow when retry also fails', async () => {
      let criticCalls = 0;
      const engine = new TeamworkEngine({
        workspaceRoot: tmpDir,
        confirmPrompt: async () => true,
        workerExecutor: async () => ({ filesTouched: ['lib/broken.ts'] }),
      });

      (engine.getCritic() as unknown as { verifyMilestone: () => Promise<CriticResult> }).verifyMilestone = async () => {
        criticCalls++;
        return {
          verdict: 'FAIL-BLOCKED',
          command: 'npm test',
          exitCode: 1,
          outputPreview: 'Persistent failure',
          issues: [{ severity: 'blocker', fileLocation: 'lib/broken.ts', description: 'Error' }],
          passCriteriaMet: false,
        };
      };

      const result = await engine.run({
        purpose: 'Failing milestone',
        files: ['lib/broken.ts'],
        acceptanceCriteria: [{ description: 'Test', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
      });

      expect(result.status).toBe('FAILED');
      expect(criticCalls).toBe(2); // Attempt 1 + 1 retry = 2 total attempts
      expect(result.milestones[0].status).toBe('failed');
      expect(result.milestones[0].criticVerdict).toBe('FAIL-BLOCKED');

      const events = engine.getEvents().map((e) => e.type);
      expect(events).toContain('milestone_failed');
    });
  });

  describe('5. Rate-Limit 429 Safe Halt & PROGRESS.md Logging', () => {
    it('halts immediately upon HTTP 429 error and updates PROGRESS.md to BLOCKED_429', async () => {
      let workerCalls = 0;
      const engine = new TeamworkEngine({
        workspaceRoot: tmpDir,
        confirmPrompt: async () => true,
        workerExecutor: async () => {
          workerCalls++;
          const err = new Error('HTTP 429: Too Many Requests. Rate limit exceeded.');
          (err as unknown as { status: number }).status = 429;
          throw err;
        },
      });

      const result = await engine.run({
        purpose: 'Rate limit test',
        files: ['lib/data.ts'],
        acceptanceCriteria: [{ description: 'Test', verifyCommand: 'npm test' }],
        workingDirectory: tmpDir,
      });

      expect(result.status).toBe('BLOCKED_429');
      expect(workerCalls).toBe(1); // No retry spam!

      const events = engine.getEvents().map((e) => e.type);
      expect(events).toContain('rate_limit_paused');

      // Verify PROGRESS.md was updated to BLOCKED_429
      const artifacts = await readTeamworkArtifacts(tmpDir);
      expect(artifacts.progressMd).toBeDefined();
      const progress = parseProgressMd(artifacts.progressMd!);
      expect(progress.rateLimitStatus).toBe('BLOCKED_429');
    });
  });

  describe('6. Compact Summary Generation (<= 20 Lines)', () => {
    it('generates summary strictly <= 20 lines linking to PROGRESS.md across all states', () => {
      const milestones: Milestone[] = [
        {
          id: 'M1',
          title: 'Database Schema',
          goal: 'Setup tables',
          ownedFiles: ['lib/db.ts'],
          verifyCommand: 'npm test tests/db.test.ts',
          status: 'done',
          criticVerdict: 'PASS',
          retryCount: 1,
        },
        {
          id: 'M2',
          title: 'API Routes',
          goal: 'Add REST endpoints',
          ownedFiles: ['lib/api.ts'],
          verifyCommand: 'npm test tests/api.test.ts',
          status: 'done',
          criticVerdict: 'PASS',
          retryCount: 1,
        },
      ];

      const summaryCompleted = generateCompletionSummary({
        status: 'COMPLETED',
        milestones,
        changedFiles: ['lib/db.ts', 'lib/api.ts'],
        testResults: [
          { command: 'npm test tests/db.test.ts', exitCode: 0, verdict: 'PASS' },
          { command: 'npm test tests/api.test.ts', exitCode: 0, verdict: 'PASS' },
        ],
        progressFilePath: 'teamwork/PROGRESS.md',
      });

      const linesCompleted = summaryCompleted.split(/\r?\n/);
      expect(linesCompleted.length).toBeLessThanOrEqual(20);
      expect(summaryCompleted).toContain('teamwork/PROGRESS.md');
      expect(summaryCompleted).toContain('COMPLETED');

      // Test BLOCKED_429
      const summaryBlocked = generateCompletionSummary({
        status: 'BLOCKED_429',
        milestones,
        changedFiles: ['lib/db.ts'],
        testResults: [],
        progressFilePath: 'teamwork/PROGRESS.md',
        blockReason: 'HTTP 429 Too Many Requests',
      });
      expect(summaryBlocked.split(/\r?\n/).length).toBeLessThanOrEqual(20);
      expect(summaryBlocked).toContain('BLOCKED_429');

      // Test FAILED
      const summaryFailed = generateCompletionSummary({
        status: 'FAILED',
        milestones,
        changedFiles: [],
        testResults: [],
        progressFilePath: 'teamwork/PROGRESS.md',
        blockReason: 'Milestone 2 failed Critic verification',
      });
      expect(summaryFailed.split(/\r?\n/).length).toBeLessThanOrEqual(20);
      expect(summaryFailed).toContain('FAILED');
    });
  });

  describe('7. Headless CLI Runner Execution', () => {
    it('handles --help and returns exit code 0', async () => {
      const res = await runCli(['--help'], { workspaceRoot: tmpDir });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Usage: teamwork-cli');
      expect(res.stderr).toBe('');
    });

    it('handles --version and returns exit code 0', async () => {
      const res = await runCli(['--version'], { workspaceRoot: tmpDir });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('teamwork-cli v1.0.0');
      expect(res.stderr).toBe('');
    });

    it('returns exit code 1 when required --goal argument is omitted', async () => {
      const res = await runCli(['--auto-approve'], { workspaceRoot: tmpDir });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('Missing required goal');
    });

    it('runs --dry-run cleanly and exits with code 0', async () => {
      const res = await runCli(['--goal', 'Plan architecture update', '--dry-run'], {
        workspaceRoot: tmpDir,
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('[Dry Run] Planning phase complete');
      expect(res.stderr).toBe('');
    });

    it('returns exit code 1 when user rejects plan at pause gate', async () => {
      const res = await runCli(['--goal', 'Refactor auth'], {
        workspaceRoot: tmpDir,
        userConfirm: false,
      });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('User rejected the proposed plan');
    });
  });
});
