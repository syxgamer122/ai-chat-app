/**
 * Teamwork Multi-Agent Real-World Workload Scenarios (Tier 4 E2E)
 * Conforms to ORIGINAL_REQUEST.md, PROJECT.md, and TEST_INFRA.md.
 *
 * Scenarios Covered:
 * - Scenario 1: Multi-Agent Parallel Refactor Fleet with DAG, Semaphores & Checkpoints
 * - Scenario 2: Sensitive System Command & Destructive File Write with HITL Approval Gate
 * - Scenario 3: Sandboxed Tool Execution with Dual-Gate Guardrails & Process Tree Supervision
 * - Scenario 4: Multi-Milestone Bitemporal Ledger, Compensating Rollback & Time-Travel Replay
 * - Scenario 5: Full Headless CLI Dual-Mode Multi-Agent Orchestration with Zero Regression
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { z } from 'zod';

import {
  DagGraph,
  AsyncSemaphore,
  RetryPolicy,
  DagExecutionEngine,
} from '@/lib/teamwork/dag';

import {
  serializeCheckpoint,
  deserializeCheckpoint,
  MemoryCheckpointStore,
  FileCheckpointStore,
} from '@/lib/teamwork/checkpoint';

import {
  HitlApprovalGate,
  InterruptTokenManager,
} from '@/lib/teamwork/hitl';

import {
  DiffViewer,
  FlowSketchGenerator,
  CodeShapeExtractor,
  ShowMeBuilder,
  CyberneticControlLoop,
  InstructionOptimizer,
} from '@/lib/teamwork/visual';

import {
  defineToolContract,
  ProvenanceTracker,
  DualGateController,
} from '@/lib/teamwork/contracts';

import {
  EnvScrubber,
  CwdGuard,
  TempIsolationManager,
  SandboxedProcessManager,
} from '@/lib/teamwork/sandbox';

import {
  BitemporalAlgebra,
  AppendOnlyLedger,
  PointInTimeReplayEngine,
} from '@/lib/teamwork/ledger';

import {
  TemporalContextManager,
  KnowledgeOntology,
} from '@/lib/teamwork/context';

import {
  generatePlanMd,
  generateProgressMd,
  generateRequestMd,
  parsePlanMd,
  parseProgressMd,
  parseRequestMd,
} from '@/lib/teamwork/artifacts';

import { FileLockManager } from '@/lib/teamwork/file-lock';
import { auditDiffForIntegrity } from '@/lib/teamwork/critic';
import { generateCompletionSummary } from '@/lib/teamwork/summary';

describe('Teamwork Multi-Agent Real-World Workload Scenarios (Tier 4 E2E)', () => {
  let workspaceRoot: string;

  beforeAll(async () => {
    workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'vyen-e2e-scenarios-'));
  });

  afterAll(async () => {
    try {
      await fsp.rm(workspaceRoot, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  // ==========================================================================
  // SCENARIO 1: MULTI-AGENT PARALLEL REFACTOR FLEET WITH DAG & CHECKPOINTS
  // ==========================================================================

  describe('Scenario 1: Multi-Agent Parallel Refactor Fleet with DAG & Checkpoints', () => {
    it('executes a 5-node refactor DAG with parallel branches, retry backoff, and checkpoint resume', async () => {
      const memoryStore = new MemoryCheckpointStore();
      const semaphore = new AsyncSemaphore(2);
      const executionLog: string[] = [];
      let worker2Attempts = 0;

      // Build 5-node refactoring workflow:
      // Node 1: AnalyzeAst
      // Node 2: RefactorCore (depends on AnalyzeAst) - Worker 1
      // Node 3: UpdateDocs (depends on AnalyzeAst) - Worker 2 (transient failure + retry)
      // Node 4: MigrateTypes (depends on RefactorCore) - Worker 1
      // Node 5: VerifyIntegration (depends on [MigrateTypes, UpdateDocs]) - Fan-in join node
      const refactorDag = new DagGraph()
        .addNode({
          id: 'analyze_ast',
          title: 'Extract AST Code Shape and Plan',
          dependsOn: [],
          ownedFiles: ['src/core.ts', 'docs/api.md'],
          status: 'pending',
          attempt: 0,
          maxRetries: 1,
          executor: async () => {
            executionLog.push('analyze_ast:started');
            const sampleSource = 'export class DataEngine { process() { return 1; } }';
            const codeShape = CodeShapeExtractor.extract('src/core.ts', sampleSource);
            executionLog.push('analyze_ast:completed');
            return { symbols: codeShape.items.map((i) => i.name) };
          },
        })
        .addNode({
          id: 'refactor_core',
          title: 'Refactor DataEngine Core Pipeline',
          dependsOn: ['analyze_ast'],
          ownedFiles: ['src/core.ts'],
          status: 'pending',
          attempt: 0,
          maxRetries: 2,
          executor: async () => {
            executionLog.push('refactor_core:started');
            await new Promise((resolve) => setTimeout(resolve, 20));
            executionLog.push('refactor_core:completed');
            return { refactoredLines: 120 };
          },
        })
        .addNode({
          id: 'update_docs',
          title: 'Update API Documentation in Parallel',
          dependsOn: ['analyze_ast'],
          ownedFiles: ['docs/api.md'],
          status: 'pending',
          attempt: 0,
          maxRetries: 2,
          retryPolicy: new RetryPolicy({
            maxRetries: 2,
            baseDelayMs: 15,
            maxDelayMs: 100,
            jitterStrategy: 'none',
          }),
          executor: async () => {
            worker2Attempts++;
            executionLog.push(`update_docs:attempt_${worker2Attempts}`);
            if (worker2Attempts === 1) {
              throw new Error('Transient network timeout when fetching doc templates');
            }
            executionLog.push('update_docs:completed');
            return { docUpdated: true };
          },
        })
        .addNode({
          id: 'migrate_types',
          title: 'Migrate Type Contracts',
          dependsOn: ['refactor_core'],
          ownedFiles: ['src/types.ts'],
          status: 'pending',
          attempt: 0,
          maxRetries: 1,
          executor: async () => {
            executionLog.push('migrate_types:started');
            executionLog.push('migrate_types:completed');
            return { typesMigrated: 8 };
          },
        })
        .addNode({
          id: 'verify_integration',
          title: 'Synchronize and Verify Refactor & Docs',
          dependsOn: ['migrate_types', 'update_docs'],
          ownedFiles: [],
          status: 'pending',
          attempt: 0,
          maxRetries: 1,
          executor: async (ctx) => {
            executionLog.push('verify_integration:started');
            const typesRes = ctx.parentOutputs.get('migrate_types') as { typesMigrated: number };
            const docsRes = ctx.parentOutputs.get('update_docs') as { docUpdated: boolean };

            expect(typesRes.typesMigrated).toBe(8);
            expect(docsRes.docUpdated).toBe(true);

            executionLog.push('verify_integration:completed');
            return { integrationVerified: true };
          },
        });

      const engine = new DagExecutionEngine({
        concurrencyCap: 2,
        semaphore,
        checkpointStore: memoryStore,
        autoCheckpoint: true,
      });

      const result = await engine.execute(refactorDag.toDefinition('refactor_workflow', 'Refactor Workflow'));
      expect(result.status).toBe('COMPLETED');
      expect(worker2Attempts).toBe(2);

      // Verify all 5 nodes succeeded
      expect(result.nodeResults.get('analyze_ast')?.status).toBe('completed');
      expect(result.nodeResults.get('refactor_core')?.status).toBe('completed');
      expect(result.nodeResults.get('update_docs')?.status).toBe('completed');
      expect(result.nodeResults.get('migrate_types')?.status).toBe('completed');
      expect(result.nodeResults.get('verify_integration')?.status).toBe('completed');

      // Verify checkpoint saved
      const savedCp = await memoryStore.load(result.runId);
      expect(savedCp).not.toBeNull();
      expect(savedCp?.completedNodeIds).toHaveLength(5);
    });
  });

  // ==========================================================================
  // SCENARIO 2: SENSITIVE SYSTEM COMMAND & DESTRUCTIVE FILE WRITE WITH HITL
  // ==========================================================================

  describe('Scenario 2: Sensitive System Command & Destructive File Write with HITL Approval Gate', () => {
    it('intercepts critical package.json modification, generates <show-me> artifact, and resumes upon approval', async () => {
      const gate = new HitlApprovalGate({ policy: 'smart' });
      const tracker = new ProvenanceTracker();
      let resumedWriteCompleted = false;

      // 1. Worker attempts to modify package.json
      const proposedChange = {
        filePath: 'package.json',
        oldContent: '{\n  "name": "vyen",\n  "dependencies": {}\n}',
        newContent: '{\n  "name": "vyen",\n  "dependencies": {\n    "express": "^4.21.0"\n  }\n}',
        description: 'Add express dependency to root package.json',
      };

      // 2. Gate evaluates action and triggers interrupt
      const evaluation = gate.evaluate({
        action: 'file_write',
        target: proposedChange.filePath,
        description: proposedChange.description,
      });

      expect(evaluation.shouldInterrupt).toBe(true);
      expect(evaluation.severity).toBe('CRITICAL');
      expect(evaluation.riskScore).toBeGreaterThanOrEqual(80);

      // 3. Create Approval Request & Token
      const approvalReq = gate.createRequest({
        action: 'file_write',
        target: proposedChange.filePath,
        description: proposedChange.description,
        proposedPayload: proposedChange,
        workerId: 'worker_m2',
      });

      expect(approvalReq.state).toBe('PENDING_APPROVAL');
      expect(approvalReq.token).toBeDefined();

      // 4. Generate <show-me> visual inspection artifact
      const diffResult = DiffViewer.renderUnifiedDiff(
        proposedChange.filePath,
        proposedChange.oldContent,
        proposedChange.newContent
      );

      const sketch = FlowSketchGenerator.renderFlowSketch([
        { id: 'M1', name: 'Scope Analysis', status: 'completed' },
        { id: 'M2', name: 'Update Package.json', status: 'interrupted' },
        { id: 'M3', name: 'Install Dependencies', status: 'pending' },
      ], 'M2');

      const showMeMarkdown = ShowMeBuilder.build({
        actionTitle: 'Write Core package.json',
        workerId: 'worker_m2',
        target: proposedChange.filePath,
        severity: evaluation.severity,
        riskScore: evaluation.riskScore,
        riskReasons: evaluation.reasons,
        diff: diffResult,
        flowSketch: sketch,
        description: proposedChange.description,
        decisionOptions: ['APPROVE', 'REJECT', 'MODIFY'],
      });

      expect(showMeMarkdown).toContain('<show-me>');
      expect(showMeMarkdown).toContain('🔴 CRITICAL RISK');
      expect(showMeMarkdown).toContain('Update Package.json');
      expect(showMeMarkdown).toContain('+    "express": "^4.21.0"');

      // 5. Human operator reviews and approves with token
      const response = gate.respond({
        requestId: approvalReq.id,
        decision: 'APPROVED',
        token: approvalReq.token,
        approver: 'tech-lead@vyen.dev',
        comments: 'Verified dependency addition',
      });

      expect(response.state).toBe('APPROVED');

      // 6. Resume actuator: write file and log cryptographic provenance
      if (response.state === 'APPROVED') {
        const provRecord = tracker.createRecord({
          context: {
            workerId: 'worker_m2',
            milestoneId: 'M2',
            role: 'worker',
            workspaceRoot,
            correlationId: 'corr-sc2',
            authorizationToken: approvalReq.token,
          },
          filePath: proposedChange.filePath,
          action: 'modify',
          contentBefore: proposedChange.oldContent,
          contentAfter: proposedChange.newContent,
        });

        expect(provRecord.authorizationToken).toBe(approvalReq.token);
        expect(tracker.verifyChainIntegrity().valid).toBe(true);
        resumedWriteCompleted = true;
      }

      expect(resumedWriteCompleted).toBe(true);
    });
  });

  // ==========================================================================
  // SCENARIO 3: SANDBOXED TOOL EXECUTION WITH DUAL-GATE & PROCESS SUPERVISION
  // ==========================================================================

  describe('Scenario 3: Sandboxed Tool Execution with Dual-Gate Guardrails & Process Tree Supervision', () => {
    it('enforces pre-flight validation, environment scrubbing, process timeout, and post-flight critic review', async () => {
      const dualGate = new DualGateController();
      const tracker = new ProvenanceTracker();

      const TestRunnerContract = defineToolContract({
        name: 'run_tests',
        description: 'Runs test suite in sandboxed environment',
        category: 'test_runner',
        inputSchema: z.object({
          script: z.string().min(1),
          timeoutMs: z.number().default(2000),
        }).strict(),
        outputSchema: z.object({
          passed: z.boolean(),
          output: z.string(),
        }),
        execute: async (input, ctx) => {
          const res = await SandboxedProcessManager.executeSandboxed(ctx.workspaceRoot, {
            command: `node -e "${input.script}"`,
            timeoutMs: input.timeoutMs,
            scrubConfig: {
              maskingMode: 'strip',
            },
          });

          return {
            passed: res.code === 0 && !res.timedOut,
            output: res.stdout || res.stderr,
          };
        },
      });

      const ctx = {
        workerId: 'worker_m3',
        milestoneId: 'M3',
        role: 'worker' as const,
        workspaceRoot,
        correlationId: 'corr-sc3',
      };

      // 1. Gate 1 Pre-Flight: Rogue extra parameters rejected by strict schema
      const preFlightFail = await dualGate.evaluatePreFlight({
        contract: TestRunnerContract,
        rawInput: { script: 'console.log("ok")', rogueParam: 'injected' },
        context: ctx,
      });
      expect(preFlightFail.passed).toBe(false);
      expect(preFlightFail.blockedRule).toBe('zod_schema_violation');

      // 2. Pre-Flight on valid input succeeds
      const preFlightPass = await dualGate.evaluatePreFlight({
        contract: TestRunnerContract,
        rawInput: { script: 'console.log("PASS")' },
        context: ctx,
      });
      expect(preFlightPass.passed).toBe(true);

      // 3. Hanging script triggers process timeout and teardown
      const hangingRes = await SandboxedProcessManager.executeSandboxed(workspaceRoot, {
        command: 'node -e "setInterval(() => {}, 1000)"',
        timeoutMs: 600,
      });
      expect(hangingRes.timedOut).toBe(true);
      expect(hangingRes.code).toBe(124);

      // 4. Safe script executes cleanly with scrubbed environment
      const cleanRes = await SandboxedProcessManager.executeSandboxed(workspaceRoot, {
        command: 'node -e "console.log(process.env.OPENAI_API_KEY ? \'EXPOSED\' : \'CLEAN\')"',
        timeoutMs: 3000,
        env: {
          OPENAI_API_KEY: 'sk-secret-key-12345',
        },
        scrubConfig: {
          maskingMode: 'strip',
        },
      });
      expect(cleanRes.code).toBe(0);
      expect(cleanRes.stdout).toContain('CLEAN');

      // 5. Gate 2 Post-Flight critic audit
      const postFlightPass = await dualGate.evaluatePostFlight({
        contract: TestRunnerContract,
        output: { passed: true, output: '10 tests passed' },
        context: ctx,
        newContent: 'export function genuineLogic() { return 42; }',
      });
      expect(postFlightPass.passed).toBe(true);
      expect(postFlightPass.verdict).toBe('PASS');
    }, 20000);
  });

  // ==========================================================================
  // SCENARIO 4: MULTI-MILESTONE BITEMPORAL LEDGER & TIME-TRAVEL REPLAY
  // ==========================================================================

  describe('Scenario 4: Multi-Milestone Bitemporal Ledger, Compensating Rollback & Time-Travel Replay', () => {
    it('manages 3 milestones, records bitemporal history, compensates defect, and queries historical snapshots', async () => {
      const ledger = new AppendOnlyLedger(workspaceRoot, {
        ledgerRelativePath: 'ledger-sc4/records.jsonl',
      });
      await ledger.initialize();

      const contextMgr = new TemporalContextManager();
      const ontology = new KnowledgeOntology();

      // Milestone 1 (T=1000)
      const recM1 = await ledger.appendRecord({
        entityId: 'app.config',
        action: 'INSERT',
        payload: { port: 3000, authStrategy: 'jwt' },
        milestoneId: 'M1',
        validFrom: 1000,
        validTo: 2000,
      });

      contextMgr.recordMilestone({
        id: 'M1',
        title: 'Initial Architecture Setup',
        status: 'completed',
        filesTouched: ['config/app.json'],
      });

      contextMgr.recordDecision({
        id: 'DEC_1',
        milestoneId: 'M1',
        title: 'JWT Authentication Strategy',
        rationale: 'Stateless scalable token authentication',
        constraints: ['HMAC-SHA256 signature'],
        timestamp: 1050,
      });

      // Milestone 2 (T=2000): Flawed change introduced
      const recM2 = await ledger.appendRecord({
        entityId: 'app.config',
        action: 'UPDATE',
        payload: { port: 8080, authStrategy: 'none' }, // Flawed: disabled auth
        milestoneId: 'M2',
        parentRecordId: recM1.id,
        validFrom: 2000,
      });

      contextMgr.recordMilestone({
        id: 'M2',
        title: 'Port and Auth Update',
        status: 'completed',
        filesTouched: ['config/app.json'],
      });

      // Milestone 3: Security audit detects defect and triggers compensating rollback
      const compRec = await ledger.compensate({
        targetRecordId: recM2.id,
        milestoneId: 'M3',
        author: 'security_auditor',
        reason: 'Revert unauthenticated authStrategy introduced in M2',
      });

      expect(compRec.action).toBe('COMPENSATE');
      expect(compRec.parentRecordId).toBe(recM2.id);

      // Verify append-only integrity of ledger (3 records chained)
      const integrity = await ledger.verifyIntegrity();
      expect(integrity.valid).toBe(true);
      expect(integrity.chainLength).toBe(3);

      // Point-in-time replay:
      const replayer = new PointInTimeReplayEngine(ledger.getAllRecords());

      // At validTime=1500 as of recM1.txFrom (during M1): port was 3000, auth was jwt
      const stateM1 = replayer.replayEntityState('app.config', { validTime: 1500, txTime: recM1.txFrom });
      expect((stateM1?.state as any)?.authStrategy).toBe('jwt');

      // At validTime=2500 as of recM2.txFrom before compensation: flaw was active in history
      const stateM2 = replayer.replayEntityState('app.config', { validTime: 2500, txTime: recM2.txFrom });
      expect((stateM2?.state as any)?.authStrategy).toBe('none');

      // Verify 3-tier progressive context
      const tier1 = contextMgr.renderTier1(contextMgr.getMilestones() as any, 150);
      expect(tier1).toContain('M1');
      expect(tier1).toContain('M2');

      const tier2 = contextMgr.renderTier2(contextMgr.getDecisions(), undefined, 400);
      expect(tier2).toContain('JWT Authentication Strategy');
    });
  });

  // ==========================================================================
  // SCENARIO 5: FULL HEADLESS CLI DUAL-MODE WITH ZERO REGRESSION
  // ==========================================================================

  describe('Scenario 5: Full Headless CLI Dual-Mode Multi-Agent Orchestration with Zero Regression', () => {
    it('runs an end-to-end 2-phase teamwork workflow generating triad, locking files, and emitting compact summary', async () => {
      const lockManager = new FileLockManager({ concurrencyCap: 2 });

      // Phase 1: Triad Generation
      const requestMd = generateRequestMd({
        title: 'Refactor Runtime',
        originalGoal: 'Refactor and secure coding harness runtime',
        repoContext: { workingDirectory: workspaceRoot },
        acceptanceCriteria: [
          { description: 'Topological sort resolution', verifyCommand: 'npx vitest run' },
        ],
      });
      expect(requestMd).toContain('## Tiêu chí nghiệm thu (Acceptance Criteria)');
      expect(requestMd).toContain('Topological sort resolution');

      const planMd = generatePlanMd({
        milestones: [
          {
            id: 'M1',
            title: 'DAG Orchestration',
            assignedWorker: 'worker_m1',
            targetFiles: ['lib/teamwork/engine.ts'],
            verifyCommand: 'npx vitest run tests/teamwork-dag.test.ts',
          },
          {
            id: 'M2',
            title: 'Tool Sandbox',
            assignedWorker: 'worker_m2',
            targetFiles: ['lib/teamwork/tools.ts'],
            verifyCommand: 'npx vitest run tests/teamwork-tools.test.ts',
          },
        ],
      });
      expect(planMd).toContain('M1: DAG Orchestration');
      expect(planMd).toContain('M2: Tool Sandbox');

      // Phase 2: Exclusive Lock Verification (Disjoint files can run parallel)
      expect(lockManager.canAcquire('worker_m1', ['lib/teamwork/engine.ts'])).toBe(true);
      lockManager.acquire('worker_m1', ['lib/teamwork/engine.ts']);

      expect(lockManager.canAcquire('worker_m2', ['lib/teamwork/tools.ts'])).toBe(true);
      lockManager.acquire('worker_m2', ['lib/teamwork/tools.ts']);

      // Overlapping file lock blocked
      expect(lockManager.canAcquire('worker_m3', ['lib/teamwork/engine.ts'])).toBe(false);

      // Critic Zero-Trust Audit on Diff
      const validDiff = `+++ b/lib/teamwork/engine.ts
+export class EnhancedEngine {
+  public run(): boolean { return true; }
+}`;
      const issues = auditDiffForIntegrity(validDiff);
      expect(issues).toHaveLength(0);

      // Release locks
      lockManager.release('worker_m1', ['lib/teamwork/engine.ts']);
      lockManager.release('worker_m2', ['lib/teamwork/tools.ts']);

      // Generate <= 20 lines summary
      const summary = generateCompletionSummary({
        status: 'COMPLETED',
        milestones: [
          { id: 'M1', status: 'done', criticVerdict: 'PASS' },
          { id: 'M2', status: 'done', criticVerdict: 'PASS' },
        ],
        changedFiles: ['lib/teamwork/engine.ts', 'lib/teamwork/tools.ts'],
        durationMs: 4500,
        progressFilePath: 'teamwork/PROGRESS.md',
      });

      expect(summary).toContain('### Teamwork Execution Summary: COMPLETED');
      expect(summary).toContain('Status: COMPLETED');
      const lines = summary.split(/\r?\n/).filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(20);
    });
  });
});
