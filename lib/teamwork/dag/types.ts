/**
 * Type definitions, interfaces, and custom errors for the Durable DAG Engine.
 *
 * Requirements:
 * - Topological dependency resolution (Kahn's algorithm)
 * - Parallel branch execution & join nodes
 * - Error cascading & branch isolation
 * - Queue concurrency limits & semaphores
 * - Exponential backoff with randomized jitter
 */

export type DagNodeStatus =
  | 'pending'       // Waiting for prerequisites or slot
  | 'ready'         // Prerequisites satisfied, ready for execution
  | 'running'       // Actively executing worker/task
  | 'reviewing'     // Under Critic or validation verification
  | 'interrupted'   // Paused at HITL approval gate
  | 'completed'     // Finished successfully (Critic PASS)
  | 'failed'        // Failed and exhausted retries
  | 'blocked'       // Downstream node whose prerequisite failed
  | 'skipped';      // Intentionally bypassed by policy

export type JitterStrategy = 'full' | 'equal' | 'decorrelated' | 'authoritative' | 'none';

export interface RetryPolicyOptions {
  maxRetries?: number;             // Default: 3
  baseDelayMs?: number;            // Default: 1000ms
  maxDelayMs?: number;             // Default: 30000ms
  factor?: number;                // Default: 2
  jitterStrategy?: JitterStrategy;// Default: 'authoritative'
  jitterType?: JitterStrategy;    // Alias for jitterStrategy
  jitterRatio?: number;           // Default: 0.2 (±20% jitter)
  isRetryable?: (error: unknown) => boolean;
}

export interface IRetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
  readonly jitterStrategy: JitterStrategy;
  readonly jitterRatio: number;
  shouldRetry(attempt: number, error?: unknown): boolean;
  computeDelay(attempt: number): number;
  waitDelay(attempt: number, signal?: AbortSignal): Promise<number>;
}

export interface DagNode<TInput = unknown, TOutput = unknown> {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  assignedWorker?: string;
  ownedFiles?: string[];
  dependsOn: string[]; // List of prerequisite node IDs
  timeoutMs?: number;
  retryPolicy?: RetryPolicyOptions | IRetryPolicy;
  status?: DagNodeStatus;
  input?: TInput;
  output?: TOutput;
  error?: string;
  attempt?: number;
  maxRetries?: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  execute?: (context: DagExecutionContext<TInput>) => Promise<TOutput>;
  executor?: (context: DagExecutionContext<TInput>) => Promise<TOutput>;
}

export interface DagEdge {
  from: string; // Prerequisite node ID
  to: string;   // Dependent node ID
}

export interface DagDefinition<TInput = unknown, TOutput = unknown> {
  id: string;
  name?: string;
  nodes: DagNode<TInput, TOutput>[];
  concurrencyCap?: number;
  deadlineMs?: number;
  metadata?: Record<string, unknown>;
}

export interface DagExecutionPlan {
  sortedNodeIds: string[];
  levels: string[][];                         // Parallel execution waves
  initialReadyNodes: string[];                // In-degree = 0 nodes
  leafNodes: string[];                        // Out-degree = 0 nodes
  dependencyGraph: Map<string, Set<string>>;  // Node -> parent IDs
  reverseGraph: Map<string, Set<string>>;     // Node -> child IDs
}

export interface DagExecutionContext<TInput = unknown> {
  nodeId: string;
  runId: string;
  attempt: number;
  input?: TInput;
  parentOutputs: Map<string, unknown>;
  signal: AbortSignal;
  log: (message: string, details?: unknown) => void;
  checkpoint?: (state: unknown) => Promise<void>;
  idempotencyToken?: string;
}

export interface DagNodeResult<TOutput = unknown> {
  nodeId: string;
  status: DagNodeStatus;
  output?: TOutput;
  error?: string;
  attempt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

export interface DagExecutionResult {
  runId: string;
  dagId: string;
  status: 'COMPLETED' | 'FAILED' | 'PAUSED' | 'CANCELLED';
  nodeResults: Map<string, DagNodeResult>;
  checkpointId?: string;
  durationMs: number;
  error?: string;
}

export type DagEventType =
  | 'dag_started'
  | 'dag_node_ready'
  | 'dag_node_started'
  | 'dag_node_retry'
  | 'dag_node_completed'
  | 'dag_node_failed'
  | 'dag_node_blocked'
  | 'dag_node_skipped'
  | 'dag_node_interrupted'
  | 'dag_node_log'
  | 'dag_completed'
  | 'dag_failed'
  | 'dag_paused'
  | 'dag_cancelled';

export interface DagEvent {
  type: DagEventType;
  timestamp: number;
  dagId: string;
  runId: string;
  nodeId?: string;
  workerId?: string;
  message?: string;
  payload?: Record<string, unknown>;
}

export type DagEventListener = (event: DagEvent) => void;

// Custom Error Classes

export class DagEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DagEngineError';
  }
}

export class CycleDetectedError extends DagEngineError {
  public readonly cyclePath: string[];

  constructor(cyclePath: string[]) {
    super(`Cyclic dependency detected in DAG: ${cyclePath.join(' -> ')}`);
    this.name = 'CycleDetectedError';
    this.cyclePath = cyclePath;
  }
}

export class MissingDependencyError extends DagEngineError {
  public readonly nodeId: string;
  public readonly missingDep: string;

  constructor(nodeId: string, missingDep: string) {
    super(`Node "${nodeId}" specifies non-existent dependency "${missingDep}".`);
    this.name = 'MissingDependencyError';
    this.nodeId = nodeId;
    this.missingDep = missingDep;
  }
}

export class DependencyFailedError extends DagEngineError {
  public readonly nodeId: string;
  public readonly failedPrerequisite: string;

  constructor(nodeId: string, failedPrerequisite: string, reason?: string) {
    super(`Node "${nodeId}" cannot execute because prerequisite "${failedPrerequisite}" failed: ${reason ?? 'Unknown reason'}`);
    this.name = 'DependencyFailedError';
    this.nodeId = nodeId;
    this.failedPrerequisite = failedPrerequisite;
  }
}

export class ExecutionTimeoutError extends DagEngineError {
  public readonly target: string;
  public readonly timeoutMs: number;

  constructor(target: string, timeoutMs: number) {
    super(`Execution timed out for "${target}" after ${timeoutMs}ms.`);
    this.name = 'ExecutionTimeoutError';
    this.target = target;
    this.timeoutMs = timeoutMs;
  }
}
