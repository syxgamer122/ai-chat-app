import { deserializeCheckpoint, serializeCheckpoint } from './serializer';
import {
  CheckpointStore,
  CheckpointSummary,
  WorkflowCheckpoint,
} from './types';

/**
 * In-memory implementation of CheckpointStore for tests and ephemeral runs.
 * Clones checkpoints upon read and write to prevent shared state mutations.
 */
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly storage = new Map<string, string>();

  /**
   * Persists a workflow checkpoint in memory.
   */
  public async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    const serialized = serializeCheckpoint(checkpoint);
    this.storage.set(checkpoint.runId, serialized);
  }

  /**
   * Loads a workflow checkpoint by run ID.
   */
  public async load(runId: string): Promise<WorkflowCheckpoint | null> {
    const serialized = this.storage.get(runId);
    if (!serialized) {
      return null;
    }
    return deserializeCheckpoint(serialized);
  }

  /**
   * Lists checkpoint summaries, optionally filtered by dagId, sorted by updatedAt descending.
   */
  public async list(dagId?: string): Promise<CheckpointSummary[]> {
    const summaries: CheckpointSummary[] = [];

    for (const serialized of this.storage.values()) {
      const cp = deserializeCheckpoint(serialized);
      if (!dagId || cp.dagId === dagId) {
        summaries.push({
          runId: cp.runId,
          dagId: cp.dagId,
          status: cp.status,
          updatedAt: cp.updatedAt,
          completedNodesCount: cp.completedNodeIds.length,
          totalNodesCount: Object.keys(cp.nodes).length,
        });
      }
    }

    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Returns the latest checkpoint for a given dagId, or null if none exist.
   */
  public async latest(dagId: string): Promise<WorkflowCheckpoint | null> {
    const list = await this.list(dagId);
    if (list.length === 0) {
      return null;
    }
    return this.load(list[0].runId);
  }

  /**
   * Deletes a checkpoint by run ID.
   */
  public async delete(runId: string): Promise<boolean> {
    return this.storage.delete(runId);
  }

  /**
   * Clears all stored checkpoints.
   */
  public clear(): void {
    this.storage.clear();
  }

  /**
   * Returns the count of stored checkpoints.
   */
  public get size(): number {
    return this.storage.size;
  }
}
