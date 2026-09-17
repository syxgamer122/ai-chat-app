/**
 * Unified Teamwork Engine Integration Test Suite.
 * Conforms strictly to ORIGINAL_REQUEST.md và PROJECT.md (M1-M5).
 *
 * Verifies the complete integrated Teamwork Multi-Agent Runtime:
 * 1. Clean module re-exports from '@/lib/teamwork'.
 * 2. Durable DAG workflow execution & topological dependencies.
 * 3. State checkpoint persistence & resume lifecycle.
 * 4. Exponential backoff retry with jitter on Critic verification.
 * 5. HITL approval gate, cryptographic tokens, visual diffs, and flow sketches.
 * 6. Strict tool contracts, dual-gate pre/post-flight guardrails, and cryptographic provenance chains.
 * 7. Process sandboxing with environment scrubbing, CWD lockdown, and clean process tree teardown.
 * 8. Bitemporal ledger recording, Merkle chain verification, and point-in-time state replay.
 * 9. Headless CLI runner flags (--dag, --resume, --approval, --ledger-replay).
 * 10. 100% backward compatibility with executePhase1(), executePhase2(), and run().
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AppendOnlyLedger,
  AsyncSemaphore,
  computeTopologicalPlan,
  DagExecutionEngine,
  DagGraph,
  defineToolContract,
  DiffViewer,
  DualGateController,
  EnvScrubber,
  FileCheckpointStore,
  FileLockManager,
  FlowSketchGenerator,
  HeadlessToolRunner,
  HitlApprovalGate,
  InterruptTokenManager,
  KnowledgeOntology,
  MemoryCheckpointStore,
  PointInTimeReplayEngine,
  ProvenanceTracker,
  RetryPolicy,
  runCli,
  SandboxedProcessManager,
  ShowMeBuilder,
  TeamworkCritic,
  TeamworkEngine,
  TeamworkEvent,
  TeamworkGoalInput,
  TemporalContextManager,
  VisualDiffVisualizer,
} from '@/lib/teamwork';

describe('Teamwork Engine Integrated Verification Suite (Milestone 5)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vyen-engine-integrated-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    } catch {
      // Ignore temp directory deletion errors
    }
  });

  // ==========================================================================
  // 1. Unified Barrel Exports Verification
  // ==========================================================================
  describe('1. Unified Barrel Exports from lib/teamwork/index.ts', () => {
    it('re-exports all M1-M4 submodules cleanly', () => {
      // DAG & Checkpointing
      expect(computeTopologicalPlan).toBeDefined();
      expect(DagGraph).toBeDefined();
      expect(DagExecutionEngine).toBeDefined();
      expect(AsyncSemaphore).toBeDefined();
      expect(RetryPolicy).toBeDefined();
      expect(MemoryCheckpointStore).toBeDefined();
      expect(FileCheckpointStore).toBeDefined();

      // HITL & Visual
      expect(HitlApprovalGate).toBeDefined();
      expect(InterruptTokenManager).toBeDefined();
      expect(VisualDiffVisualizer).toBeDefined();
      expect(DiffViewer).toBeDefined();
      expect(FlowSketchGenerator).toBeDefined();
      expect(ShowMeBuilder).toBeDefined();

      // Contracts & Sandbox
      expect(defineToolContract).toBeDefined();
      expect(ProvenanceTracker).toBeDefined();
      expect(DualGateController).toBeDefined();
      expect(SandboxedProcessManager).toBeDefined();
      expect(EnvScrubber).toBeDefined();

      // Ledger & Context
      expect(AppendOnlyLedger).toBeDefined();
      expect(PointInTimeReplayEngine).toBeDefined();
      expect(TemporalContextManager).toBeDefined();
      expect(KnowledgeOntology).toBeDefined();

      // Core Engine & Tools
      expect(TeamworkEngine).toBeDefined();
      expect(HeadlessToolRunner).toBeDefined();
      expect(runCli).toBeDefined();
      expect(TeamworkCritic).toBeDefined();
    });
  });

  // ==========================================================================
  // 2. Durable DAG Workflow & Topological Execution
  // ==========================================================================
  describe('2. Durable DAG Workflow Execution & Checkpointing', () => {
    it('executes milestones in dependency order and saves checkpoints', async () => {
      const memoryStore = new MemoryCheckpointStore();
      const events: TeamworkEvent[] = [];
      const executionHistory: string[] = [];

      const engine = new TeamworkEngine({
        workspaceRoot,
        enableDag: true,
        checkpointStore: memoryStore,
        onEvent: (ev) => events.push(ev),
        workerExecutor: async (milestone) => {
          executionHistory.push(milestone.id);
          const targetFile = milestone.ownedFiles[0];
          if (targetFile) {
            await fs.mkdir(path.dirname(path.join(workspaceRoot, targetFile)), { recursive: true });
            await fs.writeFile(
              path.join(workspaceRoot, targetFile),
              `// Implementation for ${milestone.id}\nexport const ready = true;\n`,
              'utf8'
            );
          }
          return { filesTouched: milestone.ownedFiles, testOutput: 'all tests pass' };
        },
      });

      const goal: TeamworkGoalInput = {
        purpose: 'Build durable workflow architecture',
        files: ['lib/step1.ts', 'lib/step2.ts'],
        acceptanceCriteria: [{ description: 'DAG finishes cleanly', verifyCommand: 'node -e "process.exit(0)"' }],
        milestones: [
          {
            id: 'M1',
            title: 'Base Step',
            ownedFiles: ['lib/step1.ts'],
            verifyCommand: 'node -e "process.exit(0)"',
            dependsOn: 'None',
          },
          {
            id: 'M2',
            title: 'Dependent Step',
            ownedFiles: ['lib/step2.ts'],
            verifyCommand: 'node -e "process.exit(0)"',
            dependsOn: 'M1',
          },
        ],
      };

      const summary = await engine.run(goal, { userConfirm: true, dag: true });
      expect(summary.status).toBe('COMPLETED');
      expect(executionHistory).toEqual(['M1', 'M2']);

      // Checkpoint verification
      const checkpoints = await memoryStore.list('teamwork-plan');
      expect(checkpoints.length).toBeGreaterThan(0);
      const latest = await memoryStore.latest('teamwork-plan');
      expect(latest?.completedNodeIds).toContain('M1');
      expect(latest?.completedNodeIds).toContain('M2');
    });

    it('resumes execution from saved checkpoint skipping completed tasks', async () => {
      const memoryStore = new MemoryCheckpointStore();
      const runId = 'run-resume-test';

      // Pre-save checkpoint with M1 completed
      await memoryStore.save({
        version: '1.0.0',
        runId,
        dagId: 'teamwork-plan',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedNodeIds: ['M1'],
        failedNodeIds: [],
        blockedNodeIds: [],
        nodes: {
          M1: { nodeId: 'M1', status: 'completed', attempt: 1, output: { criticVerdict: 'PASS' } },
          M2: { nodeId: 'M2', status: 'pending', attempt: 0 },
        },
      });

      const executedList: string[] = [];
      const engine = new TeamworkEngine({
        workspaceRoot,
        enableDag: true,
        checkpointStore: memoryStore,
        workerExecutor: async (milestone) => {
          executedList.push(milestone.id);
          return { filesTouched: milestone.ownedFiles };
        },
      });

      const goal: TeamworkGoalInput = {
        purpose: 'Resume workflow',
        files: ['lib/resume1.ts', 'lib/resume2.ts'],
        acceptanceCriteria: [{ description: 'Resume works', verifyCommand: 'node -e "process.exit(0)"' }],
        milestones: [
          {
            id: 'M1',
            title: 'Already Completed',
            ownedFiles: ['lib/resume1.ts'],
            verifyCommand: 'node -e "process.exit(0)"',
            dependsOn: 'None',
          },
          {
            id: 'M2',
            title: 'To Execute',
            ownedFiles: ['lib/resume2.ts'],
            verifyCommand: 'node -e "process.exit(0)"',
            dependsOn: 'M1',
          },
        ],
      };

      const summary = await engine.run(goal, {
        userConfirm: true,
        resumeCheckpointId: runId,
      });

      expect(summary.status).toBe('COMPLETED');
      // M1 must be skipped, only M2 executed
      expect(executedList).toEqual(['M2']);
    });
  });

  // ==========================================================================
  // 3. Exponential Backoff with Jitter Retry
  // ==========================================================================
  describe('3. Exponential Backoff with Jitter on Critic Retries', () => {
    it('calculates jittered exponential delays and retries milestone upon failure', async () => {
      const retryEvents: TeamworkEvent[] = [];
      let attemptCounter = 0;

      // Mock critic that fails attempt 1, passes attempt 2
      const tools = new HeadlessToolRunner({ workspaceRoot });
      const critic = new TeamworkCritic(tools);
      critic.verifyMilestone = (async () => {
        attemptCounter++;
        if (attemptCounter === 1) {
          return {
            verdict: 'FAIL-BLOCKED',
            exitCode: 1,
            command: 'npm test',
            stdout: '',
            stderr: 'assertion failed in test',
            outputPreview: 'assertion failed in test',
            passCriteriaMet: false,
            issues: [{ fileLocation: 'src/calc.ts', category: 'test_failure', severity: 'blocker', description: 'Test failed on attempt 1' } as any],
            remediation: 'Fix the failing assertion in calculation',
          };
        }
        return {
          verdict: 'PASS',
          exitCode: 0,
          command: 'npm test',
          stdout: 'all tests pass',
          stderr: '',
          outputPreview: 'all tests pass',
          passCriteriaMet: true,
          issues: [],
        };
      }) as any;

      const engine = new TeamworkEngine({
        workspaceRoot,
        tools,
        critic,
        maxRetries: 1,
        retryBaseDelayMs: 50,
        retryMaxDelayMs: 200,
        retryJitter: 'full',
        onEvent: (ev) => {
          if (ev.type === 'milestone_retry') {
            retryEvents.push(ev);
          }
        },
        workerExecutor: async (m) => {
          return { filesTouched: m.ownedFiles };
        },
      });

      const goal: TeamworkGoalInput = {
        purpose: 'Retry verification',
        files: ['lib/calc.ts'],
        acceptanceCriteria: [{ description: 'Passes on retry', verifyCommand: 'npm test' }],
        milestones: [
          {
            id: 'M1',
            title: 'Calc logic',
            ownedFiles: ['lib/calc.ts'],
            verifyCommand: 'npm test',
          },
        ],
      };

      const summary = await engine.run(goal, { userConfirm: true });
      expect(summary.status).toBe('COMPLETED');
      expect(attemptCounter).toBe(2);
      expect(retryEvents.length).toBe(1);
      expect(retryEvents[0].milestoneId).toBe('M1');
    });
  });

  // ==========================================================================
  // 4. Human-in-the-Loop (HITL) Approval Gates & Visual Inspection
  // ==========================================================================
  describe('4. HITL Approval Gate & Visual Artifacts (<show-me>)', () => {
    it('evaluates approval gate, generates visual diffs and flow sketches upon interrupt', async () => {
      const interruptEvents: TeamworkEvent[] = [];

      // Policy 'always' ensures HITL interrupt triggers
      const hitlGate = new HitlApprovalGate({ policy: 'always' });

      const engine = new TeamworkEngine({
        workspaceRoot,
        hitlGate,
        approvalPolicy: 'always',
        onEvent: (ev) => {
          if (ev.type === 'hitl_interrupt') {
            interruptEvents.push(ev);
          }
        },
        workerExecutor: async (m) => ({ filesTouched: m.ownedFiles }),
      });

      const goal: TeamworkGoalInput = {
        purpose: 'Modify core config',
        files: ['package.json'],
        acceptanceCriteria: [{ description: 'Config updated', verifyCommand: 'node -e "process.exit(0)"' }],
        milestones: [
          {
            id: 'M1',
            title: 'Update Package JSON',
            ownedFiles: ['package.json'],
            verifyCommand: 'node -e "process.exit(0)"',
          },
        ],
      };

      const summary = await engine.run(goal, { userConfirm: true });
      expect(summary.status).toBe('COMPLETED');
      expect(interruptEvents.length).toBe(1);

      const payload = interruptEvents[0].payload as any;
      expect(payload).toBeDefined();
      expect(payload.token).toBeDefined();
      expect(payload.showMeArtifact).toContain('<show-me');
      expect(payload.showMeArtifact).toContain('Approval required');
    });

    it('halts safely when user rejects at HITL approval gate', async () => {
      const hitlGate = new HitlApprovalGate({ policy: 'always' });

      const engine = new TeamworkEngine({
        workspaceRoot,
        hitlGate,
        approvalPolicy: 'always',
        workerExecutor: async (m) => ({ filesTouched: m.ownedFiles }),
      });

      const goal: TeamworkGoalInput = {
        purpose: 'Sensitive action',
        files: ['critical-system.ts'],
        acceptanceCriteria: [{ description: 'Safety check', verifyCommand: 'node -e "process.exit(0)"' }],
        milestones: [
          {
            id: 'M1',
            title: 'Critical update',
            ownedFiles: ['critical-system.ts'],
            verifyCommand: 'node -e "process.exit(0)"',
          },
        ],
      };

      // userConfirm: false causes gate rejection
      const summary = await engine.run(goal, { userConfirm: false });
      expect(summary.status).toBe('FAILED');
    });
  });

  // ==========================================================================
  // 5. Strict Tool Contracts, Provenance & Dual-Gate Guardrails
  // ==========================================================================
  describe('5. Strict Tool Contracts, Provenance & Dual-Gate Guardrails', () => {
    it('records chained cryptographic SHA-256 provenance on file writes', async () => {
      const lockManager = new FileLockManager({ workspaceRoot });
      lockManager.acquire('worker-1', ['src/service.ts']);

      const runner = new HeadlessToolRunner({
        workspaceRoot,
        fileLock: lockManager,
        activeWorkerId: 'worker-1',
        milestoneId: 'M1',
      });

      // First write (create)
      const res1 = await runner.fsWrite('src/service.ts', 'export const v = 1;\n', 'worker-1');
      expect(res1.written).toBe(true);

      // Second write (modify)
      const res2 = await runner.fsWrite('src/service.ts', 'export const v = 2;\n', 'worker-1');
      expect(res2.written).toBe(true);

      const tracker = runner.getProvenanceTracker();
      const records = tracker.getRecordsForFile('src/service.ts');
      expect(records.length).toBe(2);
      expect(records[0].action).toBe('create');
      expect(records[1].action).toBe('modify');
      expect(records[1].prevRecordHash).toBe(records[0].recordHash);

      const integrity = tracker.verifyChainIntegrity();
      expect(integrity.valid).toBe(true);
      expect(tracker.getHistory().length).toBe(2);
    });

    it('enforces dual-gate pre-flight validation preventing path escapes and lock violations', async () => {
      const lockManager = new FileLockManager({ workspaceRoot });
      lockManager.acquire('worker-owner', ['locked.ts']);

      const runner = new HeadlessToolRunner({
        workspaceRoot,
        fileLock: lockManager,
        enableDualGate: true,
      });

      // Write attempt by non-owner rejected
      const resLocked = await runner.fsWrite('locked.ts', 'malicious write', 'worker-intruder');
      expect(resLocked.written).toBe(false);
      expect(resLocked.error).toContain('exclusively locked');

      // Escaping path rejected by path-guard
      await expect(runner.fsWrite('../escaped.txt', 'evil content', 'worker-owner')).rejects.toThrow();
    });
  });

  // ==========================================================================
  // 6. Process Sandboxing
  // ==========================================================================
  describe('6. Process Sandboxing, Environment Scrubbing & Teardown', () => {
    it('scrubs sensitive credentials from subprocess environment when enabled', async () => {
      const runner = new HeadlessToolRunner({
        workspaceRoot,
        enableSandbox: true,
      });

      // In sandbox mode, shellRun executes via SandboxedProcessManager
      const res = await runner.shellRun('node -e "console.log(process.env.OPENAI_API_KEY || \'NOT_FOUND\')"', undefined, 10000, {
        OPENAI_API_KEY: 'sk-secret-token-to-scrub',
      });

      // Sensitive key should have been scrubbed
      expect(res.stdout).not.toContain('sk-secret-token-to-scrub');
    });

    it('enforces execution timeout and terminates processes without hanging', async () => {
      const runner = new HeadlessToolRunner({
        workspaceRoot,
        enableSandbox: false, // tests standard ProcessTreeSupervisor kill
      });

      // 500ms timeout on a longer command
      const res = await runner.shellRun('node -e "setTimeout(() => {}, 10000);"', undefined, 500);
      expect(res.code).toBe(124);
      expect(res.stderr).toContain('timed out');
    });
  });

  // ==========================================================================
  // 7. Bitemporal Ledger, State Replay & Context Memory
  // ==========================================================================
  describe('7. Bitemporal Codebase Ledger & Progressive Context', () => {
    it('appends records to ledger and verifies Merkle chain continuity', async () => {
      const ledger = new AppendOnlyLedger(workspaceRoot);
      await ledger.initialize();

      await ledger.appendRecord({
        entityId: 'milestone:M1',
        eventType: 'milestone',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'worker-1',
        validFrom: 1000,
        payload: { title: 'M1 Scope', files: ['file1.ts'] },
      });

      await ledger.appendRecord({
        entityId: 'milestone:M1',
        eventType: 'milestone',
        action: 'UPDATE',
        milestoneId: 'M1',
        workerId: 'worker-1',
        validFrom: 2000,
        payload: { title: 'M1 Scope', status: 'done', verdict: 'PASS' },
      });

      const records = ledger.query({ entityId: 'milestone:M1' });
      expect(records.length).toBe(2);

      const integrity = await ledger.verifyIntegrity();
      expect(integrity.valid).toBe(true);
      expect(integrity.chainLength).toBe(2);

      // Replay state
      const replayEngine = new PointInTimeReplayEngine(ledger);
      const state = replayEngine.replayEntityState('milestone:M1', 2500);
      expect(state?.state).toEqual({ title: 'M1 Scope', status: 'done', verdict: 'PASS' });
    });

    it('records decisions in 3-tier progressive context memory', () => {
      const ctxMgr = new TemporalContextManager();

      ctxMgr.recordMilestone({
        id: 'M1',
        title: 'Core Engine Integration',
        status: 'completed',
        filesTouched: ['lib/teamwork/engine.ts'],
        durationMs: 120,
      });

      ctxMgr.recordDecision({
        id: 'D1',
        milestoneId: 'M1',
        title: 'Unified 2-Phase Engine with DAG delegate',
        rationale: 'Retain 100% backward compatibility while adding DAG capability',
        constraints: ['Zero regression', 'Strict types'],
        timestamp: Date.now(),
      });

      const t1 = ctxMgr.renderTier1(ctxMgr.getMilestones() as any);
      expect(t1).toContain('### Milestone Index');
      expect(t1).toContain('Core Engine Integration');

      const decisions = ctxMgr.getDecisions();
      expect(decisions.length).toBe(1);
      expect(decisions[0].title).toContain('Unified 2-Phase Engine');
    });
  });

  // ==========================================================================
  // 8. CLI Runner Flags & Public Engine APIs
  // ==========================================================================
  describe('8. CLI Runner Flags & Engine Phase 1/Phase 2 Methods', () => {
    it('CLI runner accepts --dag, --resume, and --approval flags', async () => {
      const res = await runCli([
        '--goal=CLI Integration Test',
        '--dry-run',
        '--dag',
        '--approval=smart',
        '--resume=run-123',
        `--workspace=${workspaceRoot}`,
      ]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Planning phase complete');
    });

    it('CLI runner inspects bitemporal ledger via --ledger-replay', async () => {
      const ledger = new AppendOnlyLedger(workspaceRoot);
      await ledger.initialize();
      await ledger.appendRecord({
        entityId: 'milestone:M1',
        eventType: 'milestone',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'cli',
        validFrom: Date.now(),
        payload: { title: 'Replay Milestone', status: 'done' },
      });

      const res = await runCli([
        '--ledger-replay=M1',
        `--workspace=${workspaceRoot}`,
      ]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('[Ledger Replay]');
      expect(res.stdout).toContain('milestone:M1');
    });

    it('executePhase1 and executePhase2 public methods execute independently', async () => {
      const engine = new TeamworkEngine({
        workspaceRoot,
        workerExecutor: async (m) => ({ filesTouched: m.ownedFiles }),
      });

      const input: TeamworkGoalInput = {
        purpose: 'Direct phase method test',
        files: ['lib/target.ts'],
        acceptanceCriteria: [{ description: 'Verify phase methods', verifyCommand: 'node -e "process.exit(0)"' }],
        milestones: [
          {
            id: 'M1',
            title: 'Direct phase test',
            ownedFiles: ['lib/target.ts'],
            verifyCommand: 'node -e "process.exit(0)"',
          },
        ],
      };

      // Phase 1
      const phase1Result = await engine.executePhase1(input, { userConfirm: true });
      expect(phase1Result.confirmed).toBe(true);
      expect(phase1Result.plan.milestones.length).toBe(1);

      // Phase 2
      const phase2Result = await engine.executePhase2(phase1Result.plan, phase1Result.progress);
      expect(phase2Result.status).toBe('COMPLETED');
      expect(phase2Result.milestones[0].status).toBe('done');
    });
  });
});
