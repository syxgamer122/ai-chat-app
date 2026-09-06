import { beforeEach, describe, expect, it, vi } from 'vitest';
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
} from '@/lib/teamwork/dag';

describe('Durable DAG Engine - Topological Sort & Cycle Detection', () => {
  it('computes topological plan for a single node without dependencies', () => {
    const nodes: DagNode[] = [
      { id: 'A', name: 'Task A', dependsOn: [], executor: async () => 'resultA' },
    ];

    const plan = computeTopologicalPlan(nodes);
    expect(plan.sortedNodeIds).toEqual(['A']);
    expect(plan.levels).toEqual([['A']]);
    expect(plan.initialReadyNodes).toEqual(['A']);
    expect(plan.leafNodes).toEqual(['A']);
  });

  it('computes linear chain dependencies strictly in order', () => {
    const nodes: DagNode[] = [
      { id: 'C', dependsOn: ['B'], executor: async () => 'C' },
      { id: 'A', dependsOn: [], executor: async () => 'A' },
      { id: 'B', dependsOn: ['A'], executor: async () => 'B' },
    ];

    const plan = computeTopologicalPlan(nodes);
    expect(plan.sortedNodeIds).toEqual(['A', 'B', 'C']);
    expect(plan.levels).toEqual([['A'], ['B'], ['C']]);
    expect(plan.initialReadyNodes).toEqual(['A']);
    expect(plan.leafNodes).toEqual(['C']);
  });

  it('identifies parallel execution waves in a diamond graph', () => {
    // A -> B, A -> C, [B, C] -> D
    const nodes: DagNode[] = [
      { id: 'A', dependsOn: [], executor: async () => 'A' },
      { id: 'B', dependsOn: ['A'], executor: async () => 'B' },
      { id: 'C', dependsOn: ['A'], executor: async () => 'C' },
      { id: 'D', dependsOn: ['B', 'C'], executor: async () => 'D' },
    ];

    const plan = computeTopologicalPlan(nodes);
    expect(plan.levels.length).toBe(3);
    expect(plan.levels[0]).toEqual(['A']);
    expect(plan.levels[1].sort()).toEqual(['B', 'C']);
    expect(plan.levels[2]).toEqual(['D']);
    expect(plan.leafNodes).toEqual(['D']);
  });

  it('handles disjoint parallel subgraphs correctly', () => {
    // Graph 1: A -> B; Graph 2: C -> D
    const nodes: DagNode[] = [
      { id: 'A', dependsOn: [], executor: async () => 'A' },
      { id: 'B', dependsOn: ['A'], executor: async () => 'B' },
      { id: 'C', dependsOn: [], executor: async () => 'C' },
      { id: 'D', dependsOn: ['C'], executor: async () => 'D' },
    ];

    const plan = computeTopologicalPlan(nodes);
    expect(plan.levels[0].sort()).toEqual(['A', 'C']);
    expect(plan.levels[1].sort()).toEqual(['B', 'D']);
    expect(plan.initialReadyNodes.sort()).toEqual(['A', 'C']);
    expect(plan.leafNodes.sort()).toEqual(['B', 'D']);
  });

  it('throws MissingDependencyError when a node references an unknown parent', () => {
    const nodes: DagNode[] = [
      { id: 'A', dependsOn: ['non_existent_node'], executor: async () => 'A' },
    ];

    expect(() => computeTopologicalPlan(nodes)).toThrow(MissingDependencyError);
    try {
      computeTopologicalPlan(nodes);
    } catch (err) {
      expect(err).toBeInstanceOf(MissingDependencyError);
      expect((err as MissingDependencyError).missingDep).toBe('non_existent_node');
      expect((err as MissingDependencyError).nodeId).toBe('A');
    }
  });

  it('throws DagEngineError on duplicate node IDs', () => {
    const nodes: DagNode[] = [
      { id: 'dup', dependsOn: [], executor: async () => '1' },
      { id: 'dup', dependsOn: [], executor: async () => '2' },
    ];

    expect(() => computeTopologicalPlan(nodes)).toThrow(DagEngineError);
  });

  it('detects a direct self-referential cycle', () => {
    const nodes: DagNode[] = [
      { id: 'self', dependsOn: ['self'], executor: async () => 'loop' },
    ];

    expect(() => computeTopologicalPlan(nodes)).toThrow(CycleDetectedError);
    try {
      computeTopologicalPlan(nodes);
    } catch (err) {
      expect(err).toBeInstanceOf(CycleDetectedError);
      expect((err as CycleDetectedError).cyclePath).toEqual(['self', 'self']);
    }
  });

  it('detects a 2-node circular dependency loop', () => {
    const nodes: DagNode[] = [
      { id: 'A', dependsOn: ['B'], executor: async () => 'A' },
      { id: 'B', dependsOn: ['A'], executor: async () => 'B' },
    ];

    expect(() => computeTopologicalPlan(nodes)).toThrow(CycleDetectedError);
    try {
      computeTopologicalPlan(nodes);
    } catch (err) {
      expect(err).toBeInstanceOf(CycleDetectedError);
      const path = (err as CycleDetectedError).cyclePath;
      expect(path.length).toBeGreaterThanOrEqual(3);
      expect(path[0]).toBe(path[path.length - 1]);
    }
  });

  it('detects a multi-node circular dependency in a complex graph', () => {
    const nodes: DagNode[] = [
      { id: 'entry', dependsOn: [], executor: async () => 'entry' },
      { id: 'A', dependsOn: ['entry', 'C'], executor: async () => 'A' },
      { id: 'B', dependsOn: ['A'], executor: async () => 'B' },
      { id: 'C', dependsOn: ['B'], executor: async () => 'C' },
    ];

    expect(() => computeTopologicalPlan(nodes)).toThrow(CycleDetectedError);
  });
});

describe('DagGraph Container', () => {
  it('manipulates nodes and edges correctly', () => {
    const graph = new DagGraph();
    graph.addNode({ id: 'N1', dependsOn: [], executor: async () => 1 });
    graph.addNode({ id: 'N2', dependsOn: [], executor: async () => 2 });

    expect(graph.hasNode('N1')).toBe(true);
    expect(graph.hasNode('N3')).toBe(false);

    graph.addEdge('N1', 'N2');
    expect(graph.hasEdge('N1', 'N2')).toBe(true);
    expect(graph.getParents('N2')).toEqual(['N1']);
    expect(graph.getChildren('N1')).toEqual(['N2']);

    graph.removeEdge('N1', 'N2');
    expect(graph.hasEdge('N1', 'N2')).toBe(false);

    graph.addEdge('N1', 'N2');
    graph.removeNode('N1');
    expect(graph.hasNode('N1')).toBe(false);
    expect(graph.getParents('N2')).toEqual([]);
  });

  it('clones graph with isolated nodes and dependencies', () => {
    const graph = new DagGraph();
    graph.addNode({ id: 'A', dependsOn: [], executor: async () => 'A' });
    graph.addNode({ id: 'B', dependsOn: ['A'], executor: async () => 'B' });

    const clone = graph.clone();
    expect(clone.getNodes().length).toBe(2);

    clone.addNode({ id: 'C', dependsOn: ['B'], executor: async () => 'C' });
    expect(clone.hasNode('C')).toBe(true);
    expect(graph.hasNode('C')).toBe(false);
  });
});

describe('AsyncSemaphore Limiter', () => {
  it('limits active concurrent slots to maxSlots', async () => {
    const semaphore = new AsyncSemaphore(2);
    expect(semaphore.maxSlots).toBe(2);
    expect(semaphore.currentCapacity).toBe(2);
    expect(semaphore.activeCount).toBe(0);

    const slot1 = await semaphore.acquire();
    expect(semaphore.currentCapacity).toBe(1);
    expect(semaphore.activeCount).toBe(1);

    const slot2 = await semaphore.acquire();
    expect(semaphore.currentCapacity).toBe(0);
    expect(semaphore.activeCount).toBe(2);

    let slot3Acquired = false;
    const p3 = semaphore.acquire().then((s) => {
      slot3Acquired = true;
      return s;
    });

    // p3 should be queued because capacity is 0
    expect(slot3Acquired).toBe(false);
    expect(semaphore.waitingCount).toBe(1);

    slot1.release();
    const slot3 = await p3;
    expect(slot3Acquired).toBe(true);
    expect(semaphore.activeCount).toBe(2);

    slot2.release();
    slot3.release();
    expect(semaphore.currentCapacity).toBe(2);
    expect(semaphore.activeCount).toBe(0);
  });

  it('supports runExclusive helper', async () => {
    const semaphore = new AsyncSemaphore(1);
    let executionOrder: number[] = [];

    const task = async (id: number, delayMs: number) => {
      return semaphore.runExclusive(async () => {
        executionOrder.push(id);
        await new Promise((r) => setTimeout(r, delayMs));
        return id;
      });
    };

    await Promise.all([task(1, 20), task(2, 10), task(3, 5)]);
    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it('times out when slot acquisition exceeds deadline', async () => {
    const semaphore = new AsyncSemaphore(1);
    const slot1 = await semaphore.acquire();

    await expect(semaphore.acquire(30)).rejects.toThrow(ExecutionTimeoutError);
    slot1.release();
  });

  it('aborts cleanly when AbortSignal is triggered', async () => {
    const semaphore = new AsyncSemaphore(1);
    const slot1 = await semaphore.acquire();

    const controller = new AbortController();
    const acquirePromise = semaphore.acquire(undefined, controller.signal);

    controller.abort();
    await expect(acquirePromise).rejects.toThrow('aborted');

    slot1.release();
    expect(semaphore.currentCapacity).toBe(1);
    expect(semaphore.waitingCount).toBe(0);
  });
});

describe('Exponential Backoff with Jitter (RetryPolicy)', () => {
  it('computes exponential backoff progression with factor 2', () => {
    const policy = new RetryPolicy({
      baseDelayMs: 100,
      maxDelayMs: 5000,
      factor: 2,
      jitterStrategy: 'none',
    });

    expect(policy.computeDelay(1)).toBe(100);  // 100 * 2^0
    expect(policy.computeDelay(2)).toBe(200);  // 100 * 2^1
    expect(policy.computeDelay(3)).toBe(400);  // 100 * 2^2
    expect(policy.computeDelay(4)).toBe(800);  // 100 * 2^3
  });

  it('clamps backoff delay strictly to maxDelayMs', () => {
    const policy = new RetryPolicy({
      baseDelayMs: 1000,
      maxDelayMs: 3000,
      factor: 2,
      jitterStrategy: 'none',
    });

    expect(policy.computeDelay(1)).toBe(1000);
    expect(policy.computeDelay(2)).toBe(2000);
    expect(policy.computeDelay(3)).toBe(3000);
    expect(policy.computeDelay(4)).toBe(3000);
    expect(policy.computeDelay(50)).toBe(3000); // Does not overflow to Infinity
  });

  it('produces delays in [0, rawBackoff] under full jitter', () => {
    const policy = new RetryPolicy({
      baseDelayMs: 500,
      maxDelayMs: 5000,
      jitterStrategy: 'full',
    });

    for (let i = 0; i < 20; i++) {
      const delay = policy.computeDelay(2); // rawBackoff = 1000
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });

  it('produces delays in [rawBackoff / 2, rawBackoff] under equal jitter', () => {
    const policy = new RetryPolicy({
      baseDelayMs: 400,
      maxDelayMs: 5000,
      jitterStrategy: 'equal',
    });

    for (let i = 0; i < 20; i++) {
      const delay = policy.computeDelay(2); // rawBackoff = 800, half = 400
      expect(delay).toBeGreaterThanOrEqual(400);
      expect(delay).toBeLessThanOrEqual(800);
    }
  });

  it('evaluates shouldRetry correctly based on attempt ceiling and filter', () => {
    const policy = new RetryPolicy({
      maxRetries: 2,
      isRetryable: (err) => (err as Error).message.includes('transient'),
    });

    expect(policy.shouldRetry(1, new Error('transient network glitch'))).toBe(true);
    expect(policy.shouldRetry(2, new Error('transient network glitch'))).toBe(true);
    expect(policy.shouldRetry(3, new Error('transient network glitch'))).toBe(false); // Exceeded maxRetries
    expect(policy.shouldRetry(1, new Error('fatal authorization fail'))).toBe(false);
  });
});

describe('DagExecutionEngine - Workflow Execution', () => {
  it('executes a linear DAG and passes parent outputs to downstream nodes', async () => {
    const engine = new DagExecutionEngine({ concurrencyCap: 2 });

    const dag = {
      id: 'linear_dag',
      name: 'Linear Pipeline',
      nodes: [
        {
          id: 'step1',
          dependsOn: [],
          executor: async () => ({ value: 10 }),
        },
        {
          id: 'step2',
          dependsOn: ['step1'],
          executor: async ({ parentOutputs }: any) => {
            const step1Out = parentOutputs.get('step1') as { value: number };
            return { value: step1Out.value * 2 };
          },
        },
        {
          id: 'step3',
          dependsOn: ['step2'],
          executor: async ({ parentOutputs }: any) => {
            const step2Out = parentOutputs.get('step2') as { value: number };
            return { result: step2Out.value + 5 };
          },
        },
      ],
    };

    const result = await engine.execute(dag as any);
    expect(result.status).toBe('COMPLETED');
    expect(result.nodeResults.get('step1')?.output).toEqual({ value: 10 });
    expect(result.nodeResults.get('step2')?.output).toEqual({ value: 20 });
    expect(result.nodeResults.get('step3')?.output).toEqual({ result: 25 });
  });

  it('runs independent parallel branches concurrently up to concurrencyCap', async () => {
    const engine = new DagExecutionEngine({ concurrencyCap: 2 });
    let maxConcurrent = 0;
    let currentlyRunning = 0;

    const makeNode = (id: string, durationMs: number): DagNode => ({
      id,
      dependsOn: [],
      executor: async () => {
        currentlyRunning++;
        maxConcurrent = Math.max(maxConcurrent, currentlyRunning);
        await new Promise((r) => setTimeout(r, durationMs));
        currentlyRunning--;
        return id;
      },
    });

    const dag = {
      id: 'parallel_dag',
      name: 'Parallel Branches',
      nodes: [
        makeNode('P1', 30),
        makeNode('P2', 30),
        makeNode('P3', 30),
        makeNode('P4', 30),
      ],
    };

    const result = await engine.execute(dag);
    expect(result.status).toBe('COMPLETED');
    expect(maxConcurrent).toBe(2); // Strictly throttled by semaphore concurrencyCap
  });

  it('synchronizes fan-in join nodes waiting for all parents to finish', async () => {
    const engine = new DagExecutionEngine();
    const executionTimestamps = new Map<string, { start: number; end: number }>();

    const dag = {
      id: 'join_dag',
      name: 'Join Synchronization',
      nodes: [
        {
          id: 'ParentA',
          dependsOn: [],
          executor: async () => {
            const start = Date.now();
            await new Promise((r) => setTimeout(r, 40));
            executionTimestamps.set('ParentA', { start, end: Date.now() });
            return 'A';
          },
        },
        {
          id: 'ParentB',
          dependsOn: [],
          executor: async () => {
            const start = Date.now();
            await new Promise((r) => setTimeout(r, 20));
            executionTimestamps.set('ParentB', { start, end: Date.now() });
            return 'B';
          },
        },
        {
          id: 'JoinNode',
          dependsOn: ['ParentA', 'ParentB'],
          executor: async ({ parentOutputs }: any) => {
            const start = Date.now();
            executionTimestamps.set('JoinNode', { start, end: Date.now() });
            return `${parentOutputs.get('ParentA')}+${parentOutputs.get('ParentB')}`;
          },
        },
      ],
    };

    const result = await engine.execute(dag);
    expect(result.status).toBe('COMPLETED');
    expect(result.nodeResults.get('JoinNode')?.output).toBe('A+B');

    const parentAEnd = executionTimestamps.get('ParentA')!.end;
    const parentBEnd = executionTimestamps.get('ParentB')!.end;
    const joinStart = executionTimestamps.get('JoinNode')!.start;

    expect(joinStart).toBeGreaterThanOrEqual(parentAEnd);
    expect(joinStart).toBeGreaterThanOrEqual(parentBEnd);
  });

  it('retries failing nodes and succeeds when subsequent attempt passes', async () => {
    const engine = new DagExecutionEngine();
    let attempts = 0;

    const dag = {
      id: 'retry_dag',
      name: 'Retry Scenario',
      nodes: [
        {
          id: 'FlakyNode',
          dependsOn: [],
          retryPolicy: {
            maxRetries: 3,
            baseDelayMs: 10,
            jitterStrategy: 'none' as const,
          },
          executor: async () => {
            attempts++;
            if (attempts < 3) {
              throw new Error(`Flaky failure on attempt ${attempts}`);
            }
            return 'success_on_attempt_3';
          },
        },
      ],
    };

    const result = await engine.execute(dag);
    expect(result.status).toBe('COMPLETED');
    expect(attempts).toBe(3);
    expect(result.nodeResults.get('FlakyNode')?.output).toBe('success_on_attempt_3');
    expect(result.nodeResults.get('FlakyNode')?.attempt).toBe(3);
  });

  it('cascades error to dependent nodes while non-dependent parallel branch completes', async () => {
    const engine = new DagExecutionEngine();

    // Branch 1: FailRoot -> Child1 -> Grandchild1 (should fail & cascade blocked)
    // Branch 2: HealthyRoot -> Child2 (should succeed completely)
    const dag = {
      id: 'cascade_dag',
      name: 'Error Cascade & Branch Isolation',
      nodes: [
        {
          id: 'FailRoot',
          dependsOn: [],
          maxRetries: 1,
          retryPolicy: { baseDelayMs: 5, jitterStrategy: 'none' as const },
          executor: async () => {
            throw new Error('Fatal database connection error');
          },
        },
        {
          id: 'Child1',
          dependsOn: ['FailRoot'],
          executor: async () => 'never_runs',
        },
        {
          id: 'Grandchild1',
          dependsOn: ['Child1'],
          executor: async () => 'never_runs_either',
        },
        {
          id: 'HealthyRoot',
          dependsOn: [],
          executor: async () => 'healthy_1',
        },
        {
          id: 'Child2',
          dependsOn: ['HealthyRoot'],
          executor: async () => 'healthy_2',
        },
      ],
    };

    const result = await engine.execute(dag);
    expect(result.status).toBe('FAILED');

    // Branch 1 failed & blocked
    expect(result.nodeResults.get('FailRoot')?.status).toBe('failed');
    expect(result.nodeResults.get('Child1')?.status).toBe('blocked');
    expect(result.nodeResults.get('Grandchild1')?.status).toBe('blocked');

    // Branch 2 completed successfully
    expect(result.nodeResults.get('HealthyRoot')?.status).toBe('completed');
    expect(result.nodeResults.get('HealthyRoot')?.output).toBe('healthy_1');
    expect(result.nodeResults.get('Child2')?.status).toBe('completed');
    expect(result.nodeResults.get('Child2')?.output).toBe('healthy_2');
  });

  it('enforces node-level execution timeout', async () => {
    const engine = new DagExecutionEngine();

    const dag = {
      id: 'timeout_dag',
      name: 'Node Timeout',
      nodes: [
        {
          id: 'SlowNode',
          dependsOn: [],
          timeoutMs: 30,
          maxRetries: 0,
          executor: async ({ signal }: any) => {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 200);
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(signal.reason ?? new Error('Aborted'));
              });
            });
            return 'done';
          },
        },
      ],
    };

    const result = await engine.execute(dag);
    expect(result.status).toBe('FAILED');
    expect(result.nodeResults.get('SlowNode')?.status).toBe('failed');
    expect(result.nodeResults.get('SlowNode')?.error).toContain('timed out');
  });

  it('emits lifecycle events throughout execution', async () => {
    const engine = new DagExecutionEngine();
    const emittedEvents: string[] = [];

    engine.on('dag_started', () => emittedEvents.push('dag_started'));
    engine.on('dag_node_ready', (e) => emittedEvents.push(`ready:${e.nodeId}`));
    engine.on('dag_node_started', (e) => emittedEvents.push(`started:${e.nodeId}`));
    engine.on('dag_node_completed', (e) => emittedEvents.push(`completed:${e.nodeId}`));
    engine.on('dag_completed', () => emittedEvents.push('dag_completed'));

    const dag = {
      id: 'event_dag',
      name: 'Event Flow',
      nodes: [
        { id: 'E1', dependsOn: [], executor: async () => 'E1' },
        { id: 'E2', dependsOn: ['E1'], executor: async () => 'E2' },
      ],
    };

    await engine.execute(dag);
    expect(emittedEvents).toContain('dag_started');
    expect(emittedEvents).toContain('ready:E1');
    expect(emittedEvents).toContain('started:E1');
    expect(emittedEvents).toContain('completed:E1');
    expect(emittedEvents).toContain('ready:E2');
    expect(emittedEvents).toContain('started:E2');
    expect(emittedEvents).toContain('completed:E2');
    expect(emittedEvents).toContain('dag_completed');
  });

  it('enforces workflow-level deadlineMs and aborts remaining tasks', async () => {
    const engine = new DagExecutionEngine();

    const dag = {
      id: 'deadline_dag',
      name: 'Deadline Workflow',
      deadlineMs: 40,
      nodes: [
        {
          id: 'SlowWorkflowStep',
          dependsOn: [],
          maxRetries: 0,
          executor: async ({ signal }: any) => {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 300);
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(signal.reason ?? new Error('Aborted'));
              });
            });
            return 'done';
          },
        },
      ],
    };

    const result = await engine.execute(dag);
    expect(result.status).toBe('FAILED');
    expect(result.nodeResults.get('SlowWorkflowStep')?.status).toBe('failed');
  });

  it('utilizes idempotencyStore to avoid redundant execution of cached tasks', async () => {
    const idempotencyStore = new Map<string, unknown>();
    let runCount = 0;

    const engine = new DagExecutionEngine({ idempotencyStore });
    const dag = {
      id: 'idempotent_dag',
      name: 'Idempotent DAG',
      nodes: [
        {
          id: 'cached_step',
          dependsOn: [],
          executor: async () => {
            runCount++;
            return 'fresh_value';
          },
        },
      ],
    };

    // First run: executes normally and populates cache
    const res1 = await engine.execute(dag, { runId: 'run_fixed_id' });
    expect(res1.status).toBe('COMPLETED');
    expect(runCount).toBe(1);
    expect(res1.nodeResults.get('cached_step')?.output).toBe('fresh_value');

    // Second run with same runId: should read from cache and skip execution
    const res2 = await engine.execute(dag, { runId: 'run_fixed_id' });
    expect(res2.status).toBe('COMPLETED');
    expect(runCount).toBe(1); // Not incremented!
    expect(res2.nodeResults.get('cached_step')?.output).toBe('fresh_value');
  });
});

