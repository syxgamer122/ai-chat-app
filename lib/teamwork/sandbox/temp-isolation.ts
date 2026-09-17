/**
 * Disposable Scoped Temporary Directory Isolation.
 * Redirects TMP/TEMP per worker execution and guarantees clean teardown.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class TempIsolationManager {
  private static readonly activeTempDirs = new Set<string>();

  /**
   * Creates a dedicated, isolated temporary directory within `.teamwork/temp/<workerId>_<nonce>`.
   */
  public static async createScopedTempDir(
    workspaceRoot: string,
    workerId: string = 'worker'
  ): Promise<string> {
    const nonce = crypto.randomBytes(6).toString('hex');
    const safeWorkerId = workerId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const tempDir = path.join(path.resolve(workspaceRoot), '.teamwork', 'temp', `${safeWorkerId}_${nonce}`);

    await fsp.mkdir(tempDir, { recursive: true });
    this.activeTempDirs.add(tempDir);
    return tempDir;
  }

  /**
   * Safely deletes an isolated temporary directory and removes it from active registry.
   */
  public static async cleanupTempDir(tempDir: string): Promise<void> {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Graceful error ignore on temp cleanup
    } finally {
      this.activeTempDirs.delete(tempDir);
    }
  }

  /**
   * Emergency teardown: recursively removes all tracked temporary directories.
   */
  public static async cleanupAll(): Promise<void> {
    const dirs = Array.from(this.activeTempDirs);
    await Promise.all(
      dirs.map(async (dir) => {
        try {
          await fsp.rm(dir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      })
    );
    this.activeTempDirs.clear();
  }

  /**
   * Returns list of currently active scoped temp directories.
   */
  public static getActiveTempDirs(): string[] {
    return Array.from(this.activeTempDirs);
  }
}
