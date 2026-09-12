import { CheckpointStore, IncompatibleCheckpointError, WorkflowCheckpoint } from '../checkpoint/types';
import { computeDagDefinitionHash, generateIdempotencyToken } from '../checkpoint/serializer';
import { RetryPolicy } from './backoff';
import { DagGraph } from './graph';
import { AsyncSemaphore } from './semaphore';
import { computeTopologicalPlan } from './topological-sort';
import {
  DagDefinition,
  DagEngineError,
  DagEvent,
  DagEventListener,
  DagEventType,
  DagExecutionContext,
  DagExecutionPlan,
  DagExecutionResult,
  DagNode,
  DagNodeResult,
  DagNodeStatus,
  DependencyFailedError,
  ExecutionTimeoutError,
  IRetryPolicy,
} from './types';

export interface DagEngineOptions {
  concurrencyCap?: number;
  deadlineMs?: number;
  semaphore?: AsyncSemaphore;
  checkpointStore?: CheckpointStore;
  autoCheckpoint?: boolean;
  runId?: string;
  idempotencyStore?: Map<string, unknown>;
}

export interface DagExecutionOptions {
  runId?: string;
  signal?: AbortSignal;
  initialContext?: Record<string, unknown>;
}

/**
 * DagExecutionEngine orchestrates the durable, concurrent execution of DAG workflows.
 * Features:
 * - Topological dependency ordering & cycle validation
 * - Dynamic parallel branch scheduling
 * - Multi-parent join node synchronization
 * - Transitive error cascading with branch isolation
 * - Concurrency rate limiting via AsyncSemaphore
 * - Exponential retry backoff with randomized jitter
 * - Node timeouts and workflow deadlines
 * - Checkpointing, pause, and resumption
 */
export class DagExecutionEngine {
  private readonly defaultConcurrencyCap: number;
  private readonly deadlineMs?: number;
  private readonly checkpointStore?: CheckpointStore;
  private readonly autoCheckpoint: boolean;
  private readonly idempotencyStore?: Map<string, unknown>;
  private readonly listeners = new Map<DagEventType, Set<DagEventListener>>();

  // Active execution state
  private activeSemaphore?: AsyncSemaphore;
  private isPaused = false;
  private isCancelled = false;
  private pauseReason?: string;

  constructor(options?: DagEngineOptions) {
    this.defaultConcurrencyCap = Math.max(1, options?.concurrencyCap ?? 2);
    this.deadlineMs = options?.deadlineMs;
    this.checkpointStore = options?.checkpointStore;
    this.autoCheckpoint = options?.autoCheckpoint ?? Boolean(options?.checkpointStore);
    this.idempotencyStore = options?.idempotencyStore;
  }

  /**
   * Subscribe to DAG execution events.
   */
  public on(event: DagEventType, listener: DagEventListener): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
    return this;
  }

  /**
   * Unsubscribe from DAG execution events.
   */
  public off(event: DagEventType, listener: DagEventListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  /**
   * Emits a lifecycle event.
   */
  private emit(event: DagEvent): void {
    const listeners = this.listeners.get(event.type);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Prevent listener errors from corrupting engine loop
        }
      }
    }
  }

  /**
   * Requests the currently running workflow to pause cleanly.
   */
  public async pause(reason: string = 'Workflow paused by user'): Promise<void> {
    this.isPaused = true;
    this.pauseReason = reason;
  }

  /**
   * Requests cancellation of the currently running workflow.
   */
  public async cancel(reason: string = 'Workflow cancelled'): Promise<void> {
    this.isCancelled = true;
    this.pauseReason = reason;
  }

  /**
   * Executes a DAG workflow.
   */
  public async execute<TInput = unknown, TOutput = unknown>(
    dagInput: DagDefinition<TInput, TOutput> | DagGraph<TInput, TOutput>,
    options?: DagExecutionOptions
  ): Promise<DagExecutionResult> {
    this.isPaused = false;
    this.isCancelled = false;
    this.pauseReason = undefined;

    const graph =
      dagInput instanceof DagGraph
        ? dagInput
        : DagGraph.fromDefinition(dagInput);

    const nodes = graph.getNodes();
    // Derive a STABLE dagId for graph inputs from the topology so that checkpoints written
    // for the same graph can be found again (a timestamp-based id made resume impossible).
    const dagId =
      dagInput instanceof DagGraph
        ? `dag_${computeDagDefinitionHash(nodes).slice(0, 12)}`
        : dagInput.id;
    const runId =
      options?.runId ?? `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const concurrencyCap =
      dagInput instanceof DagGraph
        ? this.defaultConcurrencyCap
        : dagInput.concurrencyCap ?? this.defaultConcurrencyCap;

    this.activeSemaphore = new AsyncSemaphore(concurrencyCap);

    // 1. Compute and validate topological execution plan (throws on cycles/missing deps)
    const plan = computeTopologicalPlan(nodes);

    const deadline =
      (dagInput instanceof DagGraph ? undefined : dagInput.deadlineMs) ??
      this.deadlineMs;

    return this.runWorkflowInternal(
      dagId,
      runId,
      nodes,
      plan,
      this.activeSemaphore,
      deadline,
      options
    );
  }

  /**
   * Resumes execution from a previously saved checkpoint.
   */
  public async resume<TInput = unknown, TOutput = unknown>(
    checkpointOrRunId: WorkflowCheckpoint | string,
    dagInput: DagDefinition<TInput, TOutput> | DagGraph<TInput, TOutput>,
    options?: DagExecutionOptions
  ): Promise<DagExecutionResult> {
    let checkpoint: WorkflowCheckpoint;

    if (typeof checkpointOrRunId === 'string') {
      if (!this.checkpointStore) {
        throw new DagEngineError(
          'Cannot resume by runId without a configured CheckpointStore.'
        );
      }
      const loaded = await this.checkpointStore.load(checkpointOrRunId);
      if (!loaded) {
        throw new DagEngineError(
          `Checkpoint for runId "${checkpointOrRunId}" not found.`
        );
      }
      checkpoint = loaded;
    } else {
      checkpoint = checkpointOrRunId;
    }

    this.isPaused = false;
    this.isCancelled = false;
    this.pauseReason = undefined;

    const graph =
      dagInput instanceof DagGraph
        ? dagInput
        : DagGraph.fromDefinition(dagInput);

    const nodes = graph.getNodes();
    const dagId = checkpoint.dagId;
    const runId = checkpoint.runId;

    // Guard against resuming a checkpoint produced by a DIFFERENT DAG topology.
    if (checkpoint.dagDefinitionHash) {
      const currentHash = computeDagDefinitionHash(
        nodes.map((n) => ({ id: n.id, dependsOn: n.dependsOn }))
      );
      if (currentHash !== checkpoint.dagDefinitionHash) {
        throw new IncompatibleCheckpointError(
          `Checkpoint "${checkpoint.runId}" was produced by a different DAG definition ` +
            `(expected topology ${checkpoint.dagDefinitionHash}, got ${currentHash}).`
        );
      }
    }

    const concurrencyCap =
      dagInput instanceof DagGraph
        ? this.defaultConcurrencyCap
        : dagInput.concurrencyCap ?? this.defaultConcurrencyCap;

    this.activeSemaphore = new AsyncSemaphore(concurrencyCap);

    const plan = computeTopologicalPlan(nodes);
    const deadline =
      (dagInput instanceof DagGraph ? undefined : dagInput.deadlineMs) ??
      this.deadlineMs;

    return this.runWorkflowInternal(
      dagId,
      runId,
      nodes,
      plan,
      this.activeSemaphore,
      deadline,
      options,
      checkpoint
    );
  }

  /**
   * Internal execution engine loop.
   */
  private async runWorkflowInternal<TInput, TOutput>(
    dagId: string,
    runId: string,
    nodes: DagNode<TInput, TOutput>[],
    plan: DagExecutionPlan,
    semaphore: AsyncSemaphore,
    deadlineMs?: number,
    options?: DagExecutionOptions,
    checkpoint?: WorkflowCheckpoint
  ): Promise<DagExecutionResult> {
    const startTime = Date.now();
    const nodeMap = new Map<string, DagNode<TInput, TOutput>>();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    // Initialize state
    const nodeStatus = new Map<string, DagNodeStatus>();
    const nodeResults = new Map<string, DagNodeResult>();
    const parentOutputs = new Map<string, unknown>();
    const remainingInDegree = new Map<string, number>();
    /** Node-declared durable state, persisted into the checkpoint's `context`. */
    const nodeCheckpointState = new Map<string, unknown>();

    for (const node of nodes) {
      nodeStatus.set(node.id, 'pending');
      remainingInDegree.set(node.id, node.dependsOn.length);
    }

    // Pre-populate completed nodes if resuming from checkpoint
    if (checkpoint) {
      for (const completedId of checkpoint.completedNodeIds) {
        const cpNode = checkpoint.nodes[completedId];
        if (cpNode && cpNode.status === 'completed') {
          nodeStatus.set(completedId, 'completed');
          if (cpNode.output !== undefined) {
            parentOutputs.set(completedId, cpNode.output);
          }
          nodeResults.set(completedId, {
            nodeId: completedId,
            status: 'completed',
            output: cpNode.output,
            attempt: cpNode.attempt,
            startedAt: cpNode.startedAt,
            completedAt: cpNode.completedAt,
            durationMs: cpNode.durationMs,
          });

          // Adjust in-degrees of children for this already completed node
          const children = plan.reverseGraph.get(completedId) || new Set<string>();
          for (const childId of children) {
            const cur = remainingInDegree.get(childId) ?? 1;
            remainingInDegree.set(childId, Math.max(0, cur - 1));
          }
        }
      }

      // Previously-failed / blocked nodes must NOT silently re-run on resume: the
      // checkpoint recorded them for a reason, and re-running their dependents would
      // re-execute work whose prerequisites never succeeded.
      for (const failedId of checkpoint.failedNodeIds) {
        if (!nodeStatus.has(failedId) || nodeStatus.get(failedId) === 'completed') continue;
        const cpNode = checkpoint.nodes[failedId];
        nodeStatus.set(failedId, 'failed');
        nodeResults.set(failedId, {
          nodeId: failedId,
          status: 'failed',
          error: cpNode?.error ?? 'Node previously failed before this checkpoint.',
          attempt: cpNode?.attempt ?? 0,
        });
      }
      for (const blockedId of checkpoint.blockedNodeIds) {
        if (!nodeStatus.has(blockedId) || nodeStatus.get(blockedId) === 'completed') continue;
        const cpNode = checkpoint.nodes[blockedId];
        nodeStatus.set(blockedId, 'blocked');
        nodeResults.set(blockedId, {
          nodeId: blockedId,
          status: 'blocked',
          error: cpNode?.error ?? 'Node was blocked by a failed prerequisite before this checkpoint.',
          attempt: 0,
        });
      }
    }

    // Abort controller setup
    const workflowAbortController = new AbortController();
    let deadlineTimer: NodeJS.Timeout | null = null;

    // Forward external aborts; kept as a named handler so it can be detached when the run settles.
    const onExternalAbort = () => workflowAbortController.abort(options?.signal?.reason);

    if (deadlineMs && deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        workflowAbortController.abort(
          new ExecutionTimeoutError(`Workflow "${dagId}"`, deadlineMs)
        );
      }, deadlineMs);
    }

    if (options?.signal) {
      if (options.signal.aborted) {
        workflowAbortController.abort(options.signal.reason);
      } else {
        options.signal.addEventListener('abort', onExternalAbort);
      }
    }

    this.emit({
      type: 'dag_started',
      timestamp: startTime,
      dagId,
      runId,
      message: `DAG execution started with ${nodes.length} nodes.`,
    });

    // Track active node promises
    const inFlightPromises = new Set<Promise<void>>();

    // Helper to persist checkpoint
    const saveCheckpoint = async (status: WorkflowCheckpoint['status']) => {
      if (!this.checkpointStore) return;
      const completedNodeIds: string[] = [];
      const failedNodeIds: string[] = [];
      const blockedNodeIds: string[] = [];
      const nodesRecord: WorkflowCheckpoint['nodes'] = {};

      for (const [id, st] of nodeStatus.entries()) {
        if (st === 'completed') completedNodeIds.push(id);
        if (st === 'failed') failedNodeIds.push(id);
        if (st === 'blocked') blockedNodeIds.push(id);

        const res = nodeResults.get(id);
        nodesRecord[id] = {
          nodeId: id,
          title: nodeMap.get(id)?.title ?? nodeMap.get(id)?.name,
          status: st,
          attempt: res?.attempt ?? 1,
          startedAt: res?.startedAt,
          completedAt: res?.completedAt,
          durationMs: res?.durationMs,
          ownedFiles: nodeMap.get(id)?.ownedFiles,
          output: res?.output,
          error: res?.error,
          // Same canonical key shape as the in-memory idempotency store.
          idempotencyToken: generateIdempotencyToken(runId, id),
        };
      }

      const cp: WorkflowCheckpoint = {
        version: '1.0.0',
        runId,
        dagId,
        dagDefinitionHash: computeDagDefinitionHash(
          nodes.map((n) => ({ id: n.id, dependsOn: n.dependsOn }))
        ),
        status,
        createdAt: checkpoint?.createdAt ?? startTime,
        updatedAt: Date.now(),
        pausedAt: this.isPaused ? Date.now() : undefined,
        pauseReason: this.pauseReason,
        completedNodeIds,
        failedNodeIds,
        blockedNodeIds,
        nodes: nodesRecord,
        context: {
          ...(options?.initialContext ?? {}),
          ...Object.fromEntries(nodeCheckpointState),
        },
      };

      try {
        await this.checkpointStore.save(cp);
      } catch {
        // Continue even if checkpoint save fails
      }
    };

    // Helper: Cascade error to all downstream transitive descendants
    const cascadeBlockDownstream = (rootFailedId: string, reason: string) => {
      const queue = [rootFailedId];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const curr = queue.shift()!;
        const children = plan.reverseGraph.get(curr) || new Set<string>();

        for (const childId of children) {
          if (visited.has(childId)) continue;
          visited.add(childId);

          const currentSt = nodeStatus.get(childId);
          if (currentSt !== 'completed' && currentSt !== 'running') {
            nodeStatus.set(childId, 'blocked');
            nodeResults.set(childId, {
              nodeId: childId,
              status: 'blocked',
              error: new DependencyFailedError(childId, rootFailedId, reason).message,
              attempt: 0,
            });

            this.emit({
              type: 'dag_node_blocked',
              timestamp: Date.now(),
              dagId,
              runId,
              nodeId: childId,
              message: `Blocked due to failure of upstream prerequisite "${rootFailedId}".`,
            });

            queue.push(childId);
          }
        }
      }
    };

    // Dispatcher: schedules ready nodes
    const scheduleReadyNodes = () => {
      if (this.isPaused || this.isCancelled) return;

      for (const node of nodes) {
        const status = nodeStatus.get(node.id);
        const inDeg = remainingInDegree.get(node.id) ?? 0;

        if (status === 'pending' && inDeg === 0) {
          nodeStatus.set(node.id, 'ready');
          this.emit({
            type: 'dag_node_ready',
            timestamp: Date.now(),
            dagId,
            runId,
            nodeId: node.id,
            message: `Node "${node.id}" is ready for execution.`,
          });

          // Dispatch node execution
          const promise = executeNode(node);
          inFlightPromises.add(promise);
          promise.finally(() => {
            inFlightPromises.delete(promise);
          });
        }
      }
    };

    // Execute individual node
    const executeNode = async (node: DagNode<TInput, TOutput>): Promise<void> => {
      // If paused/cancelled before acquiring slot
      if (this.isPaused || this.isCancelled) {
        nodeStatus.set(node.id, 'pending');
        return;
      }

      // Check idempotency token
      const idempotencyKey = generateIdempotencyToken(runId, node.id);
      if (this.idempotencyStore && this.idempotencyStore.has(idempotencyKey)) {
        const cached = this.idempotencyStore.get(idempotencyKey);
        nodeStatus.set(node.id, 'completed');
        parentOutputs.set(node.id, cached);
        nodeResults.set(node.id, {
          nodeId: node.id,
          status: 'completed',
          output: cached as TOutput,
          attempt: 1,
          startedAt: Date.now(),
          completedAt: Date.now(),
          durationMs: 0,
        });
        onNodeSuccess(node.id, cached);
        return;
      }

      // Acquire semaphore slot
      let slot;
      try {
        slot = await semaphore.acquire(undefined, workflowAbortController.signal);
      } catch (err) {
        if (workflowAbortController.signal.aborted) {
          nodeStatus.set(node.id, 'failed');
          nodeResults.set(node.id, {
            nodeId: node.id,
            status: 'failed',
            error: (err as Error).message,
            attempt: 0,
          });
          return;
        }
        throw err;
      }

      nodeStatus.set(node.id, 'running');
      const nodeStartTime = Date.now();
      this.emit({
        type: 'dag_node_started',
        timestamp: nodeStartTime,
        dagId,
        runId,
        nodeId: node.id,
        workerId: node.assignedWorker,
        message: `Node "${node.id}" started execution.`,
      });

      // Prepare retry policy
      const retryPolicy: IRetryPolicy =
        node.retryPolicy && 'computeDelay' in node.retryPolicy
          ? (node.retryPolicy as IRetryPolicy)
          : new RetryPolicy(node.retryPolicy);

      const maxRetries = node.maxRetries ?? retryPolicy.maxRetries;
      let attempt = 1;
      let lastError: unknown = null;

      try {
        while (attempt <= maxRetries + 1) {
          if (workflowAbortController.signal.aborted) {
            throw (
              workflowAbortController.signal.reason ??
              new DagEngineError('Execution aborted by signal.')
            );
          }

          // Node timeout controller
          const nodeAbortController = new AbortController();
          let nodeTimeoutTimer: NodeJS.Timeout | null = null;

          const onWorkflowAbort = () => {
            nodeAbortController.abort(workflowAbortController.signal.reason);
          };
          workflowAbortController.signal.addEventListener('abort', onWorkflowAbort);

          if (node.timeoutMs && node.timeoutMs > 0) {
            nodeTimeoutTimer = setTimeout(() => {
              nodeAbortController.abort(
                new ExecutionTimeoutError(node.id, node.timeoutMs!)
              );
            }, node.timeoutMs);
          }

          const executionContext: DagExecutionContext<TInput> = {
            nodeId: node.id,
            runId,
            attempt,
            input: node.input,
            parentOutputs: new Map(parentOutputs),
            signal: nodeAbortController.signal,
            log: (message: string, details?: unknown) => {
              this.emit({
                type: 'dag_node_log',
                timestamp: Date.now(),
                dagId,
                runId,
                nodeId: node.id,
                message,
                payload: details === undefined ? undefined : { details },
              });
            },
            checkpoint: async (state: unknown) => {
              // Persisted into the checkpoint's `context` on the next save.
              nodeCheckpointState.set(node.id, state);
            },
            idempotencyToken: `${runId}:${node.id}:${attempt}`,
          };

          try {
            const executeFn = node.execute ?? node.executor;
            if (!executeFn) {
              throw new DagEngineError(
                `Node "${node.id}" does not define an execute or executor method.`
              );
            }

            const output = await executeFn(executionContext);

            if (nodeTimeoutTimer) clearTimeout(nodeTimeoutTimer);
            workflowAbortController.signal.removeEventListener('abort', onWorkflowAbort);

            // Record success
            const completedAt = Date.now();
            nodeStatus.set(node.id, 'completed');
            parentOutputs.set(node.id, output);
            if (this.idempotencyStore) {
              this.idempotencyStore.set(idempotencyKey, output);
            }

            nodeResults.set(node.id, {
              nodeId: node.id,
              status: 'completed',
              output,
              attempt,
              startedAt: nodeStartTime,
              completedAt,
              durationMs: completedAt - nodeStartTime,
            });

            this.emit({
              type: 'dag_node_completed',
              timestamp: completedAt,
              dagId,
              runId,
              nodeId: node.id,
              message: `Node "${node.id}" completed successfully.`,
            });

            if (this.autoCheckpoint) {
              await saveCheckpoint('running');
            }

            onNodeSuccess(node.id, output);
            return;
          } catch (err: unknown) {
            if (nodeTimeoutTimer) clearTimeout(nodeTimeoutTimer);
            workflowAbortController.signal.removeEventListener('abort', onWorkflowAbort);
            lastError = err;

            const shouldRetry =
              attempt <= maxRetries && retryPolicy.shouldRetry(attempt, err);

            if (shouldRetry && !workflowAbortController.signal.aborted) {
              this.emit({
                type: 'dag_node_retry',
                timestamp: Date.now(),
                dagId,
                runId,
                nodeId: node.id,
                message: `Node "${node.id}" failed on attempt ${attempt}. Retrying...`,
                payload: {
                  attempt,
                  error: err instanceof Error ? err.message : String(err),
                },
              });

              // A workflow abort (e.g. deadline) during the sleep must NOT escape this catch:
              // it would leave the node stuck in 'running' and reject the whole run.
              try {
                await retryPolicy.waitDelay(attempt, workflowAbortController.signal);
              } catch {
                break;
              }
              attempt++;
            } else {
              break;
            }
          }
        }

        // All retries exhausted or non-retryable error
        const failedAt = Date.now();
        nodeStatus.set(node.id, 'failed');
        const errorMsg =
          lastError instanceof Error ? lastError.message : String(lastError);

        nodeResults.set(node.id, {
          nodeId: node.id,
          status: 'failed',
          error: errorMsg,
          attempt,
          startedAt: nodeStartTime,
          completedAt: failedAt,
          durationMs: failedAt - nodeStartTime,
        });

        this.emit({
          type: 'dag_node_failed',
          timestamp: failedAt,
          dagId,
          runId,
          nodeId: node.id,
          message: `Node "${node.id}" failed after ${attempt} attempt(s): ${errorMsg}`,
          payload: { error: errorMsg },
        });

        // Error cascading: block all downstream dependents
        cascadeBlockDownstream(node.id, errorMsg);

        if (this.autoCheckpoint) {
          await saveCheckpoint('running');
        }
      } finally {
        slot.release();
        // Trigger next wave of ready nodes
        scheduleReadyNodes();
      }
    };

    // When a node succeeds, decrease in-degrees of its children
    const onNodeSuccess = (completedNodeId: string, output: unknown) => {
      const children = plan.reverseGraph.get(completedNodeId) || new Set<string>();
      for (const childId of children) {
        const curDeg = remainingInDegree.get(childId) ?? 1;
        const newDeg = Math.max(0, curDeg - 1);
        remainingInDegree.set(childId, newDeg);
      }
      scheduleReadyNodes();
    };

    // Initial dispatch
    scheduleReadyNodes();

    // Event loop wait: wait until all active in-flight promises resolve
    while (inFlightPromises.size > 0) {
      await Promise.race(inFlightPromises);
      scheduleReadyNodes();
    }

    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }

    // Detach the caller-owned signal listener so repeated runs do not leak handlers.
    options?.signal?.removeEventListener('abort', onExternalAbort);

    const durationMs = Date.now() - startTime;

    // Determine final status
    let finalStatus: DagExecutionResult['status'];
    if (this.isCancelled) {
      finalStatus = 'CANCELLED';
    } else if (this.isPaused) {
      finalStatus = 'PAUSED';
    } else {
      let anyFailed = false;
      for (const st of nodeStatus.values()) {
        // 'running' can only remain if a node was aborted mid-flight — that is a failure,
        // never a successful completion.
        if (st === 'failed' || st === 'blocked' || st === 'running') {
          anyFailed = true;
          break;
        }
      }
      finalStatus = anyFailed ? 'FAILED' : 'COMPLETED';
    }

    // Save final checkpoint
    if (this.autoCheckpoint) {
      await saveCheckpoint(
        finalStatus === 'COMPLETED'
          ? 'completed'
          : finalStatus === 'PAUSED'
          ? 'paused'
          : 'failed'
      );
    }

    if (finalStatus === 'COMPLETED') {
      this.emit({
        type: 'dag_completed',
        timestamp: Date.now(),
        dagId,
        runId,
        message: `DAG "${dagId}" completed successfully in ${durationMs}ms.`,
      });
    } else if (finalStatus === 'PAUSED') {
      this.emit({
        type: 'dag_paused',
        timestamp: Date.now(),
        dagId,
        runId,
        message: `DAG "${dagId}" paused: ${this.pauseReason ?? 'Paused'}.`,
      });
    } else {
      this.emit({
        type: 'dag_failed',
        timestamp: Date.now(),
        dagId,
        runId,
        message: `DAG "${dagId}" ended with status ${finalStatus}.`,
      });
    }

    return {
      runId,
      dagId,
      status: finalStatus,
      nodeResults,
      checkpointId: runId,
      durationMs,
      error: this.pauseReason,
    };
  }
}
