/**
 * Exclusive File Ownership & Concurrency Guard.
 * Conforms strictly to PROJECT.md và ORIGINAL_REQUEST.md.
 *
 * Rules enforced:
 * 1. Exclusive File Ownership: At any point in time, a source file can only
 *    be owned by exactly one worker. Conflicting milestones must run sequentially.
 * 2. Concurrency Ceiling: Default sequential; max 2 parallel workers only when
 *    target file sets are 100% disjoint. Never allows 3+ parallel workers.
 * 3. Cross-platform path normalization: handles Windows backslashes, duplicate slashes,
 *    relative segments (.), and case insensitivity.
 */

import { FileLock } from './types';

export interface FileLockManagerOptions {
  /** Maximum number of concurrent active workers. Default is 2. */
  concurrencyCap?: number;
  /** Optional workspace root to normalize absolute paths into relative paths. */
  workspaceRoot?: string;
}

/**
 * Normalizes file paths for cross-platform and case-insensitive comparison.
 */
export function normalizeLockPath(rawPath: string, workspaceRoot?: string): string {
  if (!rawPath || typeof rawPath !== 'string') return '';
  let p = rawPath.trim().replace(/\\/g, '/');

  // If workspaceRoot is provided, strip workspaceRoot prefix if present
  if (workspaceRoot) {
    const rootNorm = workspaceRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.toLowerCase().startsWith(rootNorm.toLowerCase())) {
      p = p.slice(rootNorm.length);
    }
  }

  // Collapse multiple slashes
  p = p.replace(/\/+/g, '/');
  // Strip leading ./
  p = p.replace(/^\.\//, '');
  // Strip leading /
  p = p.replace(/^\//, '');
  // Strip trailing /
  p = p.replace(/\/+$/, '');

  // Resolve . and .. segments
  const segments = p.split('/');
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop();
      } else {
        resolved.push('..');
      }
    } else {
      resolved.push(seg);
    }
  }
  p = resolved.join('/');

  // Normalize case (lowercase for cross-platform collision safety, NTFS is case-insensitive)
  return p.toLowerCase();
}

export class FileLockManager {
  private readonly concurrencyCap: number;
  private readonly workspaceRoot?: string;
  private readonly activeLocks: Map<string, FileLock> = new Map(); // normalizedPath -> FileLock
  private readonly workerLocks: Map<string, Set<string>> = new Map(); // workerId -> Set of normalizedPath
  private readonly activeWorkers: Set<string> = new Set();

  constructor(optionsOrCap?: number | FileLockManagerOptions) {
    if (typeof optionsOrCap === 'number') {
      this.concurrencyCap = optionsOrCap > 0 ? optionsOrCap : 2;
    } else if (optionsOrCap) {
      this.concurrencyCap =
        typeof optionsOrCap.concurrencyCap === 'number' && optionsOrCap.concurrencyCap > 0
          ? optionsOrCap.concurrencyCap
          : 2;
      this.workspaceRoot = optionsOrCap.workspaceRoot;
    } else {
      this.concurrencyCap = 2;
    }
  }

  /**
   * Helper to normalize a path with this manager's workspaceRoot.
   */
  public normalize(filePath: string): string {
    return normalizeLockPath(filePath, this.workspaceRoot);
  }

  /**
   * Checks whether the specified worker can acquire all given files without conflicts
   * and without exceeding the concurrency cap.
   */
  public canAcquire(workerId: string, files: string[]): boolean {
    if (!workerId || typeof workerId !== 'string') return false;

    // Check concurrency cap: if worker is not yet active, adding it must not exceed cap
    const isAlreadyActive = this.activeWorkers.has(workerId);
    if (!isAlreadyActive && this.activeWorkers.size >= this.concurrencyCap) {
      return false;
    }

    // Check file conflicts
    for (const file of files) {
      const norm = this.normalize(file);
      if (!norm) continue;
      const existing = this.activeLocks.get(norm);
      if (existing && existing.workerId !== workerId) {
        return false;
      }
    }

    return true;
  }

  /**
   * Acquires exclusive locks on all files for the specified worker atomically.
   * Throws an error if concurrency cap is exceeded or if any file is locked by another worker.
   */
  public acquire(workerId: string, files: string[]): void {
    if (!workerId || typeof workerId !== 'string') {
      throw new Error('Invalid workerId: workerId must be a non-empty string');
    }

    const isAlreadyActive = this.activeWorkers.has(workerId);
    if (!isAlreadyActive && this.activeWorkers.size >= this.concurrencyCap) {
      throw new Error(
        `Concurrency limit reached: maximum ${this.concurrencyCap} parallel workers allowed (currently active: ${Array.from(this.activeWorkers).join(', ')})`
      );
    }

    // Collect and de-duplicate normalized paths in this request
    const uniqueNormalized = new Map<string, string>(); // norm -> original
    for (const file of files) {
      const norm = this.normalize(file);
      if (norm) {
        uniqueNormalized.set(norm, file);
      }
    }

    // Conflict check
    for (const [norm, orig] of uniqueNormalized.entries()) {
      const existing = this.activeLocks.get(norm);
      if (existing && existing.workerId !== workerId) {
        throw new Error(
          `File lock conflict: file "${orig}" (normalized: "${norm}") is already exclusively locked by worker "${existing.workerId}"`
        );
      }
    }

    // Atomic acquisition
    this.activeWorkers.add(workerId);
    let workerSet = this.workerLocks.get(workerId);
    if (!workerSet) {
      workerSet = new Set<string>();
      this.workerLocks.set(workerId, workerSet);
    }

    const now = Date.now();
    for (const [norm, orig] of uniqueNormalized.entries()) {
      const lock: FileLock = {
        filePath: orig,
        normalizedPath: norm,
        workerId,
        acquiredAt: now,
      };
      this.activeLocks.set(norm, lock);
      workerSet.add(norm);
    }
  }

  /**
   * Releases all file locks owned by workerId and unregisters the worker.
   */
  public release(workerId: string, files?: string[]): void {
    if (!workerId) return;

    if (files && files.length > 0) {
      for (const file of files) {
        this.releaseFile(workerId, file);
      }
      return;
    }

    const lockedFiles = this.workerLocks.get(workerId);
    if (lockedFiles) {
      for (const norm of lockedFiles) {
        this.activeLocks.delete(norm);
      }
      this.workerLocks.delete(workerId);
    }
    this.activeWorkers.delete(workerId);
  }

  /**
   * Releases a specific file lock owned by workerId.
   */
  public releaseFile(workerId: string, filePath: string): boolean {
    const norm = this.normalize(filePath);
    const existing = this.activeLocks.get(norm);
    if (!existing || existing.workerId !== workerId) {
      return false;
    }

    this.activeLocks.delete(norm);
    const workerSet = this.workerLocks.get(workerId);
    if (workerSet) {
      workerSet.delete(norm);
      if (workerSet.size === 0) {
        this.activeWorkers.delete(workerId);
      }
    }
    return true;
  }

  /**
   * Returns list of currently active worker IDs holding locks.
   */
  public getActiveWorkers(): string[] {
    return Array.from(this.activeWorkers);
  }

  /**
   * Returns a map of normalizedFilePath -> workerId.
   * Conforms to Interface Contract in PROJECT.md.
   */
  public getActiveLocks(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [norm, lock] of this.activeLocks.entries()) {
      result.set(norm, lock.workerId);
    }
    return result;
  }

  /**
   * Returns detailed FileLock records for all active locks.
   */
  public getDetailedLocks(): Map<string, FileLock> {
    return new Map(this.activeLocks);
  }

  /**
   * Returns true if filePath is currently locked by any worker.
   */
  public isLocked(filePath: string): boolean {
    const norm = this.normalize(filePath);
    return this.activeLocks.has(norm);
  }

  /**
   * Returns workerId owning lock on filePath, or undefined if free.
   */
  public getLockOwner(filePath: string): string | undefined {
    const norm = this.normalize(filePath);
    return this.activeLocks.get(norm)?.workerId;
  }

  /**
   * Returns all normalized file paths locked by workerId.
   */
  public getWorkerFiles(workerId: string): string[] {
    const set = this.workerLocks.get(workerId);
    return set ? Array.from(set) : [];
  }

  /**
   * Clears all locks and active workers.
   */
  public clear(): void {
    this.activeLocks.clear();
    this.workerLocks.clear();
    this.activeWorkers.clear();
  }

  /**
   * Verifies that two arrays of file paths have zero overlap (are completely disjoint).
   */
  public canRunInParallel(worker1Files: string[], worker2Files: string[]): boolean {
    return this.verifyDisjoint([worker1Files, worker2Files]);
  }

  /**
   * Verifies whether an arbitrary number of file sets are pairwise disjoint.
   */
  public verifyDisjoint(fileSets: string[][]): boolean {
    const seen = new Set<string>();
    for (const set of fileSets) {
      for (const file of set) {
        const norm = this.normalize(file);
        if (!norm) continue;
        if (seen.has(norm)) {
          return false;
        }
        seen.add(norm);
      }
    }
    return true;
  }
}
