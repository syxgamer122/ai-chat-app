/**
 * Git Worktree Manager for Teamwork Multi-Agent Runtime Engine.
 * Reverse-engineered and adapted from stablyai/orca's core parallel worktree architecture.
 *
 * Provides complete filesystem and git index isolation for parallel agents/workers:
 * 1. Each worker operates in an ephemeral worktree under `.teamwork/worktrees/<worker-id>`.
 * 2. Parallel workers can compile, modify, and test code without mutual interference or git lock contention.
 * 3. Atomic merges: Passing milestone branches are cleanly merged into the primary branch.
 * 4. Zero-residual cleanup: Failed or aborted worktrees are cleanly pruned without dirtying the user's workspace.
 */

import child_process from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WorktreeContext, WorktreeInfo } from './types';

export interface WorktreeManagerOptions {
  workspaceRoot: string;
  baseWorktreeDir?: string; // Default: path.join(workspaceRoot, '.teamwork', 'worktrees')
  branchPrefix?: string; // Default: 'teamwork/wt'
}

export interface WorktreeMergeResult {
  success: boolean;
  mergedCommit?: string;
  error?: string;
}

export class GitWorktreeManager {
  public readonly workspaceRoot: string;
  public readonly baseWorktreeDir: string;
  public readonly branchPrefix: string;
  private readonly activeWorktrees = new Map<string, WorktreeContext>();

  constructor(options: WorktreeManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.baseWorktreeDir = options.baseWorktreeDir
      ? path.resolve(options.baseWorktreeDir)
      : path.join(this.workspaceRoot, '.teamwork', 'worktrees');
    this.branchPrefix = options.branchPrefix || 'teamwork/wt';
  }

  /**
   * Helper to execute git commands synchronously with error and timeout handling.
   */
  private execGit(args: string[], cwd: string = this.workspaceRoot): { code: number; stdout: string; stderr: string } {
    try {
      const res = child_process.spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true,
      });

      return {
        code: res.status ?? (res.error ? 1 : 0),
        stdout: res.stdout || '',
        stderr: res.stderr || (res.error ? res.error.message : ''),
      };
    } catch (err) {
      return {
        code: 1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Checks if the workspaceRoot is inside a valid git repository.
   */
  public isGitRepo(): boolean {
    const res = this.execGit(['rev-parse', '--is-inside-work-tree']);
    return res.code === 0 && res.stdout.trim() === 'true';
  }

  /**
   * Resolves the current HEAD commit hash.
   */
  public getCurrentHead(cwd: string = this.workspaceRoot): string {
    const res = this.execGit(['rev-parse', 'HEAD'], cwd);
    if (res.code !== 0) {
      return 'HEAD';
    }
    return res.stdout.trim();
  }

  /**
   * Resolves the on-disk path of a worker's worktree.
   * Single source of truth: create/remove MUST agree, otherwise cleanup silently targets
   * the wrong directory and leaves stale folders behind that break the next run.
   */
  private resolveWorktreePath(workerId: string): string {
    const cleanWorkerId = workerId.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    return path.join(this.baseWorktreeDir, cleanWorkerId);
  }

  /**
   * Creates a dedicated, isolated Git worktree for an agent or milestone worker.
   * Format: `.teamwork/worktrees/<worker-id>`
   * Branch: `<branchPrefix>-<worker-id>-<timestamp>`
   */
  public async createWorktree(
    workerId: string,
    options?: { baseCommit?: string; branchName?: string }
  ): Promise<WorktreeContext> {
    const cleanWorkerId = workerId.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const timestamp = Date.now();
    const branchName = options?.branchName || `${this.branchPrefix}-${cleanWorkerId}-${timestamp}`;
    const worktreePath = this.resolveWorktreePath(workerId);
    const baseCommit = options?.baseCommit || this.getCurrentHead();

    // Ensure base directory exists
    await fsp.mkdir(this.baseWorktreeDir, { recursive: true });

    // If an existing worktree is present at that path, remove it first
    if (fs.existsSync(worktreePath)) {
      await this.removeWorktree(workerId, { force: true });
    }

    // A stale directory can survive `git worktree remove` when it is no longer registered
    // with git (interrupted run, concurrent `worktree prune`, manual deletion of metadata).
    // `git worktree add` refuses to run while the path exists, so clear it explicitly and
    // fail loudly if it cannot be cleared instead of producing a confusing "already exists".
    if (fs.existsSync(worktreePath)) {
      try {
        await fsp.rm(worktreePath, { recursive: true, force: true });
      } catch (err) {
        throw new Error(
          `Failed to create git worktree for worker "${workerId}": stale directory "${worktreePath}" could not be removed (${String(
            err
          )}).`
        );
      }
    }

    // Drop any dangling git metadata before re-adding.
    this.execGit(['worktree', 'prune']);

    // Git worktree add -b <branchName> <worktreePath> <baseCommit>
    const addRes = this.execGit(['worktree', 'add', '-b', branchName, worktreePath, baseCommit]);
    if (addRes.code !== 0) {
      // If branch already existed, attempt fallback without -b
      const retryRes = this.execGit(['worktree', 'add', worktreePath, baseCommit]);
      if (retryRes.code !== 0) {
        throw new Error(
          `Failed to create git worktree for worker "${workerId}": ${addRes.stderr || retryRes.stderr}`
        );
      }
    }

    const context: WorktreeContext = {
      workerId,
      worktreePath,
      branchName,
      baseCommit,
      createdAt: timestamp,
    };

    this.activeWorktrees.set(workerId, context);
    return context;
  }

  /**
   * Retrieves active worktree context for a worker.
   */
  public getWorktree(workerId: string): WorktreeContext | undefined {
    return this.activeWorktrees.get(workerId);
  }

  /**
   * Lists all git worktrees known to git via `git worktree list --porcelain`.
   */
  public async listWorktrees(): Promise<WorktreeInfo[]> {
    const res = this.execGit(['worktree', 'list', '--porcelain']);
    if (res.code !== 0) {
      return [];
    }

    const list: WorktreeInfo[] = [];
    const entries = res.stdout.split(/\r?\n\r?\n/);

    for (const entry of entries) {
      if (!entry.trim()) continue;
      const lines = entry.split(/\r?\n/);
      let worktreePath = '';
      let head = '';
      let branch = '';
      let prunable = false;

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktreePath = line.slice(9).trim();
        } else if (line.startsWith('HEAD ')) {
          head = line.slice(5).trim();
        } else if (line.startsWith('branch ')) {
          branch = line.slice(7).trim();
        } else if (line === 'prunable') {
          prunable = true;
        }
      }

      if (worktreePath) {
        list.push({ path: worktreePath, head, branch, prunable });
      }
    }

    return list;
  }

  /**
   * Commits all changes in the worker's worktree to its dedicated branch.
   */
  public commitWorktreeChanges(workerId: string, message: string): { success: boolean; commitHash?: string; error?: string } {
    const context = this.activeWorktrees.get(workerId);
    if (!context) {
      return { success: false, error: `No active worktree found for worker "${workerId}".` };
    }

    // Add all files
    const addRes = this.execGit(['add', '-A'], context.worktreePath);
    if (addRes.code !== 0) {
      return { success: false, error: `git add failed in worktree: ${addRes.stderr}` };
    }

    // Check if anything changed
    const statusRes = this.execGit(['status', '--porcelain'], context.worktreePath);
    if (!statusRes.stdout.trim()) {
      return { success: true, commitHash: this.getCurrentHead(context.worktreePath) };
    }

    // Commit changes
    const commitRes = this.execGit(['commit', '-m', message], context.worktreePath);
    if (commitRes.code !== 0) {
      return { success: false, error: `git commit failed in worktree: ${commitRes.stderr}` };
    }

    const commitHash = this.getCurrentHead(context.worktreePath);
    return { success: true, commitHash };
  }

  /**
   * Merges the passing worker's branch into the target branch or workspace.
   */
  public async mergeWorktree(
    workerId: string,
    options?: { targetBranch?: string; commitMessage?: string; autoCommit?: boolean }
  ): Promise<WorktreeMergeResult> {
    const context = this.activeWorktrees.get(workerId);
    if (!context) {
      return { success: false, error: `No active worktree found for worker "${workerId}".` };
    }

    // 1. Auto-commit any remaining uncommitted changes in the worktree
    if (options?.autoCommit !== false) {
      const commitMsg = options?.commitMessage || `teamwork: milestone changes for ${workerId}`;
      const commitRes = this.commitWorktreeChanges(workerId, commitMsg);
      if (!commitRes.success) {
        return { success: false, error: commitRes.error };
      }
    }

    // 2. Fetch diff between baseCommit and current worktree branch
    const diffRes = this.execGit(
      ['diff', `${context.baseCommit}..${context.branchName}`],
      this.workspaceRoot
    );

    if (diffRes.code !== 0) {
      return { success: false, error: `Failed to diff worktree branch: ${diffRes.stderr}` };
    }

    // If there is no diff, it's a clean no-op
    if (!diffRes.stdout.trim()) {
      return { success: true, mergedCommit: context.baseCommit };
    }

    // 3. Apply changes cleanly to target or merge branch
    const mergeRes = this.execGit(['merge', '--no-ff', '-m', `Merge ${context.branchName} into main`, context.branchName], this.workspaceRoot);
    if (mergeRes.code !== 0) {
      // If fast-forward or direct merge has collision, abort
      this.execGit(['merge', '--abort'], this.workspaceRoot);
      return {
        success: false,
        error: `Merge conflict or collision while integrating worktree for "${workerId}": ${mergeRes.stderr}`,
      };
    }

    const mergedCommit = this.getCurrentHead();
    return { success: true, mergedCommit };
  }

  /**
   * Removes a worktree and deletes its ephemeral branch.
   */
  public async removeWorktree(
    workerId: string,
    options?: { force?: boolean; deleteBranch?: boolean }
  ): Promise<void> {
    const context = this.activeWorktrees.get(workerId);
    // Use the same path derivation as createWorktree so cleanup always targets the right dir.
    const worktreePath = context ? context.worktreePath : this.resolveWorktreePath(workerId);
    const branchName = context?.branchName;

    // Run git worktree remove
    const forceFlag = options?.force !== false ? ['--force'] : [];
    this.execGit(['worktree', 'remove', ...forceFlag, worktreePath]);

    // Prune worktree metadata
    this.execGit(['worktree', 'prune']);

    // Fallback: if folder still physically exists, delete it
    try {
      if (fs.existsSync(worktreePath)) {
        await fsp.rm(worktreePath, { recursive: true, force: true });
      }
    } catch {
      // Ignore physical removal error if already locked/pruned
    }

    // Delete ephemeral branch if requested
    if (options?.deleteBranch !== false && branchName) {
      this.execGit(['branch', '-D', branchName]);
    }

    this.activeWorktrees.delete(workerId);
  }

  /**
   * Cleans up all managed worktrees and ephemeral branches for this engine session.
   */
  public async cleanupAll(): Promise<void> {
    const workerIds = Array.from(this.activeWorktrees.keys());
    for (const workerId of workerIds) {
      try {
        await this.removeWorktree(workerId, { force: true, deleteBranch: true });
      } catch {
        // Best effort cleanup
      }
    }

    // Prune stale worktrees
    this.execGit(['worktree', 'prune']);
  }
}
