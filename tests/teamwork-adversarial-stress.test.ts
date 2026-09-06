import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

// DAG Engine
import {
  AsyncSemaphore,
  computeTopologicalPlan,
  CycleDetectedError,
  DagEngineError,
  DagExecutionEngine,
  DagGraph,
  DagNode,
  DependencyFailedError,
  ExecutionTimeoutError,
  MissingDependencyError,
  RetryPolicy,
} from '../lib/teamwork/dag';

// Checkpoint Store
import {
  CheckpointSerializationError,
  FileCheckpointStore,
  MemoryCheckpointStore,
  computeDagDefinitionHash,
  deserializeCheckpoint,
  generateIdempotencyToken,
  parseIdempotencyToken,
  serializeCheckpoint,
  type WorkflowCheckpoint,
} from '../lib/teamwork/checkpoint';

// HITL & Cryptographic Tokens
import {
  HitlApprovalGate,
  InterruptTokenManager,
  createInterruptToken,
  verifyInterruptToken,
  TokenVerificationError,
} from '../lib/teamwork/hitl';

// Tool Contracts & Provenance
import {
  calculateSha256,
  defineToolContract,
  DualGateController,
  GENESIS_HASH,
  ProvenanceTracker,
  validateToolInput,
  validateToolOutput,
  type ToolExecutionContext,
} from '../lib/teamwork/contracts';

// Sandbox & Isolation
import {
  CwdGuard,
  CwdLockdownViolationError,
  EnvScrubber,
  SandboxedProcessManager,
  TempIsolationManager,
} from '../lib/teamwork/sandbox';

// Bitemporal Ledger & Replay
import {
  AppendOnlyLedger,
  BitemporalAlgebra,
  GENESIS_PREV_HASH,
  PointInTimeReplayEngine,
} from '../lib/teamwork/ledger';

describe('Adversarial Verifier & Stress Challenger: Teamwork Capabilities', () => {
  const workspaceRoot = path.resolve(process.cwd());
  let tempTestDir: string;

  beforeEach(async () => {
    tempTestDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vyen-stress-'));
  });

  afterEach(async () => {
    await TempIsolationManager.cleanupAll();
    try {
      await fsp.rm(tempTestDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error in temp
    }
  });

  // =========================================================================
  // 1. DAG ENGINE ADVERSARIAL STRESS
  // =========================================================================
  describe('1. DAG Engine & Concurrency Stress', () => {
    it('handles deeply nested sequential graphs (50+ nodes) without stack overflow', async () => {
      const CHAIN_LENGTH = 50;
      const nodes: DagNode<number, number>[] = [];

      for (let i = 0; i < CHAIN_LENGTH; i++) {
        nodes.push({
          id: `node-${i}`,
          name: `Step ${i}`,
          dependsOn: i === 0 ? [] : [`node-${i - 1}`],
          execute: async (ctx) => {
            const prev = i === 0 ? 0 : ((ctx.parentOutputs.get(`node-${i - 1}`) as number) ?? 0);
            return prev + 1;
          },
        });
      }

      const plan = computeTopologicalPlan(nodes);
      expect(plan.sortedNodeIds.length).toBe(CHAIN_LENGTH);
      expect(plan.levels.length).toBe(CHAIN_LENGTH);
      expect(plan.initialReadyNodes).toEqual(['node-0']);
      expect(plan.leafNodes).toEqual([`node-${CHAIN_LENGTH - 1}`]);

      const engine = new DagExecutionEngine({ concurrencyCap: 4 });
      const result = await engine.execute({ id: 'chain-dag', nodes });

      expect(result.status).toBe('COMPLETED');
      expect(result.nodeResults.get(`node-${CHAIN_LENGTH - 1}`)?.output).toBe(CHAIN_LENGTH);
    });

    it('enforces concurrency limits strictly in ultra-wide parallel graphs (20 branches)', async () => {
      const CONCURRENCY_CAP = 3;
      const PARALLEL_COUNT = 20;

      let activeWorkers = 0;
      let peakConcurrency = 0;

      const nodes: DagNode[] = [];
      const branchIds: string[] = [];

      for (let i = 0; i < PARALLEL_COUNT; i++) {
        const id = `branch-${i}`;
        branchIds.push(id);
        nodes.push({
          id,
          dependsOn: [],
          execute: async () => {
            activeWorkers++;
            peakConcurrency = Math.max(peakConcurrency, activeWorkers);
            await new Promise((r) => setTimeout(r, 20));
            activeWorkers--;
            return `done-${id}`;
          },
        });
      }

      // Join / sink node
      nodes.push({
        id: 'join-node',
        dependsOn: branchIds,
        execute: async () => {
          return 'all-branches-synced';
        },
      });

      const engine = new DagExecutionEngine({ concurrencyCap: CONCURRENCY_CAP });
      const result = await engine.execute({ id: 'wide-dag', nodes, concurrencyCap: CONCURRENCY_CAP });

      expect(result.status).toBe('COMPLETED');
      expect(peakConcurrency).toBeLessThanOrEqual(CONCURRENCY_CAP);
      expect(result.nodeResults.get('join-node')?.status).toBe('completed');
    });

    it('detects 2-node cycles, multi-node cycles, and self-loops with CycleDetectedError', () => {
      // 1. Direct self-dependency
      const selfLoopNodes: DagNode[] = [
        { id: 'A', dependsOn: ['A'], execute: async () => 'A' },
      ];
      expect(() => computeTopologicalPlan(selfLoopNodes)).toThrow(CycleDetectedError);

      // 2. 2-node cycle
      const twoNodeCycle: DagNode[] = [
        { id: 'A', dependsOn: ['B'], execute: async () => 'A' },
        { id: 'B', dependsOn: ['A'], execute: async () => 'B' },
      ];
      expect(() => computeTopologicalPlan(twoNodeCycle)).toThrow(CycleDetectedError);

      // 3. Multi-node cycle embedded in otherwise valid graph
      const cycleNodes: DagNode[] = [
        { id: 'Start', dependsOn: [], execute: async () => 'Start' },
        { id: 'A', dependsOn: ['Start'], execute: async () => 'A' },
        { id: 'B', dependsOn: ['A', 'D'], execute: async () => 'B' },
        { id: 'C', dependsOn: ['B'], execute: async () => 'C' },
        { id: 'D', dependsOn: ['C'], execute: async () => 'D' },
      ];
      expect(() => computeTopologicalPlan(cycleNodes)).toThrow(CycleDetectedError);
    });

    it('detects missing dependencies and duplicate node IDs', () => {
      // Missing dependency
      const missingDepNodes: DagNode[] = [
        { id: 'A', dependsOn: ['NON_EXISTENT'], execute: async () => 'A' },
      ];
      expect(() => computeTopologicalPlan(missingDepNodes)).toThrow(MissingDependencyError);

      // Duplicate node ID
      const duplicateNodes: DagNode[] = [
        { id: 'A', dependsOn: [], execute: async () => 'A1' },
        { id: 'A', dependsOn: [], execute: async () => 'A2' },
      ];
      expect(() => computeTopologicalPlan(duplicateNodes)).toThrow(DagEngineError);
    });

    it('isolates failed branch while allowing independent branches to complete', async () => {
      // Root -> LeftFails -> LeftChild (should be blocked)
      // Root -> RightSucceeds -> RightChild (should complete)
      const nodes: DagNode[] = [
        { id: 'root', dependsOn: [], execute: async () => 'root-ok' },
        {
          id: 'left-fail',
          dependsOn: ['root'],
          retryPolicy: { maxRetries: 0 },
          execute: async () => {
            throw new Error('Left branch intentional explosion');
          },
        },
        { id: 'left-child', dependsOn: ['left-fail'], execute: async () => 'never-run' },
        { id: 'right-ok', dependsOn: ['root'], execute: async () => 'right-ok' },
        { id: 'right-child', dependsOn: ['right-ok'], execute: async () => 'right-child-ok' },
      ];

      const engine = new DagExecutionEngine();
      const result = await engine.execute({ id: 'cascade-test', nodes });

      expect(result.status).toBe('FAILED');
      expect(result.nodeResults.get('root')?.status).toBe('completed');
      expect(result.nodeResults.get('left-fail')?.status).toBe('failed');
      expect(result.nodeResults.get('left-child')?.status).toBe('blocked');
      expect(result.nodeResults.get('right-ok')?.status).toBe('completed');
      expect(result.nodeResults.get('right-child')?.status).toBe('completed');
    });

    it('enforces node-level execution timeout correctly via signal cancellation', async () => {
      const nodes: DagNode[] = [
        {
          id: 'hanging-node',
          dependsOn: [],
          timeoutMs: 80,
          retryPolicy: { maxRetries: 0 },
          execute: async (ctx) => {
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => resolve('should-have-timed-out'), 1000);
              ctx.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(ctx.signal.reason);
              });
            });
          },
        },
      ];

      const engine = new DagExecutionEngine();
      const result = await engine.execute({ id: 'timeout-test', nodes });

      expect(result.status).toBe('FAILED');
      const nodeRes = result.nodeResults.get('hanging-node');
      expect(nodeRes?.status).toBe('failed');
      expect(nodeRes?.error).toMatch(/timed out/i);
    });

    it('validates all backoff jitter strategies and delay bounds', async () => {
      const strategies = ['none', 'full', 'equal', 'authoritative', 'decorrelated'] as const;

      for (const strategy of strategies) {
        const policy = new RetryPolicy({
          maxRetries: 4,
          baseDelayMs: 20,
          maxDelayMs: 200,
          factor: 2,
          jitterStrategy: strategy,
        });

        for (let attempt = 1; attempt <= 4; attempt++) {
          const delay = policy.computeDelay(attempt);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(200);
        }
      }

      // Test abort signal cancellation during waitDelay
      const policy = new RetryPolicy({ baseDelayMs: 500, maxDelayMs: 500 });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);

      await expect(policy.waitDelay(1, controller.signal)).rejects.toThrow(/aborted by signal/i);
    });
  });

  // =========================================================================
  // 2. CHECKPOINT STORE & SERIALIZATION ADVERSARIAL STRESS
  // =========================================================================
  describe('2. Checkpoint Store & Resumption Resilience', () => {
    it('handles 50 rapid sequential saves and loads without corruption', async () => {
      const fileStore = new FileCheckpointStore(tempTestDir);

      for (let i = 1; i <= 50; i++) {
        const checkpoint: WorkflowCheckpoint = {
          version: '1.0.0',
          runId: 'stress-run',
          dagId: 'stress-dag',
          dagDefinitionHash: 'hash-abc',
          status: 'running',
          createdAt: 1000,
          updatedAt: 1000 + i,
          completedNodeIds: [`node-${i}`],
          failedNodeIds: [],
          blockedNodeIds: [],
          nodes: {
            [`node-${i}`]: {
              nodeId: `node-${i}`,
              status: 'completed',
              attempt: 1,
              output: { step: i },
            },
          },
          context: { iteration: i },
        };

        await fileStore.save(checkpoint);
      }

      const latest = await fileStore.latest('stress-dag');
      expect(latest).not.toBeNull();
      expect(latest?.context?.iteration).toBe(50);
      expect(latest?.completedNodeIds).toContain('node-50');

      const loaded = await fileStore.load('stress-run');
      expect(loaded).not.toBeNull();
      expect(loaded?.context?.iteration).toBe(50);
    });

    it('rejects corrupted JSON during deserialization with CheckpointSerializationError', () => {
      const badInputs = [
        '',
        '   ',
        '{ invalid json }',
        'null',
        '42',
        '"just a string"',
        JSON.stringify({ runId: 'r1' }), // missing dagId, nodes, status
        JSON.stringify({ runId: 'r1', dagId: 'd1' }), // missing nodes, status
        JSON.stringify({ runId: 'r1', dagId: 'd1', nodes: 'not-an-object', status: 'running' }),
        JSON.stringify({ runId: '', dagId: 'd1', nodes: {}, status: 'running' }), // empty runId
      ];

      for (const bad of badInputs) {
        expect(() => deserializeCheckpoint(bad)).toThrow(CheckpointSerializationError);
      }
    });

    it('safely serializes circular references, Sets, Maps, and Errors without crash', () => {
      const circularObj: any = { name: 'circular-root' };
      circularObj.self = circularObj;

      const mapVal = new Map<string, unknown>();
      mapVal.set('k1', 'v1');
      mapVal.set('k2', 123);

      const setVal = new Set(['item1', 'item2']);
      const errVal = new Error('checkpoint test error');

      const checkpoint: WorkflowCheckpoint = {
        version: '1.0.0',
        runId: 'circular-run',
        dagId: 'circular-dag',
        status: 'paused',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedNodeIds: ['node-1'],
        failedNodeIds: [],
        blockedNodeIds: [],
        nodes: {
          'node-1': {
            nodeId: 'node-1',
            status: 'completed',
            attempt: 1,
            output: { circular: circularObj, map: mapVal, set: setVal, error: errVal },
          },
        },
        context: { complex: circularObj },
      };

      const serialized = serializeCheckpoint(checkpoint);
      expect(serialized).toContain('[Circular]');

      const deserialized = deserializeCheckpoint(serialized);
      expect(deserialized.runId).toBe('circular-run');
      expect(deserialized.status).toBe('paused');
      expect(deserialized.nodes['node-1'].output).toBeDefined();
    });

    it('generates and parses idempotency tokens reliably', () => {
      const token = generateIdempotencyToken('run-42', 'node-auth', 3);
      expect(token).toBe('run-42:node-auth:3');

      const parsed = parseIdempotencyToken(token);
      expect(parsed).toEqual({
        runId: 'run-42',
        nodeId: 'node-auth',
        attempt: 3,
      });

      // Malformed tokens
      expect(parseIdempotencyToken('')).toBeNull();
      expect(parseIdempotencyToken('only:two')).toBeNull();
      expect(parseIdempotencyToken('run:node:not-a-number')).toBeNull();
    });

    it('supports pause and resume without re-running completed tasks', async () => {
      const memStore = new MemoryCheckpointStore();
      let task1Runs = 0;
      let task2Runs = 0;

      const nodes: DagNode[] = [
        {
          id: 'step-1',
          dependsOn: [],
          execute: async () => {
            task1Runs++;
            return 'step-1-out';
          },
        },
        {
          id: 'step-2',
          dependsOn: ['step-1'],
          execute: async () => {
            task2Runs++;
            return 'step-2-out';
          },
        },
      ];

      const engine = new DagExecutionEngine({ checkpointStore: memStore, autoCheckpoint: true });

      // Simulate pausing after step-1
      const initialCheckpoint: WorkflowCheckpoint = {
        version: '1.0.0',
        runId: 'resumable-run',
        dagId: 'resumable-dag',
        status: 'paused',
        createdAt: 1000,
        updatedAt: 1000,
        completedNodeIds: ['step-1'],
        failedNodeIds: [],
        blockedNodeIds: [],
        nodes: {
          'step-1': {
            nodeId: 'step-1',
            status: 'completed',
            attempt: 1,
            output: 'step-1-out',
          },
        },
        context: {},
      };
      await memStore.save(initialCheckpoint);

      // Resume from checkpoint
      const result = await engine.resume(initialCheckpoint, { id: 'resumable-dag', nodes });

      expect(result.status).toBe('COMPLETED');
      expect(task1Runs).toBe(0); // Never re-executed!
      expect(task2Runs).toBe(1); // Executed step 2
      expect(result.nodeResults.get('step-2')?.output).toBe('step-2-out');
    });
  });

  // =========================================================================
  // 3. HITL APPROVAL GATE & CRYPTOGRAPHIC HMAC SECURITY
  // =========================================================================
  describe('3. HITL Approval Gate & Cryptographic Tokens Adversarial Stress', () => {
    const secretKey = 'super-secure-production-hmac-secret-key';
    let gate: HitlApprovalGate;
    let tokenManager: InterruptTokenManager;

    beforeEach(() => {
      gate = new HitlApprovalGate({ secret: secretKey, policy: 'smart' });
      tokenManager = new InterruptTokenManager(secretKey);
    });

    it('rejects tampered HMAC interrupt tokens across multiple attack vectors', () => {
      const payload = { action: 'deploy', target: 'production-v2' };
      const tokenData = tokenManager.createToken('req-attack-1', payload, 60000);
      const originalToken = tokenData.token;

      // 1. Signature byte tampering
      const parts = originalToken.split('.');
      const tamperedSig = parts[5].slice(0, -1) + (parts[5].endsWith('a') ? 'b' : 'a');
      const tamperedTokenSig = [...parts.slice(0, 5), tamperedSig].join('.');
      expect(tokenManager.verifyToken(tamperedTokenSig).valid).toBe(false);

      // 2. Truncated signature
      const truncatedSig = parts[5].slice(0, 16);
      const tamperedTokenTrunc = [...parts.slice(0, 5), truncatedSig].join('.');
      expect(tokenManager.verifyToken(tamperedTokenTrunc).valid).toBe(false);

      // 3. Altering payload hash in token
      const tamperedHash = calculateSha256('malicious-payload');
      const tamperedTokenHash = [parts[0], parts[1], parts[2], parts[3], tamperedHash, parts[5]].join('.');
      expect(tokenManager.verifyToken(tamperedTokenHash).valid).toBe(false);

      // 4. Altering expiration timestamp in token string
      const extendedExpires = (Number(parts[3]) + 1000000).toString();
      const tamperedTokenExp = [parts[0], parts[1], parts[2], extendedExpires, parts[4], parts[5]].join('.');
      expect(tokenManager.verifyToken(tamperedTokenExp).valid).toBe(false);

      // 5. Verifying with different secret key
      const rogueManager = new InterruptTokenManager('different-secret-key-attacker');
      expect(rogueManager.verifyToken(originalToken).valid).toBe(false);
    });

    it('rejects expired tokens cleanly with descriptive expiration reason', () => {
      const now = Date.now();
      // Token created 5 seconds ago with 1 second TTL -> expired 4 seconds ago
      const tokenData = tokenManager.createToken('req-expired', { test: true }, 1000, now - 5000);
      const res = tokenManager.verifyToken(tokenData.token, undefined, now);

      expect(res.valid).toBe(false);
      expect(res.reason).toMatch(/expired/i);
    });

    it('detects payload mismatch when an attacker alters the underlying request', () => {
      const originalPayload = { action: 'file_write', target: 'safe-file.ts' };
      const maliciousPayload = { action: 'file_write', target: 'malicious-exploit.sh' };

      const tokenData = tokenManager.createToken('req-payload-test', originalPayload, 60000);

      // Verify with original payload: passes
      expect(tokenManager.verifyToken(tokenData.token, originalPayload).valid).toBe(true);

      // Verify with malicious payload: fails
      const check = tokenManager.verifyToken(tokenData.token, maliciousPayload);
      expect(check.valid).toBe(false);
      expect(check.reason).toMatch(/payload hash mismatch/i);
    });

    it('survives high-volume concurrent approval requests without race conditions', async () => {
      const CONCURRENT_REQS = 50;
      const createdRequests: any[] = [];

      // Create 50 concurrent requests
      for (let i = 0; i < CONCURRENT_REQS; i++) {
        const req = gate.createRequest({
          action: 'file_write',
          target: `lib/teamwork/core-${i}.ts`,
          description: `Core file modification ${i}`,
          proposedPayload: { fileIndex: i },
        });
        createdRequests.push(req);
      }

      expect(createdRequests.length).toBe(CONCURRENT_REQS);
      expect(createdRequests.every((r) => r.state === 'PENDING_APPROVAL')).toBe(true);

      // Concurrently respond to all 50 requests presenting valid cryptographic tokens
      const responses = await Promise.all(
        createdRequests.map(async (req, idx) => {
          const decision = idx % 2 === 0 ? 'APPROVED' : 'REJECTED';
          return gate.respond({
            requestId: req.id,
            token: req.token,
            decision,
            approver: `admin-${idx}`,
          });
        })
      );

      expect(responses.length).toBe(CONCURRENT_REQS);
      expect(responses.filter((r) => r.state === 'APPROVED').length).toBe(25);
      expect(responses.filter((r) => r.state === 'REJECTED').length).toBe(25);
    });
  });

  // =========================================================================
  // 4. TOOL CONTRACTS, PROVENANCE & PROCESS SANDBOX HARDENING
  // =========================================================================
  describe('4. Tool Contracts, Provenance & Sandbox Hardening', () => {
    const mockContext: ToolExecutionContext = {
      workerId: 'worker-stress',
      milestoneId: 'M-STRESS',
      role: 'worker',
      workspaceRoot,
      correlationId: 'corr-stress-01',
      authorizationToken: 'auth-stress-token',
    };

    it('rejects malicious or schema-violating tool arguments strictly', () => {
      const safeContract = defineToolContract({
        name: 'write_file',
        description: 'Safe file write',
        category: 'filesystem',
        inputSchema: z
          .object({
            filePath: z.string().min(1).refine((p) => !p.includes('..'), {
              message: 'Path traversal forbidden',
            }),
            content: z.string(),
            mode: z.enum(['append', 'overwrite']).optional(),
          })
          .strict(),
        outputSchema: z.object({ bytes: z.number() }),
        execute: async (input) => ({ bytes: input.content.length }),
      });

      // 1. Extra forbidden properties in strict schema
      const extraKeysResult = validateToolInput(safeContract, {
        filePath: 'src/file.ts',
        content: 'data',
        injectedPayload: 'rm -rf /',
      });
      expect(extraKeysResult.success).toBe(false);

      // 2. Path traversal attack
      const pathTraversalResult = validateToolInput(safeContract, {
        filePath: '../../etc/passwd',
        content: 'bad',
      });
      expect(pathTraversalResult.success).toBe(false);
      if (!pathTraversalResult.success) {
        expect(pathTraversalResult.formattedError).toMatch(/path traversal/i);
      }

      // 3. Type confusion / injection
      const typeConfusionResult = validateToolInput(safeContract, {
        filePath: 12345,
        content: ['not-a-string'],
      });
      expect(typeConfusionResult.success).toBe(false);
    });

    it('detects tampering in provenance SHA-256 hash chains immediately', () => {
      const tracker = new ProvenanceTracker();

      for (let i = 0; i < 10; i++) {
        tracker.createRecord({
          context: mockContext,
          filePath: `src/module-${i}.ts`,
          action: i === 0 ? 'create' : 'modify',
          contentBefore: i === 0 ? undefined : `prev-content-${i}`,
          contentAfter: `new-content-${i}`,
        });
      }

      // Initial chain is pristine
      expect(tracker.verifyChainIntegrity().valid).toBe(true);

      // Tamper with record #4 contentHashBefore
      const history = (tracker as any).records;
      const originalBefore = history[4].contentHashBefore;
      history[4].contentHashBefore = calculateSha256('tampered-malicious-content');

      const tamperedCheck = tracker.verifyChainIntegrity();
      expect(tamperedCheck.valid).toBe(false);
      expect(tamperedCheck.brokenAt).toBe(4);
      expect(tamperedCheck.reason).toMatch(/tampered record detected/i);

      // Restore and tamper with prevRecordHash at index 7
      history[4].contentHashBefore = originalBefore;
      history[7].prevRecordHash = 'tampered-hash-link';

      const brokenLinkCheck = tracker.verifyChainIntegrity();
      expect(brokenLinkCheck.valid).toBe(false);
      expect(brokenLinkCheck.brokenAt).toBe(7);
      expect(brokenLinkCheck.reason).toMatch(/broken chain link/i);
    });

    it('scrubs high-entropy and secret environment variables while preserving allowlist', () => {
      const rawEnv = {
        PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
        NODE_ENV: 'test',
        HOME: 'C:\\Users\\dev',
        OPENAI_API_KEY: 'sk-proj-supersecretkey123456789',
        AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        DATABASE_URL: 'postgres://admin:password123@localhost:5432/production_db',
        GITHUB_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
        SLACK_BOT_TOKEN: 'xoxb-12345-67890-abcdef',
        INTERNAL_SECRET_PASS: 'top_secret',
      };

      const scrubbed = EnvScrubber.scrub(rawEnv, {
        allowlistKeys: ['PATH', 'NODE_ENV', 'HOME'],
      });

      // Allowlisted keys remain intact
      expect(scrubbed.PATH).toBe(rawEnv.PATH);
      expect(scrubbed.NODE_ENV).toBe('test');
      expect(scrubbed.HOME).toBe(rawEnv.HOME);

      // Sensitive keys must be completely removed
      expect(scrubbed.OPENAI_API_KEY).toBeUndefined();
      expect(scrubbed.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(scrubbed.DATABASE_URL).toBeUndefined();
      expect(scrubbed.GITHUB_TOKEN).toBeUndefined();
      expect(scrubbed.SLACK_BOT_TOKEN).toBeUndefined();
      expect(scrubbed.INTERNAL_SECRET_PASS).toBeUndefined();
    });

    it('blocks CWD path traversal outside workspace lockdown root', () => {
      // 1. Direct parent traversal
      expect(() => CwdGuard.assertWithinLockdown(workspaceRoot, '../../windows/system32')).toThrow(
        CwdLockdownViolationError
      );

      // 2. Absolute path on another directory
      const roguePath = path.resolve(workspaceRoot, '..', '..', 'unauthorized-target');
      expect(() => CwdGuard.assertWithinLockdown(workspaceRoot, roguePath)).toThrow(
        CwdLockdownViolationError
      );

      // 3. Valid subdirectory passes
      const validSub = path.join(workspaceRoot, 'lib');
      expect(CwdGuard.assertWithinLockdown(workspaceRoot, validSub)).toBe(path.resolve(validSub));
    });

    it('enforces process sandbox timeout and kills hanging subprocess trees cleanly', async () => {
      // Command that would hang indefinitely without supervisor
      const hangingCmd = 'node -e "setInterval(() => {}, 1000)"';

      const result = await SandboxedProcessManager.executeSandboxed(workspaceRoot, {
        command: hangingCmd,
        timeoutMs: 350,
        isolatedTemp: true,
        workerId: 'stress-worker',
      });

      expect(result.timedOut).toBe(true);
      expect(result.code).toBe(124);
      expect(result.stderr).toMatch(/timed out after 350ms/i);
    });
  });

  // =========================================================================
  // 5. BITEMPORAL LEDGER & REPLAY ADVERSARIAL STRESS
  // =========================================================================
  describe('5. Bitemporal Ledger & Point-in-Time Replay', () => {
    it('verifies SHA-256 Merkle hash chain integrity and catches payload/sequence tampering', async () => {
      const ledger = new AppendOnlyLedger(tempTestDir);
      await ledger.initialize();

      for (let i = 1; i <= 15; i++) {
        await ledger.appendRecord({
          entityId: `entity-${i % 3}`,
          eventType: 'milestone_init',
          action: 'INSERT',
          milestoneId: `M${i}`,
          workerId: `worker-${i}`,
          validFrom: 1000 + i * 10,
          payload: { index: i, note: `record payload ${i}` },
        });
      }

      // Initial ledger is valid
      const initialVerif = ledger.verifyIntegrity();
      expect(initialVerif.valid).toBe(true);
      expect(initialVerif.chainLength).toBe(15);
      expect(initialVerif.errors.length).toBe(0);

      const records = (ledger as any).records;

      // Tamper 1: Modify record payload in memory
      records[4].payload.note = 'TAMPERED IN-MEMORY PAYLOAD';
      const tamperedPayloadVerif = ledger.verifyIntegrity();
      expect(tamperedPayloadVerif.valid).toBe(false);
      expect(tamperedPayloadVerif.errors.some((e: string) => e.includes('Record hash mismatch'))).toBe(true);

      // Restore payload and tamper sequence
      records[4].payload.note = 'record payload 5';
      records[8].sequence = 999;
      const tamperedSeqVerif = ledger.verifyIntegrity();
      expect(tamperedSeqVerif.valid).toBe(false);
      expect(tamperedSeqVerif.errors.some((e: string) => e.includes('Sequence mismatch'))).toBe(true);

      // Restore sequence and tamper prevHash
      records[8].sequence = 9;
      records[10].prevHash = 'tampered-prev-hash-bad';
      const tamperedPrevVerif = ledger.verifyIntegrity();
      expect(tamperedPrevVerif.valid).toBe(false);
      expect(tamperedPrevVerif.errors.some((e: string) => e.includes('Broken hash chain'))).toBe(true);
    });

    it('preserves hash chain and strict sequence monotonicity under high concurrent appends', async () => {
      const ledger = new AppendOnlyLedger(tempTestDir);
      await ledger.initialize();

      const CONCURRENT_APPENDS = 30;

      // Dispatch 30 concurrent appends simultaneously
      await Promise.all(
        Array.from({ length: CONCURRENT_APPENDS }, (_, idx) =>
          ledger.appendRecord({
            entityId: `shared-entity`,
            eventType: 'task_exec',
            action: 'UPDATE',
            milestoneId: 'M-CONCURRENT',
            workerId: `worker-${idx}`,
            payload: { workerIdx: idx },
          })
        )
      );

      expect(ledger.count()).toBe(CONCURRENT_APPENDS);

      const allRecords = ledger.getAllRecords();
      for (let i = 0; i < allRecords.length; i++) {
        expect(allRecords[i].sequence).toBe(i + 1);
      }

      const verif = ledger.verifyIntegrity();
      expect(verif.valid).toBe(true);
      expect(verif.chainLength).toBe(CONCURRENT_APPENDS);
    });

    it('correctly reconstructs entity states at edge coordinates across bitemporal timeline', () => {
      // Bitemporal records covering distinct Valid Time (Tv) and Transaction Time (Tt) epochs:
      // r1: Recorded at Tt=100, Valid from Tv=100 to 500: initial config { port: 3000, workers: 2 }
      // r2: Recorded at Tt=200, Valid from Tv=500 to infinity: scaling update { port: 3000, workers: 4 }
      // r3: Recorded at Tt=300 (superseding r1 retroactively for Tv=100..500): fix config { port: 3001, workers: 2 }
      const records = [
        {
          id: 'rec-1',
          sequence: 1,
          entityId: 'service_config',
          validFrom: 100,
          validTo: 500,
          txFrom: 100,
          txTo: 300, // Superseded by rec-3 at Tt=300
          eventType: 'milestone_init' as const,
          action: 'INSERT' as const,
          milestoneId: 'M1',
          workerId: 'worker-1',
          payload: { port: 3000, workers: 2 },
          prevHash: GENESIS_PREV_HASH,
          recordHash: 'hash-rec-1',
          merkleHash: 'hash-rec-1',
        },
        {
          id: 'rec-2',
          sequence: 2,
          entityId: 'service_config',
          validFrom: 500,
          validTo: null,
          txFrom: 200,
          txTo: null,
          eventType: 'task_exec' as const,
          action: 'UPDATE' as const,
          milestoneId: 'M2',
          workerId: 'worker-2',
          payload: { port: 3000, workers: 4 },
          prevHash: 'hash-rec-1',
          recordHash: 'hash-rec-2',
          merkleHash: 'hash-rec-2',
        },
        {
          id: 'rec-3',
          sequence: 3,
          entityId: 'service_config',
          parentRecordId: 'rec-1',
          validFrom: 100,
          validTo: 500,
          txFrom: 300,
          txTo: null,
          eventType: 'fix' as const,
          action: 'UPDATE' as const,
          milestoneId: 'M3',
          workerId: 'worker-3',
          payload: { port: 3001, workers: 2 },
          prevHash: 'hash-rec-2',
          recordHash: 'hash-rec-3',
          merkleHash: 'hash-rec-3',
        },
      ];

      const replayEngine = new PointInTimeReplayEngine(records);

      // 1. Before any record existed in valid time (Tv=50, Tt=150)
      const stateBefore = replayEngine.replayEntityValue<any>('service_config', {
        validTime: 50,
        txTime: 150,
      });
      expect(stateBefore).toBeNull();

      // 2. Original perspective: at Tv=200, before r3 was recorded (Tt=150)
      // Must reflect r1 { port: 3000, workers: 2 }
      const stateOriginal = replayEngine.replayEntityValue<any>('service_config', {
        validTime: 200,
        txTime: 150,
      });
      expect(stateOriginal).toEqual({ port: 3000, workers: 2 });

      // 3. Retrospective correction perspective: at Tv=200, after r3 was recorded (Tt=350)
      // Must reflect r3 { port: 3001, workers: 2 }
      const stateRetro = replayEngine.replayEntityValue<any>('service_config', {
        validTime: 200,
        txTime: 350,
      });
      expect(stateRetro).toEqual({ port: 3001, workers: 2 });

      // 4. Future epoch: at Tv=600, Tt=350
      // Must reflect r2 { port: 3000, workers: 4 }
      const stateFuture = replayEngine.replayEntityValue<any>('service_config', {
        validTime: 600,
        txTime: 350,
      });
      expect(stateFuture).toEqual({ port: 3000, workers: 4 });
    });

    it('executes non-destructive compensating rollback and preserves Merkle chain', async () => {
      const ledger = new AppendOnlyLedger(tempTestDir);
      await ledger.initialize();

      const rec1 = await ledger.appendRecord({
        entityId: 'config-setting',
        eventType: 'milestone_init',
        action: 'INSERT',
        milestoneId: 'M1',
        workerId: 'worker-1',
        payload: { maxConns: 50 },
      });

      const rec2 = await ledger.appendRecord({
        entityId: 'config-setting',
        eventType: 'task_exec',
        action: 'UPDATE',
        milestoneId: 'M2',
        workerId: 'worker-2',
        parentRecordId: rec1.id,
        payload: { maxConns: 500 }, // Dangerous misconfiguration
      });

      // Rollback via compensating record
      const compRec = await ledger.compensate({
        targetRecordId: rec2.id,
        workerId: 'critic-lead',
        reason: 'Rollback dangerous maxConns configuration to safe default',
        inversePayload: { restoredState: { maxConns: 50 } },
      });

      expect(ledger.count()).toBe(3);
      expect(compRec.action).toBe('COMPENSATE');

      const integrity = ledger.verifyIntegrity();
      expect(integrity.valid).toBe(true);
      expect(integrity.chainLength).toBe(3);

      const replayer = new PointInTimeReplayEngine(ledger);
      const currentState = replayer.replayEntityState<any>('config-setting');
      expect(currentState?.state.maxConns).toBe(50);
      expect(currentState?.active).toBe(true);
    });
  });

  // =========================================================================
  // 6. DUAL-GATE CONTROLLER & ADVANCED INTEGRATION STRESS
  // =========================================================================
  describe('6. Dual-Gate Controller & Advanced Sandbox Stress', () => {
    const mockContext: ToolExecutionContext = {
      workerId: 'worker-dual-gate',
      milestoneId: 'M-GATE',
      role: 'worker',
      workspaceRoot,
      correlationId: 'corr-dual-01',
      authorizationToken: 'auth-dual-token',
    };

    it('enforces Gate 1 pre-flight rejection for destructive commands and path escapes', async () => {
      const dualGate = new DualGateController();

      const shellContract = defineToolContract({
        name: 'exec_shell',
        description: 'Execute shell command',
        category: 'shell',
        riskLevel: 'destructive',
        inputSchema: z.object({ command: z.string(), targetResource: z.string().optional() }),
        outputSchema: z.object({ exitCode: z.number() }),
        execute: async () => ({ exitCode: 0 }),
      });

      // 1. Destructive command blocked
      const destructiveCheck = await dualGate.evaluatePreFlight({
        contract: shellContract,
        rawInput: { command: 'rm -rf /' },
        context: mockContext,
      });
      expect(destructiveCheck.passed).toBe(false);
      expect(destructiveCheck.blockedRule).toBe('destructive_command_blocked');

      // 2. Path lockdown violation blocked
      const escapeCheck = await dualGate.evaluatePreFlight({
        contract: shellContract,
        rawInput: { command: 'cat secret.txt', targetResource: '../../outside.txt' },
        context: mockContext,
      });
      expect(escapeCheck.passed).toBe(false);
      expect(escapeCheck.blockedRule).toBe('path_lockdown_violation');
    });

    it('enforces Gate 2 post-flight rejection when output contains empty facade stubs', async () => {
      const dualGate = new DualGateController();

      const writeContract = defineToolContract({
        name: 'patch_file',
        description: 'Patch implementation file',
        category: 'fs_write',
        riskLevel: 'write',
        inputSchema: z.object({ filePath: z.string(), patch: z.string() }),
        outputSchema: z.object({ bytes: z.number() }),
        execute: async () => ({ bytes: 100 }),
      });

      const facadeDiff = 'function solveComplexProblem() { return null; }';

      const postFlight = await dualGate.evaluatePostFlight({
        contract: writeContract,
        output: { bytes: 100 },
        context: mockContext,
        diffText: facadeDiff,
      });

      expect(postFlight.passed).toBe(false);
      expect(postFlight.issues.some((i) => i.description.includes('dummy facade'))).toBe(true);
    });

    it('spawns and tears down 5 rapid concurrent sandboxed processes without leaking temp dirs', async () => {
      const CONCURRENT_SPAWNS = 5;

      const results = await Promise.all(
        Array.from({ length: CONCURRENT_SPAWNS }, (_, idx) =>
          SandboxedProcessManager.executeSandboxed(workspaceRoot, {
            command: 'node -e "console.log(\'sandbox-\' + process.pid)"',
            timeoutMs: 5000,
            isolatedTemp: true,
            workerId: `burst-worker-${idx}`,
          })
        )
      );

      for (const res of results) {
        expect(res.code).toBe(0);
        expect(res.timedOut).toBe(false);
        expect(res.stdout).toMatch(/sandbox-\d+/);
        // Scoped temp dir must have been cleaned up
        if (res.tempDirectory) {
          expect(fs.existsSync(res.tempDirectory)).toBe(false);
        }
      }
    });

    it('detects cycles in disconnected DAG components alongside valid subgraphs', () => {
      const nodes: DagNode[] = [
        // Component 1: Valid linear pipeline
        { id: 'V1', dependsOn: [], execute: async () => 'V1' },
        { id: 'V2', dependsOn: ['V1'], execute: async () => 'V2' },
        { id: 'V3', dependsOn: ['V2'], execute: async () => 'V3' },

        // Component 2: Disconnected cyclic component
        { id: 'C1', dependsOn: ['C3'], execute: async () => 'C1' },
        { id: 'C2', dependsOn: ['C1'], execute: async () => 'C2' },
        { id: 'C3', dependsOn: ['C2'], execute: async () => 'C3' },
      ];

      expect(() => computeTopologicalPlan(nodes)).toThrow(CycleDetectedError);
    });

    it('validates deterministic DAG definition hash invariance and edge sensitivity', () => {
      const baseNodes = [
        { id: 'TaskA', dependsOn: [] },
        { id: 'TaskB', dependsOn: ['TaskA'] },
        { id: 'TaskC', dependsOn: ['TaskA', 'TaskB'] },
      ];

      const reorderedNodes = [
        { id: 'TaskC', dependsOn: ['TaskB', 'TaskA'] },
        { id: 'TaskA', dependsOn: [] },
        { id: 'TaskB', dependsOn: ['TaskA'] },
      ];

      const modifiedDepNodes = [
        { id: 'TaskA', dependsOn: [] },
        { id: 'TaskB', dependsOn: ['TaskA'] },
        { id: 'TaskC', dependsOn: ['TaskB'] }, // Removed dependency on TaskA
      ];

      const hash1 = computeDagDefinitionHash(baseNodes);
      const hash2 = computeDagDefinitionHash(reorderedNodes);
      const hash3 = computeDagDefinitionHash(modifiedDepNodes);

      // Invariant under node array ordering and dependency list ordering
      expect(hash1).toBe(hash2);

      // Sensitive to edge topology alterations
      expect(hash1).not.toBe(hash3);
    });
  });
});
