import fs from 'node:fs/promises';
import path from 'node:path';
import { deserializeCheckpoint, serializeCheckpoint } from './serializer';
import {
  CheckpointStore,
  CheckpointSummary,
  WorkflowCheckpoint,
} from './types';

export interface FileCheckpointStoreOptions {
  directory?: string;
  baseDir?: string;
  workspaceRoot?: string;
  checkpointDir?: string;
}

/**
 * File-system persistent CheckpointStore with atomic write semantics.
 * Writes to a unique temp file first before atomically renaming to target JSON file.
 * Prevents corrupted or half-written checkpoint states upon unexpected crashes.
 */
export class FileCheckpointStore implements CheckpointStore {
  private readonly baseDir: string;

  constructor(options?: string | FileCheckpointStoreOptions) {
    if (typeof options === 'string') {
      this.baseDir = path.resolve(options);
    } else {
      const root = options?.workspaceRoot ?? process.cwd();
      const dir = options?.directory ?? options?.baseDir ?? options?.checkpointDir ?? '.teamwork/checkpoints';
      this.baseDir = path.resolve(root, dir);
    }
  }

  /**
   * Returns the directory path where checkpoints are stored.
   */
  public get directory(): string {
    return this.baseDir;
  }

  /**
   * Sanitizes a run ID into a safe filesystem filename.
   */
  private getFilePath(runId: string): string {
    const sanitized = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, `${sanitized}.json`);
  }

  /**
   * Atomically saves a workflow checkpoint using write-then-rename pattern.
   */
  public async save(checkpoint: WorkflowCheckpoint): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });

    const targetPath = this.getFilePath(checkpoint.runId);
    const tmpSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp`;
    const tmpPath = `${targetPath}.${tmpSuffix}`;

    const serialized = serializeCheckpoint(checkpoint, true);

    await fs.writeFile(tmpPath, serialized, 'utf8');
    await fs.rename(tmpPath, targetPath);
  }

  /**
   * Loads a workflow checkpoint by run ID.
   */
  public async load(runId: string): Promise<WorkflowCheckpoint | null> {
    const targetPath = this.getFilePath(runId);
    try {
      const content = await fs.readFile(targetPath, 'utf8');
      return deserializeCheckpoint(content);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Lists checkpoint summaries, optionally filtered by dagId, sorted by updatedAt descending.
   */
  public async list(dagId?: string): Promise<CheckpointSummary[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      const summaries: CheckpointSummary[] = [];

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.includes('.tmp')) {
          continue;
        }

        try {
          const raw = await fs.readFile(path.join(this.baseDir, entry.name), 'utf8');
          const cp = deserializeCheckpoint(raw);
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
        } catch {
          // Ignore unreadable or corrupted files during listing
        }
      }

      return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  /**
   * Returns the most recent checkpoint for a given dagId.
   */
  public async latest(dagId: string): Promise<WorkflowCheckpoint | null> {
    const list = await this.list(dagId);
    if (list.length === 0) {
      return null;
    }
    return this.load(list[0].runId);
  }

  /**
   * Deletes a checkpoint by run ID. Returns true if removed, false if not found.
   */
  public async delete(runId: string): Promise<boolean> {
    const targetPath = this.getFilePath(runId);
    try {
      await fs.unlink(targetPath);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }
}
