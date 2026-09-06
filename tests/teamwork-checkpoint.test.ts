import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CheckpointSerializationError,
  computeDagDefinitionHash,
  deserializeCheckpoint,
  FileCheckpointStore,
  generateIdempotencyToken,
  MemoryCheckpointStore,
  parseIdempotencyToken,
  serializeCheckpoint,
  WorkflowCheckpoint,
} from '@/lib/teamwork/checkpoint';
import { DagExecutionEngine, DagNode } from '@/lib/teamwork/dag';

describe('Checkpoint Serializer & Utilities', () => {
  const sampleCheckpoint: WorkflowCheckpoint = {
    version: '1.0.0',
    runId: 'run_test_123',
    dagId: 'dag_pipeline_abc',
    dagDefinitionHash: 'hash_xyz',
    status: 'running',
    createdAt: 1700000000000,
    updatedAt: 1700000005000,
    completedNodeIds: ['node_1'],
    failedNodeIds: [],
    blockedNodeIds: [],
    nodes: {
      node_1: {
        nodeId: 'node_1',
        title: 'Init',
        status: 'completed',
        attempt: 1,
        startedAt: 1700000001000,
        completedAt: 1700000004000,
        durationMs: 3000,
        ownedFiles: ['src/index.ts'],
        output: { success: true, count: 42 },
        idempotencyToken: 'run_test_123:node_1:1',
      },
    },
    context: { env: 'test' },
  };

  it('serializes and deserializes a workflow checkpoint losslessly', () => {
    const serialized = serializeCheckpoint(sampleCheckpoint);
    expect(typeof serialized).toBe('string');

    const deserialized = deserializeCheckpoint(serialized);
    expect(deserialized.runId).toBe(sampleCheckpoint.runId);
    expect(deserialized.dagId).toBe(sampleCheckpoint.dagId);
    expect(deserialized.status).toBe('running');
    expect(deserialized.completedNodeIds).toEqual(['node_1']);
    expect(deserialized.nodes.node_1.output).toEqual({ success: true, count: 42 });
  });

  it('safely serializes objects containing circular references without throwing', () => {
    const circularObj: Record<string, unknown> = { name: 'circularRoot' };
    circularObj.self = circularObj;

    const checkpointWithCircular: WorkflowCheckpoint = {
      ...sampleCheckpoint,
      context: { loop: circularObj },
    };

    expect(() => serializeCheckpoint(checkpointWithCircular)).not.toThrow();
    const serialized = serializeCheckpoint(checkpointWithCircular);
    expect(serialized).toContain('[Circular]');
  });

  it('safely serializes BigInt, Map, Set, and Error objects', () => {
    const error = new Error('Database connection failed');
    const checkpointWithComplex: WorkflowCheckpoint = {
      ...sampleCheckpoint,
      context: {
        bigNumber: BigInt(9007199254740991),
        tags: new Set(['fast', 'secure']),
        mapData: new Map([['k1', 'v1']]),
        failure: error,
      },
    };

    const serialized = serializeCheckpoint(checkpointWithComplex);
    const parsed = deserializeCheckpoint(serialized);
    expect(parsed.context?.bigNumber).toBe('9007199254740991');
    expect(parsed.context?.tags).toEqual(['fast', 'secure']);
    expect(parsed.context?.mapData).toEqual({ k1: 'v1' });
    expect((parsed.context?.failure as Record<string, unknown>).message).toBe(
      'Database connection failed'
    );
  });

  it('throws CheckpointSerializationError on malformed JSON payload', () => {
    expect(() => deserializeCheckpoint('invalid { json')).toThrow(
      CheckpointSerializationError
    );
    expect(() => deserializeCheckpoint('{"runId": 123}')).toThrow(
      CheckpointSerializationError
    );
  });

  it('computes deterministic SHA-256 hash for DAG topology', () => {
    const nodesA = [
      { id: 'step_1', dependsOn: [] },
      { id: 'step_2', dependsOn: ['step_1'] },
      { id: 'step_3', dependsOn: ['step_1', 'step_2'] },
    ];

    // Swapped order of nodes and dependencies
    const nodesB = [
      { id: 'step_3', dependsOn: ['step_2', 'step_1'] },
      { id: 'step_1', dependsOn: [] },
      { id: 'step_2', dependsOn: ['step_1'] },
    ];

    const hashA = computeDagDefinitionHash(nodesA);
    const hashB = computeDagDefinitionHash(nodesB);
    expect(hashA).toBe(hashB);

    // Altered dependency produces different hash
    const nodesC = [
      { id: 'step_1', dependsOn: [] },
      { id: 'step_2', dependsOn: [] }, // Changed from ['step_1']
      { id: 'step_3', dependsOn: ['step_1', 'step_2'] },
    ];
    const hashC = computeDagDefinitionHash(nodesC);
    expect(hashA).not.toBe(hashC);
  });

  it('generates and parses idempotency tokens', () => {
    const token = generateIdempotencyToken('run_999', 'node_fetch', 2);
    expect(token).toBe('run_999:node_fetch:2');

    const parsed = parseIdempotencyToken(token);
    expect(parsed).toEqual({
      runId: 'run_999',
      nodeId: 'node_fetch',
      attempt: 2,
    });

    expect(parseIdempotencyToken('invalid-token')).toBeNull();
  });
});

describe('MemoryCheckpointStore', () => {
  it('persists and retrieves checkpoints without external reference mutation', async () => {
    const store = new MemoryCheckpointStore();
    const cp: WorkflowCheckpoint = {
      version: '1.0.0',
      runId: 'mem_1',
      dagId: 'dag_mem',
      status: 'completed',
      createdAt: 1000,
      updatedAt: 2000,
      completedNodeIds: ['m1'],
      failedNodeIds: [],
      blockedNodeIds: [],
      nodes: {
        m1: {
          nodeId: 'm1',
          status: 'completed',
          attempt: 1,
          idempotencyToken: 'mem_1:m1:1',
          output: { count: 10 },
        },
      },
    };

    await store.save(cp);
    expect(store.size).toBe(1);

    // Modify source object
    (cp.nodes.m1.output as { count: number }).count = 999;

    const loaded = await store.load('mem_1');
    expect(loaded).not.toBeNull();
    // Stored copy remains unaffected
    expect((loaded!.nodes.m1.output as { count: number }).count).toBe(10);
  });

  it('lists summaries and finds latest checkpoint', async () => {
    const store = new MemoryCheckpointStore();

    await store.save({
      version: '1.0.0',
      runId: 'run_old',
      dagId: 'dag_A',
      status: 'completed',
      createdAt: 100,
      updatedAt: 100,
      completedNodeIds: ['n1'],
      failedNodeIds: [],
      blockedNodeIds: [],
      nodes: { n1: { nodeId: 'n1', status: 'completed', attempt: 1, idempotencyToken: 'old' } },
    });

    await store.save({
      version: '1.0.0',
      runId: 'run_new',
      dagId: 'dag_A',
      status: 'running',
      createdAt: 200,
      updatedAt: 300,
      completedNodeIds: ['n1', 'n2'],
      failedNodeIds: [],
      blockedNodeIds: [],
      nodes: {
        n1: { nodeId: 'n1', status: 'completed', attempt: 1, idempotencyToken: 'new1' },
        n2: { nodeId: 'n2', status: 'running', attempt: 1, idempotencyToken: 'new2' },
      },
    });

    const list = await store.list('dag_A');
    expect(list.length).toBe(2);
    expect(list[0].runId).toBe('run_new'); // Most recent first
    expect(list[0].completedNodesCount).toBe(2);

    const latest = await store.latest('dag_A');
    expect(latest?.runId).toBe('run_new');

    const deleted = await store.delete('run_old');
    expect(deleted).toBe(true);
    expect(await store.load('run_old')).toBeNull();
  });
});

describe('FileCheckpointStore (Atomic File Writes)', () => {
  let tempDir: string;
  let fileStore: FileCheckpointStore;

  beforeAll(async () => {
    tempDir = path.join(os.tmpdir(), `vyen_checkpoint_test_${Date.now()}`);
    fileStore = new FileCheckpointStore({ baseDir: tempDir });
  });

  afterAll(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  it('atomically saves a checkpoint to disk', async () => {
    const checkpoint: WorkflowCheckpoint = {
      version: '1.0.0',
      runId: 'file_run_1',
      dagId: 'dag_disk',
      status: 'paused',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedNodeIds: ['disk_step1'],
      failedNodeIds: [],
      blockedNodeIds: [],
      nodes: {
        disk_step1: {
          nodeId: 'disk_step1',
          status: 'completed',
          attempt: 1,
          idempotencyToken: 'file_run_1:disk_step1:1',
          output: 'disk_output_verified',
        },
      },
    };

    await fileStore.save(checkpoint);

    // Target file must exist
    const files = await fs.readdir(tempDir);
    expect(files).toContain('file_run_1.json');

    // No leftover .tmp files
    const tmpFiles = files.filter((f) => f.includes('.tmp'));
    expect(tmpFiles.length).toBe(0);

    // Load and verify content
    const loaded = await fileStore.load('file_run_1');
    expect(loaded).not.toBeNull();
    expect(loaded?.status).toBe('paused');
    expect(loaded?.nodes.disk_step1.output).toBe('disk_output_verified');
  });

  it('returns null on loading non-existent checkpoint', async () => {
    const loaded = await fileStore.load('does_not_exist');
    expect(loaded).toBeNull();
  });

  it('lists checkpoints from disk and deletes cleanly', async () => {
    const list = await fileStore.list('dag_disk');
    expect(list.length).toBe(1);
    expect(list[0].runId).toBe('file_run_1');

    const deleted = await fileStore.delete('file_run_1');
    expect(deleted).toBe(true);
    expect(await fileStore.load('file_run_1')).toBeNull();

    const deleteAgain = await fileStore.delete('file_run_1');
    expect(deleteAgain).toBe(false);
  });
});

describe('Pause & Resume Lifecycle Integration', () => {
  it('pauses workflow, persists checkpoint, and resumes without re-executing completed nodes', async () => {
    const store = new MemoryCheckpointStore();
    const executionCounts: Record<string, number> = {
      step1: 0,
      step2: 0,
      step3: 0,
    };

    const dag = {
      id: 'resumable_pipeline',
      name: 'Resumable Pipeline',
      nodes: [
        {
          id: 'step1',
          dependsOn: [],
          executor: async () => {
            executionCounts.step1++;
            return 'output_step_1';
          },
        },
        {
          id: 'step2',
          dependsOn: ['step1'],
          executor: async ({ parentOutputs }: { parentOutputs: Map<string, any> }) => {
            executionCounts.step2++;
            return `step2_got_${parentOutputs.get('step1')}`;
          },
        },
        {
          id: 'step3',
          dependsOn: ['step2'],
          executor: async ({ parentOutputs }: { parentOutputs: Map<string, any> }) => {
            executionCounts.step3++;
            return `step3_got_${parentOutputs.get('step2')}`;
          },
        },
      ],
    };

    const engine1 = new DagExecutionEngine({
      checkpointStore: store,
      autoCheckpoint: true,
    });

    // Pause engine before step2 completes
    engine1.on('dag_node_completed', async (e) => {
      if (e.nodeId === 'step1') {
        await engine1.pause('Pause after step 1 for inspection');
      }
    });

    const pauseResult = await engine1.execute(dag, { runId: 'run_pause_test' });
    expect(pauseResult.status).toBe('PAUSED');
    expect(executionCounts.step1).toBe(1);
    expect(executionCounts.step2).toBe(0);
    expect(executionCounts.step3).toBe(0);

    // Verify checkpoint state
    const savedCheckpoint = await store.load('run_pause_test');
    expect(savedCheckpoint).not.toBeNull();
    expect(savedCheckpoint?.status).toBe('paused');
    expect(savedCheckpoint?.completedNodeIds).toContain('step1');

    // Resume workflow from checkpoint using a fresh engine instance
    const engine2 = new DagExecutionEngine({
      checkpointStore: store,
      autoCheckpoint: true,
    });

    const resumeResult = await engine2.resume(savedCheckpoint!, dag);
    expect(resumeResult.status).toBe('COMPLETED');

    // Step 1 was NOT re-executed! Count remains 1.
    expect(executionCounts.step1).toBe(1);
    // Step 2 and Step 3 executed to completion
    expect(executionCounts.step2).toBe(1);
    expect(executionCounts.step3).toBe(1);

    expect(resumeResult.nodeResults.get('step3')?.output).toBe(
      'step3_got_step2_got_output_step_1'
    );
  });

  it('handles auto-creation of deeply nested checkpoint directories', async () => {
    const nestedDir = path.join(os.tmpdir(), `nested_test_${Date.now()}`, 'sub1', 'sub2');
    const store = new FileCheckpointStore(nestedDir);

    const cp: WorkflowCheckpoint = {
      version: '1.0.0',
      runId: 'nested_run',
      dagId: 'dag_nested',
      status: 'completed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedNodeIds: [],
      failedNodeIds: [],
      blockedNodeIds: [],
      nodes: {},
    };

    await store.save(cp);
    const loaded = await store.load('nested_run');
    expect(loaded).not.toBeNull();
    expect(loaded?.runId).toBe('nested_run');

    await fs.rm(path.join(os.tmpdir(), `nested_test_${Date.now()}`), {
      recursive: true,
      force: true,
    });
  });
});

