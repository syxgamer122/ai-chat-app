import { DagNodeStatus } from '../dag/types';

/**
 * Checkpointed state of an individual node in the execution graph.
 */
export interface NodeCheckpointState {
  nodeId?: string;
  name?: string;
  title?: string;
  status: DagNodeStatus;
  attempt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  ownedFiles?: string[];
  output?: unknown;
  error?: string;
  criticVerdict?: string;
  idempotencyToken?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Checkpointed state of a full workflow DAG execution.
 */
export interface WorkflowCheckpoint {
  version: string; // e.g. '1.0.0'
  runId: string;
  dagId: string;
  dagDefinitionHash?: string;
  status: 'running' | 'paused' | 'interrupted' | 'completed' | 'failed' | 'COMPLETED' | 'PAUSED' | 'FAILED' | 'CANCELLED';
  createdAt: number;
  updatedAt: number;
  pausedAt?: number;
  resumedAt?: number;
  pauseReason?: string;
  completedNodeIds: string[];
  failedNodeIds: string[];
  blockedNodeIds: string[];
  nodes: Record<string, NodeCheckpointState>;
  context?: Record<string, unknown>;
  fileStats?: Array<{ file: string; additions: number; deletions: number }>;
}

/**
 * Lightweight summary of a stored checkpoint.
 */
export interface CheckpointSummary {
  runId: string;
  dagId: string;
  status: string;
  updatedAt: number;
  completedNodesCount: number;
  totalNodesCount: number;
}

/**
 * Storage interface for persisting and restoring workflow checkpoints.
 */
export interface CheckpointStore {
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
  load(runId: string): Promise<WorkflowCheckpoint | null>;
  list(dagId?: string): Promise<CheckpointSummary[]>;
  latest?(dagId: string): Promise<WorkflowCheckpoint | null>;
  delete(runId: string): Promise<boolean>;
}

export class CheckpointSerializationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CheckpointSerializationError';
  }
}

export class IncompatibleCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompatibleCheckpointError';
  }
}
