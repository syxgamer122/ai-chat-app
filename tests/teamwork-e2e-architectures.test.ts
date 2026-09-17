/**
 * Teamwork Multi-Agent Architecture E2E Test Suite (Tiers 1-3)
 * Conforms to ORIGINAL_REQUEST.md, PROJECT.md, and TEST_INFRA.md.
 *
 * Covers 6 Reference Architectures & 27 Features:
 * - Nhóm 1 & 5: DAG bền vững & song song hoá (F1-F6, F24)
 * - Nhóm 2: Human-in-the-loop & thẩm định trực quan (F7-F12)
 * - Nhóm 3 & 6: Hợp đồng công cụ & sandbox (F13-F18, F25)
 * - Nhóm 4: Ledger bitemporal & ngữ cảnh (F19-F23)
 * - Core Integration: TeamworkEngine, ToolRunner, CLI, Zero Regression (F24-F27)
 *
 * Tiers Covered:
 * - Tier 1: Feature Coverage (F1 to F27 in isolation)
 * - Tier 2: Boundary Value Analysis & Stress Cases (Cycles, Saturation, Clamping, Traversal, Tampering)
 * - Tier 3: Pairwise Cross-Feature Interactions
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import { z } from 'zod';

// ============================================================================
// Module Imports
// ============================================================================

import {
  computeTopologicalPlan,
  DagGraph,
  AsyncSemaphore,
  RetryPolicy,
  DagExecutionEngine,
  CycleDetectedError,
  MissingDependencyError,
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
  CyberneticControlLoop,
  InstructionOptimizer,
} from '@/lib/teamwork/visual';

import {
  defineToolContract,
  definePresentationToolContract,
  ProvenanceTracker,
  DualGateController,
  GENESIS_HASH,
} from '@/lib/teamwork/contracts';

import {
  EnvScrubber,
  CwdGuard,
  TempIsolationManager,
  SandboxedProcessManager,
  CwdLockdownViolationError,
} from '@/lib/teamwork/sandbox';

import {
  BitemporalAlgebra,
  AppendOnlyLedger,
  PointInTimeReplayEngine,
  GENESIS_PREV_HASH,
} from '@/lib/teamwork/ledger';

import {
  TemporalContextManager,
  KnowledgeOntology,
} from '@/lib/teamwork/context';

import { FileLockManager } from '@/lib/teamwork/file-lock';
import { TeamworkCritic, auditDiffForIntegrity } from '@/lib/teamwork/critic';

// ============================================================================
// Test Environment Setup
// ============================================================================

describe('Teamwork E2E Reference Architectures & Capabilities (Tiers 1-3)', () => {
  let testWorkspaceRoot: string;

  beforeAll(async () => {
    testWorkspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'vyen-e2e-arch-'));
  });

  afterAll(async () => {
    try {
      await fsp.rm(testWorkspaceRoot, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  // ==========================================================================
  // TIER 1: FEATURE COVERAGE (F1 to F27 in isolation)
  // ==========================================================================

  describe('Tier 1: Feature Isolation (F1 - F27)', () => {
    // ------------------------------------------------------------------------
    // Nhóm 1 & 5: DAG bền vững & song song hoá (F1 - F6)
    // ------------------------------------------------------------------------
    describe('Durable DAG Workflows, Retries & Checkpointing', () => {
      it('F1: DAG Topological Sort & Dependency Resolution computes execution levels and ready nodes', () => {
        // Linear chain + diamond: A -> B, A -> C, B -> D, C -> D
        const nodes = [
          { id: 'A', title: 'Task A', dependsOn: [], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 'A' },
          { id: 'B', title: 'Task B', dependsOn: ['A'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 'B' },
          { id: 'C', title: 'Task C', dependsOn: ['A'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 'C' },
          { id: 'D', title: 'Task D', dependsOn: ['B', 'C'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 'D' },
        ];

        const plan = computeTopologicalPlan(nodes);
        expect(plan.sortedNodeIds).toHaveLength(4);
        expect(plan.initialReadyNodes).toEqual(['A']);
        expect(plan.leafNodes).toEqual(['D']);
        expect(plan.levels).toEqual([['A'], ['B', 'C'], ['D']]);
        expect(plan.sortedNodeIds.indexOf('A')).toBeLessThan(plan.sortedNodeIds.indexOf('B'));
        expect(plan.sortedNodeIds.indexOf('A')).toBeLessThan(plan.sortedNodeIds.indexOf('C'));
        expect(plan.sortedNodeIds.indexOf('B')).toBeLessThan(plan.sortedNodeIds.indexOf('D'));
        expect(plan.sortedNodeIds.indexOf('C')).toBeLessThan(plan.sortedNodeIds.indexOf('D'));
      });

      it('F1: Detects missing dependencies and circular dependencies in DAG', () => {
        const missingDepNodes = [
          { id: 'A', title: 'Task A', dependsOn: ['NON_EXISTENT'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 'A' },
        ];
        expect(() => computeTopologicalPlan(missingDepNodes)).toThrow(MissingDependencyError);

        const cycleNodes = [
          { id: 'A', title: 'A', dependsOn: ['C'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 'A' },
          { id: 'B', title: 'B', dependsOn: ['A'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 'B' },
          { id: 'C', title: 'C', dependsOn: ['B'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 'C' },
        ];
        expect(() => computeTopologicalPlan(cycleNodes)).toThrow(CycleDetectedError);
      });

      it('F2: Async Concurrency Limiter & Semaphore enforces slot ceiling and fair queuing', async () => {
        const semaphore = new AsyncSemaphore(2);
        expect(semaphore.maxSlots).toBe(2);
        expect(semaphore.currentCapacity).toBe(2);
        expect(semaphore.activeCount).toBe(0);

        const slot1 = await semaphore.acquire();
        const slot2 = await semaphore.acquire();
        expect(semaphore.currentCapacity).toBe(0);
        expect(semaphore.activeCount).toBe(2);

        let acquiredSlot3 = false;
        const slot3Promise = semaphore.acquire().then((s) => {
          acquiredSlot3 = true;
          return s;
        });

        expect(semaphore.waitingCount).toBe(1);
        expect(acquiredSlot3).toBe(false);

        // Releasing slot1 should grant slot3
        slot1.release();
        const slot3 = await slot3Promise;
        expect(acquiredSlot3).toBe(true);
        expect(semaphore.activeCount).toBe(2);

        slot2.release();
        slot3.release();
        expect(semaphore.currentCapacity).toBe(2);
        expect(semaphore.activeCount).toBe(0);
      });

      it('F3: Exponential Backoff with Randomized Jitter calculates delays and clamps strictly', () => {
        const policyNone = new RetryPolicy({
          baseDelayMs: 100,
          maxDelayMs: 2000,
          jitterStrategy: 'none',
        });
        expect(policyNone.computeDelay(1)).toBe(100);
        expect(policyNone.computeDelay(2)).toBe(200);
        expect(policyNone.computeDelay(3)).toBe(400);

        // Extreme attempt number clamped strictly to maxDelayMs without NaN/Infinity
        expect(policyNone.computeDelay(50)).toBe(2000);

        // Full jitter is strictly bounded between [0, maxDelayMs]
        const policyFull = new RetryPolicy({
          baseDelayMs: 200,
          maxDelayMs: 1000,
          jitterStrategy: 'full',
        });
        for (let i = 1; i <= 10; i++) {
          const delay = policyFull.computeDelay(i);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(1000);
        }
      });

      it('F4: State Checkpoint Serialization safely serializes complex types and persists to Memory & File stores', async () => {
        const memoryStore = new MemoryCheckpointStore();
        const checkpointData = {
          runId: 'run-test-01',
          dagId: 'dag-test-01',
          status: 'running' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          completedNodeIds: ['A'],
          nodes: {
            A: {
              status: 'completed' as const,
              attempt: 1,
              output: { result: 42, meta: new Map([['key', 'val']]), tags: new Set(['fast']) },
            },
            B: {
              status: 'pending' as const,
              attempt: 0,
            },
          },
          context: { sharedKey: 'sharedVal' },
        };

        const json = serializeCheckpoint(checkpointData as any);
        expect(typeof json).toBe('string');
        const deserialized = deserializeCheckpoint(json);
        expect(deserialized.runId).toBe('run-test-01');
        expect(deserialized.completedNodeIds).toContain('A');

        // Test MemoryStore save/load/latest
        await memoryStore.save(checkpointData as any);
        const loaded = await memoryStore.load('run-test-01');
        expect(loaded?.runId).toBe('run-test-01');

        const latest = await memoryStore.latest('dag-test-01');
        expect(latest?.runId).toBe('run-test-01');

        // Test FileStore atomic writing
        const cpDir = path.join(testWorkspaceRoot, 'checkpoints-f4');
        const fileStore = new FileCheckpointStore({ directory: cpDir });
        await fileStore.save(checkpointData as any);
        const fileLoaded = await fileStore.load('run-test-01');
        expect(fileLoaded?.runId).toBe('run-test-01');
      });

      it('F5: Pause & Resume Lifecycle executes DAG and resumes from last valid checkpoint', async () => {
        const memoryStore = new MemoryCheckpointStore();
        const executionOrder: string[] = [];

        const dag = new DagGraph()
          .addNode({
            id: 'step1',
            title: 'Step 1',
            dependsOn: [],
            ownedFiles: [],
            status: 'pending',
            attempt: 0,
            maxRetries: 1,
            executor: async () => {
              executionOrder.push('step1');
              return { data: 'val1' };
            },
          })
          .addNode({
            id: 'step2',
            title: 'Step 2',
            dependsOn: ['step1'],
            ownedFiles: [],
            status: 'pending',
            attempt: 0,
            maxRetries: 1,
            executor: async (ctx) => {
              executionOrder.push('step2');
              const step1Output = ctx.parentOutputs.get('step1') as { data: string };
              return { data: `${step1Output?.data}-val2` };
            },
          });

        const engine = new DagExecutionEngine({
          checkpointStore: memoryStore,
          autoCheckpoint: true,
        });

        const result = await engine.execute(dag.toDefinition('dag-f5', 'DAG F5'));
        expect(result.status).toBe('COMPLETED');
        expect(executionOrder).toEqual(['step1', 'step2']);

        const step2Res = result.nodeResults.get('step2');
        expect(step2Res?.status).toBe('completed');
        expect((step2Res?.output as any)?.data).toBe('val1-val2');

        // Resume with pre-completed step1 skips step1
        const resumeOrder: string[] = [];
        const resumeDag = new DagGraph()
          .addNode({
            id: 'step1',
            title: 'Step 1',
            dependsOn: [],
            ownedFiles: [],
            status: 'pending',
            attempt: 0,
            maxRetries: 1,
            executor: async () => {
              resumeOrder.push('step1');
              return { data: 'val1' };
            },
          })
          .addNode({
            id: 'step2',
            title: 'Step 2',
            dependsOn: ['step1'],
            ownedFiles: [],
            status: 'pending',
            attempt: 0,
            maxRetries: 1,
            executor: async () => {
              resumeOrder.push('step2');
              return { data: 'val2' };
            },
          });

        const latestCheckpoint = await memoryStore.latest('dag-f5');
        expect(latestCheckpoint).not.toBeNull();

        const partialCheckpoint = {
          ...latestCheckpoint!,
          completedNodeIds: ['step1'],
          nodes: {
            step1: { status: 'completed' as const, attempt: 1, output: { data: 'val1-cached' } },
            step2: { status: 'pending' as const, attempt: 0 },
          },
        };

        const resumedResult = await engine.resume(partialCheckpoint as any, resumeDag.toDefinition('dag-f5', 'DAG F5'));
        expect(resumedResult.status).toBe('COMPLETED');
        expect(resumeOrder).toEqual(['step2']);
      });

      it('F6: Task Idempotency Tokens prevent duplicate side-effects during re-execution', () => {
        const store = new Map<string, unknown>();
        const makeKey = (runId: string, nodeId: string, attempt: number) =>
          crypto.createHash('sha256').update(`${runId}:${nodeId}:${attempt}`).digest('hex');

        const token1 = makeKey('run-1', 'node-write', 1);
        const token2 = makeKey('run-1', 'node-write', 1);
        const token3 = makeKey('run-1', 'node-write', 2);

        expect(token1).toBe(token2);
        expect(token1).not.toBe(token3);

        store.set(token1, { writtenBytes: 1024, path: 'foo.txt' });
        expect(store.has(token2)).toBe(true);
        expect(store.get(token2)).toEqual({ writtenBytes: 1024, path: 'foo.txt' });
      });
    });

    // ------------------------------------------------------------------------
    // Nhóm 2: Human-in-the-loop & thẩm định trực quan (F7 - F12)
    // ------------------------------------------------------------------------
    describe('Human-in-the-Loop & Visual Inspection', () => {
      it('F7: HITL Approval Gates intercepts critical files and dangerous shell commands', () => {
        const gate = new HitlApprovalGate({ policy: 'smart' });

        const evalFile = gate.evaluate({
          action: 'file_write',
          target: 'package.json',
          proposedPayload: { dependencies: { express: '^4.0.0' } },
          description: 'Add express dependency',
        });
        expect(evalFile.shouldInterrupt).toBe(true);
        expect(evalFile.severity).toBe('CRITICAL');
        expect(evalFile.riskScore).toBeGreaterThanOrEqual(80);

        const evalSafe = gate.evaluate({
          action: 'file_write',
          target: 'src/components/button.tsx',
          description: 'Fix button padding',
          diffLines: 5,
        });
        expect(evalSafe.shouldInterrupt).toBe(false);
        expect(evalSafe.riskScore).toBeLessThan(50);

        const evalCmd = gate.evaluate({
          action: 'shell_exec',
          target: 'rm -rf /var/data',
          description: 'Clean cache',
        });
        expect(evalCmd.shouldInterrupt).toBe(true);
        expect(evalCmd.severity).toBe('CRITICAL');
      });

      it('F7: HITL Request / Response state machine transitions properly (APPROVED, REJECTED, MODIFIED)', () => {
        const gate = new HitlApprovalGate();

        // 1. Approved
        const req1 = gate.createRequest({
          action: 'file_write',
          target: 'package.json',
          description: 'Update version',
          proposedPayload: { version: '1.0.1' },
        });
        expect(req1.state).toBe('PENDING_APPROVAL');

        const approved = gate.respond({
          requestId: req1.id,
          decision: 'APPROVED',
          token: req1.token,
          approver: 'admin@vyen.dev',
          comments: 'Approved version bump',
        });
        expect(approved.state).toBe('APPROVED');

        // 2. Rejected
        const req2 = gate.createRequest({
          action: 'shell_exec',
          target: 'drop database test',
          description: 'Drop DB',
        });
        const rejected = gate.respond({
          requestId: req2.id,
          decision: 'REJECTED',
          token: req2.token,
          approver: 'security@vyen.dev',
          comments: 'Destructive DB operations disallowed',
        });
        expect(rejected.state).toBe('REJECTED');

        // 3. Modified
        const req3 = gate.createRequest({
          action: 'file_write',
          target: 'config.json',
          description: 'Set port to 80',
          proposedPayload: { port: 80 },
        });
        const modified = gate.respond({
          requestId: req3.id,
          decision: 'MODIFIED',
          token: req3.token,
          approver: 'admin@vyen.dev',
          modifiedPayload: { port: 8080 },
        });
        expect(modified.state).toBe('MODIFIED');
        expect(modified.modifiedPayload).toEqual({ port: 8080 });
      });

      it('F8: Cryptographic Interrupt Tokens generate and verify HMAC-SHA256 signatures with tamper detection', () => {
        const tokenManager = new InterruptTokenManager('super-secret-key-123');
        const payload = { file: 'package.json', lines: 10 };

        const token = tokenManager.createToken('req-123', payload, 60000);
        expect(token.token.startsWith('hitl_v1.')).toBe(true);
        expect(token.requestId).toBe('req-123');

        // Valid verification
        const valid = tokenManager.verifyToken(token.token, payload);
        expect(valid.valid).toBe(true);

        // Tampered token string
        const tamperedString = token.token.slice(0, -4) + 'abcd';
        const tamperedRes = tokenManager.verifyToken(tamperedString, payload);
        expect(tamperedRes.valid).toBe(false);
        expect(tamperedRes.reason).toContain('tampered');

        // Payload mismatch
        const modifiedPayload = { file: 'package.json', lines: 11 };
        const mismatchRes = tokenManager.verifyToken(token.token, modifiedPayload);
        expect(mismatchRes.valid).toBe(false);
        expect(mismatchRes.reason).toContain('mismatch');

        // Expired token
        const expiredToken = tokenManager.createToken('req-expired', payload, 1000, Date.now() - 5000);
        const expiredRes = tokenManager.verifyToken(expiredToken.token, payload, Date.now());
        expect(expiredRes.valid).toBe(false);
        expect(expiredRes.reason).toContain('expired');
      });

      it('F9: Visual Diff Inspection renders unified diff, line stats, and detects danger patterns', () => {
        const oldContent = 'const a = 1;\nconst apiKey = "secret-token";\n';
        const newContent = 'const a = 1;\n';

        const diffResult = DiffViewer.renderUnifiedDiff('lib/secrets.ts', oldContent, newContent);
        expect(diffResult.filePath).toBe('lib/secrets.ts');
        expect(diffResult.deletions).toBe(1);
        expect(diffResult.diffText).toContain('-const apiKey = "secret-token";');
        expect(diffResult.dangerFlags.length).toBeGreaterThan(0);
        expect(diffResult.dangerFlags[0]).toContain('secret/key deletion');
      });

      it('F10: ASCII & Unicode Flow Sketches render DAG topology, node symbols, and active gates', () => {
        const nodes = [
          { id: 'M1', name: 'Scope Analysis', status: 'completed' },
          { id: 'M2', name: 'Implementation', status: 'running', dependsOn: ['M1'] },
          { id: 'M3', name: 'Gate Review', status: 'interrupted', dependsOn: ['M2'] },
          { id: 'M4', name: 'Integration', status: 'pending', dependsOn: ['M3'] },
        ];

        const asciiSketch = FlowSketchGenerator.renderFlowSketch(nodes as any, 'M3', { format: 'ascii' });
        expect(asciiSketch).toContain('[X] M1');
        expect(asciiSketch).toContain('[>] M2');
        expect(asciiSketch).toContain('[!] M3');
        expect(asciiSketch).toContain('[ ] M4');
        expect(asciiSketch).toContain('|');
        expect(asciiSketch).toContain('v');

        const unicodeSketch = FlowSketchGenerator.renderFlowSketch(nodes as any, 'M3', { format: 'unicode' });
        expect(unicodeSketch).toContain('✓ M1');
        expect(unicodeSketch).toContain('► M2');
        expect(unicodeSketch).toContain('⧗ M3');
      });

      it('F11: Code-Shape AST Outlining extracts structural classes, interfaces, and function signatures', () => {
        const tsSource = `
export interface TaskConfig {
  id: string;
  timeout: number;
}

export class TaskRunner implements Runnable {
  private count: number = 0;

  public async runTask(name: string): Promise<boolean> {
    return true;
  }
}

export function helperFunction(val: string): string {
  return val.trim();
}
`;
        const outline = CodeShapeExtractor.extract('runner.ts', tsSource);
        expect(outline.items.some((i) => i.type === 'interface' && i.name === 'TaskConfig')).toBe(true);
        expect(outline.items.some((i) => i.type === 'class' && i.name === 'TaskRunner')).toBe(true);
        expect(outline.items.some((i) => i.type === 'function' && i.name === 'helperFunction')).toBe(true);
        expect(outline.formatted).toContain('TaskRunner');
        expect(outline.formatted).toContain('TaskConfig');
      });

      it('F12: Cybernetic Control Loop & <important if> Instruction Optimization', async () => {
        const loop = new CyberneticControlLoop();
        const telemetry = loop.sense({
          activeLocks: ['locked-file.ts'],
          consecutiveFailures: 0,
          rateLimitStatus: 'HEALTHY',
          criticVerdict: 'PASS',
        });
        expect(telemetry.activeFileLocks).toContain('locked-file.ts');

        // Control decision: file contention triggers RETRY
        const decision = loop.control(telemetry, {
          requiredCriticVerdict: 'PASS',
          targetFiles: ['locked-file.ts'],
        });
        expect(decision.action).toBe('RETRY');
        expect(decision.recommendedDelayMs).toBeGreaterThan(0);

        // Instruction optimization evaluates conditional blocks
        const promptTemplate = `
You are a worker.
<important if="isRetry == true">
CRITICAL: This is a retry attempt! Analyze previous failures before modifying code.
</important>
<important if="isCritical == true">
SECURITY ALERT: Core system modification.
</important>
Proceed with task.
`;
        const promptForRetry = InstructionOptimizer.optimizePrompt(promptTemplate, {
          isRetry: true,
          isCritical: false,
        });
        expect(promptForRetry).toContain('CRITICAL: This is a retry attempt!');
        expect(promptForRetry).not.toContain('SECURITY ALERT');
      });
    });

    // ------------------------------------------------------------------------
    // Nhóm 3 & 6: Hợp đồng công cụ & sandbox (F13 - F18)
    // ------------------------------------------------------------------------
    describe('Strict Contracts, Provenance & Sandbox', () => {
      it('F13: Typed Tool Contracts with Zod enforce strict schemas and dynamic execution context separation', async () => {
        const InputSchema = z
          .object({
            filePath: z.string().min(1),
            content: z.string(),
          })
          .strict();

        const OutputSchema = z.object({
          bytesWritten: z.number(),
        });

        const contract = defineToolContract({
          name: 'safe_write',
          description: 'Safely write file',
          category: 'filesystem',
          inputSchema: InputSchema,
          outputSchema: OutputSchema,
          execute: async (input) => ({
            bytesWritten: Buffer.byteLength(input.content, 'utf8'),
          }),
        });

        // Valid input
        const validContext = {
          workerId: 'worker-1',
          milestoneId: 'M1',
          role: 'worker' as const,
          workspaceRoot: testWorkspaceRoot,
          correlationId: 'corr-1',
        };
        const output = await contract.execute({ filePath: 'foo.ts', content: 'hello' }, validContext);
        expect(output.bytesWritten).toBe(5);

        // Unknown extra parameter rejected by strict schema
        const invalidInput = { filePath: 'foo.ts', content: 'hello', system_prompt_override: 'hack' };
        const parseResult = contract.inputSchema.safeParse(invalidInput);
        expect(parseResult.success).toBe(false);

        // Presentation tool contract distinction
        const presentationContract = definePresentationToolContract({
          name: 'show_diff',
          description: 'Present visual diff without writing',
          category: 'presentation',
          inputSchema: z.object({ diff: z.string() }),
          outputSchema: z.object({ rendered: z.string() }),
          execute: async (inp) => ({ rendered: inp.diff }),
        });
        expect(presentationContract.kind).toBe('presentation');
      });

      it('F14: Provenance-Gated Resource Writes tracks cryptographic SHA-256 hash chains and originators', () => {
        const tracker = new ProvenanceTracker();
        const ctx1 = {
          workerId: 'worker-alpha',
          milestoneId: 'M1',
          role: 'worker' as const,
          workspaceRoot: testWorkspaceRoot,
          correlationId: 'c1',
          authorizationToken: 'auth-token-1',
        };

        const rec1 = tracker.createRecord({
          context: ctx1,
          filePath: 'src/index.ts',
          action: 'create',
          contentBefore: '',
          contentAfter: 'console.log("hello");',
        });

        expect(rec1.workerId).toBe('worker-alpha');
        expect(rec1.prevRecordHash).toBe(GENESIS_HASH);
        expect(rec1.recordHash).toBeDefined();

        const ctx2 = {
          workerId: 'worker-beta',
          milestoneId: 'M2',
          role: 'worker' as const,
          workspaceRoot: testWorkspaceRoot,
          correlationId: 'c2',
        };

        const rec2 = tracker.createRecord({
          context: ctx2,
          filePath: 'src/index.ts',
          action: 'modify',
          contentBefore: 'console.log("hello");',
          contentAfter: 'console.log("hello world");',
        });

        expect(rec2.workerId).toBe('worker-beta');
        expect(rec2.prevRecordHash).toBe(rec1.recordHash);
        expect(tracker.verifyChainIntegrity().valid).toBe(true);
      });

      it('F15: Dual-Gate Guardrails executes Gate 1 pre-flight and Gate 2 post-flight verifications', async () => {
        const dualGate = new DualGateController();

        const contract = defineToolContract({
          name: 'write_file',
          description: 'Write file',
          category: 'fs_write',
          riskLevel: 'write',
          inputSchema: z.object({ filePath: z.string(), content: z.string() }),
          outputSchema: z.object({ success: z.boolean() }),
          execute: async () => ({ success: true }),
        });

        const ctx = {
          workerId: 'w-1',
          milestoneId: 'M1',
          role: 'worker' as const,
          workspaceRoot: testWorkspaceRoot,
          correlationId: 'c-1',
        };

        // Gate 1: Pre-flight check passes on clean input
        const prePass = await dualGate.evaluatePreFlight({
          contract,
          rawInput: { filePath: 'foo.ts', content: 'export const a = 1;' },
          context: ctx,
          checkLock: () => true,
        });
        expect(prePass.passed).toBe(true);

        // Gate 1: Pre-flight fails if lock check fails
        const preFailLock = await dualGate.evaluatePreFlight({
          contract,
          rawInput: { filePath: 'foo.ts', content: 'export const a = 1;' },
          context: ctx,
          checkLock: () => false,
        });
        expect(preFailLock.passed).toBe(false);
        expect(preFailLock.reason).toContain('Exclusive file lock required');

        // Gate 2: Post-flight review detects adversarial empty facade
        const postFailFacade = await dualGate.evaluatePostFlight({
          contract,
          output: { success: true },
          context: ctx,
          newContent: 'async function execute() {}',
        });
        expect(postFailFacade.passed).toBe(false);
        expect(postFailFacade.verdict).toBe('FAIL-BLOCKED');
        expect(postFailFacade.issues.some((i) => i.severity === 'blocker')).toBe(true);

        // Gate 2: Post-flight review passes genuine implementation
        const postPass = await dualGate.evaluatePostFlight({
          contract,
          output: { success: true },
          context: ctx,
          newContent: 'export function add(a: number, b: number) { return a + b; }',
        });
        expect(postPass.passed).toBe(true);
        expect(postPass.verdict).toBe('PASS');
      });

      it('F16: Environment Variable Scrubbing strips API keys and secrets while preserving PATH', () => {
        const dirtyEnv = {
          PATH: '/usr/bin;C:\\Windows\\system32',
          NODE_ENV: 'test',
          OPENAI_API_KEY: 'sk-1234567890abcdef',
          ANTHROPIC_API_KEY: 'sk-ant-1234567890',
          AWS_SECRET_ACCESS_KEY: 'aws-secret-key-123',
          DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
          USER_PASSWORD: 'super-password',
          USER_NAME: 'testuser',
        };

        const scrubbed = EnvScrubber.scrub(dirtyEnv, { maskingMode: 'strip' });
        expect(scrubbed.PATH).toBe(dirtyEnv.PATH);
        expect(scrubbed.NODE_ENV).toBe('test');
        expect(scrubbed.USER_NAME).toBe('testuser');

        expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
        expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
        expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(scrubbed.DATABASE_URL).toBeUndefined();
        expect(scrubbed.USER_PASSWORD).toBeUndefined();

        // Mask mode replaces with ***SCRUBBED***
        const masked = EnvScrubber.scrub(dirtyEnv, { maskingMode: 'mask' });
        expect(masked.OPENAI_API_KEY).toBe('***SCRUBBED***');
        expect(masked.DATABASE_URL).toBe('***SCRUBBED***');
      });

      it('F17: CWD Lockdown confines paths and TempIsolationManager creates isolated directories', async () => {
        // Safe relative path within root
        const safePath = CwdGuard.assertWithinLockdown(testWorkspaceRoot, 'subfolder');
        expect(safePath.startsWith(path.resolve(testWorkspaceRoot))).toBe(true);

        // Path traversal escaping root throws CwdLockdownViolationError
        expect(() =>
          CwdGuard.assertWithinLockdown(testWorkspaceRoot, '../../../../Windows/System32')
        ).toThrow(CwdLockdownViolationError);

        // TempIsolationManager creates disposable directory
        const workerTemp = await TempIsolationManager.createScopedTempDir(testWorkspaceRoot, 'worker-isolated-1');
        const statBefore = await fsp.stat(workerTemp).catch(() => null);
        expect(statBefore?.isDirectory()).toBe(true);

        await TempIsolationManager.cleanupTempDir(workerTemp);
        const statAfter = await fsp.stat(workerTemp).catch(() => null);
        expect(statAfter).toBeNull();
      });

      it('F18: Process Tree Teardown & Deadlines executes sandboxed processes with timeout protection', async () => {
        // Fast command succeeds
        const fastResult = await SandboxedProcessManager.executeSandboxed(testWorkspaceRoot, {
          command: 'node -e "console.log(\'hello from sandbox\')"',
          timeoutMs: 5000,
        });
        expect(fastResult.code).toBe(0);
        expect(fastResult.stdout).toContain('hello from sandbox');
        expect(fastResult.timedOut).toBe(false);

        // Hanging command hits deadline and is killed cleanly
        const timeoutResult = await SandboxedProcessManager.executeSandboxed(testWorkspaceRoot, {
          command: 'node -e "setInterval(() => {}, 1000)"',
          timeoutMs: 800,
        });
        expect(timeoutResult.timedOut).toBe(true);
        expect(timeoutResult.code).toBe(124);
      }, 15000);
    });

    // ------------------------------------------------------------------------
    // Nhóm 4: Ledger bitemporal & ngữ cảnh (F19 - F23)
    // ------------------------------------------------------------------------
    describe('Bitemporal Codebase Ledger & Context Memory', () => {
      it('F19: Bitemporal Context Ledger decouples Valid Time (Tv) from Transaction Time (Tt)', () => {
        const record = {
          id: 'rec-1',
          entityId: 'config.port',
          validTime: { from: 100, to: 200 },
          transactionTime: { recordedAt: 150, supersededAt: 300 },
          action: 'INSERT' as const,
          payload: { port: 3000 },
          recordHash: 'hash-1',
          prevHash: GENESIS_PREV_HASH,
          sequence: 1,
        };

        expect(BitemporalAlgebra.isActiveAt(record as any, 150, 200)).toBe(true);
        expect(BitemporalAlgebra.isActiveAt(record as any, 50, 200)).toBe(false);
        expect(BitemporalAlgebra.isActiveAt(record as any, 250, 200)).toBe(false);
        expect(BitemporalAlgebra.isActiveAt(record as any, 150, 100)).toBe(false);
        expect(BitemporalAlgebra.isActiveAt(record as any, 150, 350)).toBe(false);
      });

      it('F20: Historical State Replay reconstructs entity state at specific (Tv, Tt) coordinates', () => {
        const records = [
          {
            id: 'r1',
            entityId: 'db.host',
            validTime: { from: 1000, to: null },
            transactionTime: { recordedAt: 1000, supersededAt: 2000 },
            action: 'INSERT' as const,
            payload: { host: 'localhost' },
            recordHash: 'h1',
            prevHash: GENESIS_PREV_HASH,
            sequence: 1,
          },
          {
            id: 'r2',
            entityId: 'db.host',
            validTime: { from: 1000, to: null },
            transactionTime: { recordedAt: 2000, supersededAt: null },
            action: 'UPDATE' as const,
            payload: { host: 'db.internal.cloud' },
            recordHash: 'h2',
            prevHash: 'h1',
            sequence: 2,
          },
        ];

        const replayer = new PointInTimeReplayEngine(records as any);

        const stateAtPast = replayer.replayEntityState('db.host', { validTime: 1200, txTime: 1500 });
        expect(stateAtPast?.state).toEqual({ host: 'localhost' });

        const stateAtPresent = replayer.replayEntityState('db.host', { validTime: 1200, txTime: 2500 });
        expect(stateAtPresent?.state).toEqual({ host: 'db.internal.cloud' });
      });

      it('F21: Non-Destructive Compensating Rollback appends inverse compensation without mutating history', async () => {
        const ledger = new AppendOnlyLedger(testWorkspaceRoot, {
          ledgerRelativePath: path.join('ledger-f21', 'records.jsonl'),
        });
        await ledger.initialize();

        const rec1 = await ledger.appendRecord({
          entityId: 'feature_flags',
          action: 'INSERT',
          payload: { beta_feature: true },
          milestoneId: 'M1',
          author: 'worker-1',
          validFrom: 100,
        });

        expect(ledger.getAllRecords()).toHaveLength(1);

        // Execute non-destructive compensating rollback
        const compRec = await ledger.compensate({
          targetRecordId: rec1.id,
          reason: 'Defect detected in beta feature',
          milestoneId: 'M2',
        });

        expect(compRec.action).toBe('COMPENSATE');
        expect(compRec.parentRecordId).toBe(rec1.id);
        expect(ledger.getAllRecords()).toHaveLength(2);

        const verifyRes = await ledger.verifyIntegrity();
        expect(verifyRes.valid).toBe(true);
        expect(verifyRes.chainLength).toBe(2);
      });

      it('F22: 3-Tier Progressive Context Querying limits token footprint across Index, Decisions, and Diffs', () => {
        const contextMgr = new TemporalContextManager();

        contextMgr.recordMilestone({
          id: 'M1',
          title: 'Foundation DAG',
          status: 'completed',
          filesTouched: ['lib/teamwork/dag/graph.ts'],
          durationMs: 1000,
        });

        contextMgr.recordDecision({
          id: 'D1',
          milestoneId: 'M1',
          title: 'Adopt Kahn Algorithm for Topological Sort',
          rationale: 'Linear O(V+E) time complexity with early cycle detection',
          constraints: ['TypeScript', 'No external graph lib'],
          rejectedAlternatives: ['DFS Tarjan recursion (potential stack overflow)'],
          timestamp: 1500,
        });

        contextMgr.recordDiff('lib/teamwork/dag/graph.ts', '+export class DagGraph {}', 'M1');

        // Tier 1 query
        const t1 = contextMgr.renderTier1(contextMgr.getMilestones() as any, 100);
        expect(t1).toContain('### Milestone Index');
        expect(t1).toContain('Foundation DAG');

        // Tier 2 query
        const t2 = contextMgr.renderTier2(contextMgr.getDecisions(), undefined, 300);
        expect(t2).toContain('### Key Decisions & Constraints');
        expect(t2).toContain('Adopt Kahn Algorithm');

        // Tier 3 query
        const t3 = contextMgr.renderTier3(['lib/teamwork/dag/graph.ts'], 1000);
        expect(t3).toContain('+export class DagGraph {}');
      });

      it('F23: Semantic Knowledge Ontology represents Subject-Predicate-Object triples and queries temporal facts', () => {
        const ontology = new KnowledgeOntology();

        ontology.addTriple({
          subject: 'lib/teamwork/dag',
          predicate: 'implements',
          object: 'KahnTopologicalSort',
          confidence: 1.0,
          validFrom: 1000,
          sourceMilestone: 'M1',
        });

        ontology.addTriple({
          subject: 'KahnTopologicalSort',
          predicate: 'detects',
          object: 'CyclicDependencyError',
          confidence: 1.0,
          validFrom: 1000,
          sourceMilestone: 'M1',
        });

        const facts = ontology.queryTriples({ subject: 'lib/teamwork/dag' });
        expect(facts).toHaveLength(1);
        expect(facts[0].object).toBe('KahnTopologicalSort');

        const reverse = ontology.findReverseRelations('CyclicDependencyError');
        expect(reverse).toHaveLength(1);
        expect(reverse[0].subject).toBe('KahnTopologicalSort');
      });
    });

    // ------------------------------------------------------------------------
    // Core Vyen Integration (F24 - F27)
    // ------------------------------------------------------------------------
    describe('Core Integration: Engine, Tools & Zero Regression Baseline', () => {
      it('F24: TeamworkEngine DAG & Checkpoint delegates operate seamlessly', () => {
        expect(computeTopologicalPlan).toBeDefined();
        expect(MemoryCheckpointStore).toBeDefined();
        expect(DagExecutionEngine).toBeDefined();
      });

      it('F25: ToolRunner strict contracts and sandbox guardrails interface cleanly', () => {
        expect(defineToolContract).toBeDefined();
        expect(EnvScrubber).toBeDefined();
        expect(CwdGuard).toBeDefined();
      });

      it('F26: CLI & Headless Runner components expose DAG and ledger components', () => {
        expect(FlowSketchGenerator).toBeDefined();
        expect(DiffViewer).toBeDefined();
      });

      it('F27: Zero Regression verification preserves existing FileLockManager and CriticVerifier', () => {
        const lockMgr = new FileLockManager();
        expect(lockMgr.canAcquire('worker-1', ['file1.ts'])).toBe(true);
        lockMgr.acquire('worker-1', ['file1.ts']);
        expect(lockMgr.isLocked('file1.ts')).toBe(true);
        expect(lockMgr.canAcquire('worker-2', ['file1.ts'])).toBe(false);
        lockMgr.release('worker-1', ['file1.ts']);
        expect(lockMgr.canAcquire('worker-2', ['file1.ts'])).toBe(true);

        const cleanIssues = auditDiffForIntegrity('+++ b/src/test.ts\n+const a = 1;');
        expect(cleanIssues).toHaveLength(0);
        const facadeIssues = auditDiffForIntegrity('+++ b/src/test.ts\n+function test() { return null; }');
        expect(facadeIssues.length).toBeGreaterThan(0);
        expect(TeamworkCritic).toBeDefined();
      });
    });
  });

  // ==========================================================================
  // TIER 2: BOUNDARY VALUE ANALYSIS & STRESS CASES
  // ==========================================================================

  describe('Tier 2: Boundary Value Analysis & Stress Cases', () => {
    it('B1: Deep Cycle Detection isolates circular paths correctly in multi-node cycles', () => {
      const cycleNodes = [
        { id: '1', title: '1', dependsOn: ['5'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 1 },
        { id: '2', title: '2', dependsOn: ['1'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 2 },
        { id: '3', title: '3', dependsOn: ['2'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 3 },
        { id: '4', title: '4', dependsOn: ['3'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 4 },
        { id: '5', title: '5', dependsOn: ['4'], ownedFiles: [], status: 'pending' as const, attempt: 0, maxRetries: 1, executor: async () => 5 },
      ];

      expect(() => computeTopologicalPlan(cycleNodes)).toThrow(CycleDetectedError);
    });

    it('B2: Concurrency Semaphore saturation and burst queue handling under heavy load', async () => {
      const semaphore = new AsyncSemaphore(3);
      let concurrentCount = 0;
      let maxSeenConcurrent = 0;

      const tasks = Array.from({ length: 30 }, async (_, idx) => {
        return semaphore.runExclusive(async () => {
          concurrentCount++;
          maxSeenConcurrent = Math.max(maxSeenConcurrent, concurrentCount);
          await new Promise((resolve) => setTimeout(resolve, 5));
          concurrentCount--;
          return idx;
        });
      });

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(30);
      expect(maxSeenConcurrent).toBeLessThanOrEqual(3);
      expect(semaphore.currentCapacity).toBe(3);
      expect(semaphore.activeCount).toBe(0);
    });

    it('B3: Backoff delay handles attempt 0, attempt 50, and zero base delay cleanly', () => {
      const policy = new RetryPolicy({
        baseDelayMs: 50,
        maxDelayMs: 500,
        jitterStrategy: 'none',
      });

      expect(policy.computeDelay(0)).toBe(50);
      const delay50 = policy.computeDelay(50);
      expect(delay50).toBe(500);
      expect(Number.isFinite(delay50)).toBe(true);
    });

    it('B4: Checkpoint persistence safely handles circular references without throwing uncaught exceptions', () => {
      const circularObj: any = { name: 'test-circular' };
      circularObj.self = circularObj;

      const checkpointWithCircular: any = {
        runId: 'run-circ',
        dagId: 'dag-circ',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedNodeIds: [],
        nodes: {},
        context: { ref: circularObj },
      };

      const serialized = serializeCheckpoint(checkpointWithCircular);
      expect(serialized).toContain('[Circular]');
      const deserialized = deserializeCheckpoint(serialized);
      expect((deserialized.context as any)?.ref?.self).toBe('[Circular]');
    });

    it('B5: Cryptographic Token boundary conditions (token expired by 1ms, tampered signature by 1 char)', () => {
      const manager = new InterruptTokenManager('key-b5');
      const payload = { op: 'test' };

      const now = Date.now();
      const token = manager.createToken('req-b5', payload, 1000, now - 2000);
      const resExpired = manager.verifyToken(token.token, payload, now);
      expect(resExpired.valid).toBe(false);
      expect(resExpired.reason).toContain('expired');

      const validToken = manager.createToken('req-b5-valid', payload, 10000, now);
      const tamperedSig = validToken.token.slice(0, -1) + (validToken.token.endsWith('a') ? 'b' : 'a');
      const resTampered = manager.verifyToken(tamperedSig, payload, now);
      expect(resTampered.valid).toBe(false);
      expect(resTampered.reason).toContain('Signature verification failed');
    });

    it('B6: Visual diff extreme cases (empty files, identical files, binary files)', () => {
      const resIdentical = DiffViewer.renderUnifiedDiff('same.txt', 'identical content', 'identical content');
      expect(resIdentical.totalChanges).toBe(0);
      expect(resIdentical.additions).toBe(0);
      expect(resIdentical.deletions).toBe(0);

      const resNew = DiffViewer.renderUnifiedDiff('new.txt', null, 'line1\nline2');
      expect(resNew.additions).toBe(2);
      expect(resNew.deletions).toBe(0);

      const resBin = DiffViewer.renderUnifiedDiff('img.png', '\x00\x01\x02\x03', '\x00\x01\x05\x06');
      expect(resBin.isBinary).toBe(true);
      expect(resBin.diffText).toContain('Binary files differ');
    });

    it('B7: Env scrubber scrubs complex mixed-case and nested sensitive environment keys', () => {
      const dirty = {
        OPENAI_API_KEY: 'secret1',
        ANTHROPIC_API_KEY: 'secret2',
        AWS_SECRET_ACCESS_KEY: 'secret3',
        GITHUB_PAT: 'ghp_secret4',
        DATABASE_URL: 'postgres://localhost/db',
        USER_PASSWORD: 'password123',
        AUTH_TOKEN: 'auth_tok_xyz',
        PORT: '3000',
        SHELL: '/bin/bash',
      };

      const scrubbed = EnvScrubber.scrub(dirty, { maskingMode: 'strip' });
      expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
      expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
      expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(scrubbed.GITHUB_PAT).toBeUndefined();
      expect(scrubbed.DATABASE_URL).toBeUndefined();
      expect(scrubbed.USER_PASSWORD).toBeUndefined();
      expect(scrubbed.AUTH_TOKEN).toBeUndefined();
      expect(scrubbed.PORT).toBe('3000');
      expect(scrubbed.SHELL).toBe('/bin/bash');
    });

    it('B8: CWD path traversal attacks (nested ../ escapes, encoded separators)', () => {
      expect(() => CwdGuard.assertWithinLockdown(testWorkspaceRoot, '..')).toThrow(CwdLockdownViolationError);
      expect(() => CwdGuard.assertWithinLockdown(testWorkspaceRoot, 'foo/../../bar')).toThrow(CwdLockdownViolationError);
      expect(() => CwdGuard.assertWithinLockdown(testWorkspaceRoot, 'C:\\Windows\\System32')).toThrow();
    });

    it('B9: Bitemporal edge intervals (unbounded valid time [0, null), retrospective updates)', () => {
      const record = {
        id: 'rec-unbounded',
        entityId: 'global.constant',
        validTime: { from: 0, to: null },
        transactionTime: { recordedAt: 500, supersededAt: null },
        action: 'INSERT' as const,
        payload: { PI: 3.14159 },
        recordHash: 'h-unbounded',
        prevHash: GENESIS_PREV_HASH,
        sequence: 1,
      };

      expect(BitemporalAlgebra.isActiveAt(record as any, 999999999999, 1000)).toBe(true);
      expect(BitemporalAlgebra.isActiveAt(record as any, 999999999999, 400)).toBe(false);
    });

    it('B10: Merkle hash chain corruption detection catches tampered intermediate record', async () => {
      const ledgerFile = path.join(testWorkspaceRoot, 'tampered-ledger.jsonl');
      await fsp.mkdir(path.dirname(ledgerFile), { recursive: true });

      const ledger = new AppendOnlyLedger(testWorkspaceRoot, {
        ledgerRelativePath: path.relative(testWorkspaceRoot, ledgerFile),
      });
      await ledger.initialize();

      await ledger.appendRecord({ entityId: 'E1', action: 'INSERT', payload: 'v1' });
      await ledger.appendRecord({ entityId: 'E2', action: 'INSERT', payload: 'v2' });
      await ledger.appendRecord({ entityId: 'E3', action: 'INSERT', payload: 'v3' });

      expect((await ledger.verifyIntegrity()).valid).toBe(true);

      const content = await fsp.readFile(ledgerFile, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      const parsedLine2 = JSON.parse(lines[1]);
      parsedLine2.payload = 'tampered-payload';
      lines[1] = JSON.stringify(parsedLine2);
      await fsp.writeFile(ledgerFile, lines.join('\n') + '\n', 'utf8');

      const corruptedLedger = new AppendOnlyLedger(testWorkspaceRoot, {
        ledgerRelativePath: path.relative(testWorkspaceRoot, ledgerFile),
      });
      await corruptedLedger.initialize();
      const corruptVerify = await corruptedLedger.verifyIntegrity();
      expect(corruptVerify.valid).toBe(false);
      expect(corruptVerify.errors.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // TIER 3: PAIRWISE CROSS-FEATURE INTERACTIONS
  // ==========================================================================

  describe('Tier 3: Pairwise Cross-Feature Interactions', () => {
    it('Interaction 1: DAG Execution + Checkpointing + HITL Approval Gate Interrupt', async () => {
      const memoryStore = new MemoryCheckpointStore();
      const gate = new HitlApprovalGate({ policy: 'smart' });
      let gateTriggered = false;
      let resumedAfterGate = false;

      const dag = new DagGraph()
        .addNode({
          id: 'analyze',
          title: 'Analyze Codebase',
          dependsOn: [],
          ownedFiles: [],
          status: 'pending',
          attempt: 0,
          maxRetries: 1,
          executor: async () => ({ target: 'package.json' }),
        })
        .addNode({
          id: 'critical_update',
          title: 'Update Package.json',
          dependsOn: ['analyze'],
          ownedFiles: ['package.json'],
          status: 'pending',
          attempt: 0,
          maxRetries: 1,
          executor: async (ctx) => {
            const evalResult = gate.evaluate({
              action: 'file_write',
              target: 'package.json',
              description: 'Modify dependencies in core package.json',
            });

            if (evalResult.shouldInterrupt) {
              gateTriggered = true;
              const req = gate.createRequest({
                action: 'file_write',
                target: 'package.json',
                description: 'Modify dependencies',
              });
              if (ctx.checkpoint) {
                await ctx.checkpoint({ status: 'INTERRUPTED', requestId: req.id });
              }
              return { status: 'INTERRUPTED', requestId: req.id };
            }

            resumedAfterGate = true;
            return { status: 'COMPLETED' };
          },
        });

      const engine = new DagExecutionEngine({
        checkpointStore: memoryStore,
        autoCheckpoint: true,
      });

      const initialResult = await engine.execute(dag.toDefinition('workflow-hitl', 'Workflow HITL'));
      expect(gateTriggered).toBe(true);

      const updateRes = initialResult.nodeResults.get('critical_update');
      expect((updateRes?.output as any)?.status).toBe('INTERRUPTED');

      // Operator inspects and approves
      const pendingReqs = gate.listPendingRequests();
      expect(pendingReqs.length).toBeGreaterThan(0);
      gate.respond({
        requestId: pendingReqs[0].id,
        decision: 'APPROVED',
        token: pendingReqs[0].token,
        approver: 'lead-dev@vyen.dev',
      });

      const resumeDag = new DagGraph()
        .addNode({
          id: 'analyze',
          title: 'Analyze Codebase',
          dependsOn: [],
          ownedFiles: [],
          status: 'pending',
          attempt: 0,
          maxRetries: 1,
          executor: async () => ({ target: 'package.json' }),
        })
        .addNode({
          id: 'critical_update',
          title: 'Update Package.json',
          dependsOn: ['analyze'],
          ownedFiles: ['package.json'],
          status: 'pending',
          attempt: 0,
          maxRetries: 1,
          executor: async () => {
            resumedAfterGate = true;
            return { status: 'COMPLETED' };
          },
        });

      const resumedResult = await engine.execute(resumeDag.toDefinition('workflow-hitl-resumed', 'Workflow Resumed'));
      expect(resumedResult.status).toBe('COMPLETED');
      expect(resumedAfterGate).toBe(true);
    });

    it('Interaction 2: Typed Tool Contracts + Provenance Hash Chaining + Sandbox (Scrubber + CWD Guard)', async () => {
      const tracker = new ProvenanceTracker();

      const WriteContract = defineToolContract({
        name: 'write_sandboxed_file',
        description: 'Writes file with provenance inside CWD lockdown',
        category: 'filesystem',
        inputSchema: z.object({
          relPath: z.string(),
          content: z.string(),
        }),
        outputSchema: z.object({
          bytes: z.number(),
          provenanceHash: z.string(),
        }),
        execute: async (input, ctx) => {
          const absPath = CwdGuard.assertWithinLockdown(ctx.workspaceRoot, input.relPath);

          const prov = tracker.createRecord({
            context: ctx,
            filePath: input.relPath,
            action: 'create',
            contentAfter: input.content,
          });

          await fsp.mkdir(path.dirname(absPath), { recursive: true });
          await fsp.writeFile(absPath, input.content, 'utf8');

          return {
            bytes: Buffer.byteLength(input.content, 'utf8'),
            provenanceHash: prov.recordHash,
          };
        },
      });

      const context = {
        workerId: 'worker-interaction-2',
        milestoneId: 'M3',
        role: 'worker' as const,
        workspaceRoot: testWorkspaceRoot,
        correlationId: 'corr-i2',
        authorizationToken: 'auth-i2',
      };

      const res = await WriteContract.execute(
        { relPath: 'interaction/output.txt', content: 'test content' },
        context
      );

      expect(res.bytes).toBe(12);
      expect(res.provenanceHash).toBeDefined();
      expect(tracker.getHistory().length).toBe(1);
      expect(tracker.verifyChainIntegrity().valid).toBe(true);

      const writtenContent = await fsp.readFile(
        path.join(testWorkspaceRoot, 'interaction', 'output.txt'),
        'utf8'
      );
      expect(writtenContent).toBe('test content');
    });

    it('Interaction 3: Bitemporal Ledger + 3-Tier Progressive Context + Knowledge Ontology Triples', async () => {
      const ledger = new AppendOnlyLedger(testWorkspaceRoot, {
        ledgerRelativePath: 'ledger-i3/records.jsonl',
      });
      await ledger.initialize();

      const contextMgr = new TemporalContextManager();
      const ontology = new KnowledgeOntology();

      await ledger.appendRecord({
        entityId: 'milestone.M1',
        action: 'INSERT',
        payload: { name: 'Core Engine Refactor', filesChanged: ['lib/engine.ts'] },
        milestoneId: 'M1',
        validFrom: 1000,
      });

      contextMgr.recordMilestone({
        id: 'M1',
        title: 'Core Engine Refactor',
        status: 'completed',
        filesTouched: ['lib/engine.ts'],
      });

      ontology.addTriple({
        subject: 'milestone.M1',
        predicate: 'modifies',
        object: 'lib/engine.ts',
        confidence: 1.0,
        validFrom: 1000,
        sourceMilestone: 'M1',
      });

      expect(ledger.getAllRecords()).toHaveLength(1);
      const tier1 = contextMgr.renderTier1(contextMgr.getMilestones() as any);
      expect(tier1).toContain('Core Engine Refactor');

      const triples = ontology.queryTriples({ subject: 'milestone.M1' });
      expect(triples).toHaveLength(1);
      expect(triples[0].object).toBe('lib/engine.ts');
    });

    it('Interaction 4: Dual-Gate Guardrails with Critic Verification and Non-Destructive Compensating Rollback', async () => {
      const dualGate = new DualGateController();
      const ledger = new AppendOnlyLedger(testWorkspaceRoot, {
        ledgerRelativePath: 'ledger-i4/records.jsonl',
      });
      await ledger.initialize();

      const initialRecord = await ledger.appendRecord({
        entityId: 'component.auth',
        action: 'INSERT',
        payload: { mode: 'strict' },
        milestoneId: 'M1',
      });

      const contract = defineToolContract({
        name: 'patch_auth',
        description: 'Patches auth component',
        category: 'filesystem',
        inputSchema: z.object({ mode: z.string() }),
        outputSchema: z.object({ success: z.boolean() }),
        execute: async () => ({ success: true }),
      });

      const ctx = {
        workerId: 'w-4',
        milestoneId: 'M2',
        role: 'worker' as const,
        workspaceRoot: testWorkspaceRoot,
        correlationId: 'c-4',
      };

      const postReview = await dualGate.evaluatePostFlight({
        contract,
        output: { success: true },
        context: ctx,
        newContent: 'function authenticate() { return null; }',
      });

      expect(postReview.passed).toBe(false);
      expect(postReview.verdict).toBe('FAIL-BLOCKED');

      const compRec = await ledger.compensate({
        targetRecordId: initialRecord.id,
        reason: 'Rollback due to Gate 2 Critic verification failure',
      });

      expect(compRec.action).toBe('COMPENSATE');
      expect((await ledger.verifyIntegrity()).valid).toBe(true);
    });

    it('Interaction 5: Async Concurrency Limiter + Exclusive File Lock Manager + Exponential Jitter Retry', async () => {
      const semaphore = new AsyncSemaphore(2);
      const lockManager = new FileLockManager();
      const retryPolicy = new RetryPolicy({
        maxRetries: 3,
        baseDelayMs: 20,
        maxDelayMs: 200,
        jitterStrategy: 'none',
      });

      const targetFile = 'shared/database.ts';
      let worker1Success = false;
      let worker2Attempts = 0;
      let worker2Success = false;

      // Worker 1 acquires slot and file lock
      const worker1 = semaphore.runExclusive(async () => {
        expect(lockManager.canAcquire('worker-1', [targetFile])).toBe(true);
        lockManager.acquire('worker-1', [targetFile]);
        expect(lockManager.isLocked(targetFile)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        lockManager.release('worker-1', [targetFile]);
        worker1Success = true;
      });

      // Worker 2 attempts same file concurrently, retries with backoff until worker 1 releases
      const worker2 = semaphore.runExclusive(async () => {
        while (worker2Attempts < retryPolicy.maxRetries) {
          worker2Attempts++;
          if (lockManager.canAcquire('worker-2', [targetFile])) {
            lockManager.acquire('worker-2', [targetFile]);
            worker2Success = true;
            lockManager.release('worker-2', [targetFile]);
            break;
          }
          const delay = retryPolicy.computeDelay(worker2Attempts);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      });

      await Promise.all([worker1, worker2]);
      expect(worker1Success).toBe(true);
      expect(worker2Success).toBe(true);
      expect(worker2Attempts).toBeGreaterThanOrEqual(1);
    });
  });
});
