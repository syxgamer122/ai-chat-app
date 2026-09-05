import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWorktreeManager } from '../lib/teamwork/worktree';

describe('GitWorktreeManager — Ephemeral Git Worktrees (Orca Model)', () => {
  const workspaceRoot = path.resolve(process.cwd());
  let manager: GitWorktreeManager;
  const testWorkerId = 'test-worker-wt';

  beforeEach(() => {
    manager = new GitWorktreeManager({
      workspaceRoot,
      baseWorktreeDir: path.join(workspaceRoot, '.teamwork', 'test-worktrees'),
      branchPrefix: 'teamwork/test-wt',
    });
  });

  afterEach(async () => {
    try {
      await manager.removeWorktree(testWorkerId, { force: true, deleteBranch: true });
      await manager.cleanupAll();
    } catch {
      // Best effort cleanup
    }
  });

  it('detects that the workspace is a valid git repository', () => {
    expect(manager.isGitRepo()).toBe(true);
  });

  it('resolves current git HEAD commit hash', () => {
    const head = manager.getCurrentHead();
    expect(typeof head).toBe('string');
    expect(head.length).toBeGreaterThan(0);
    expect(head).not.toBe('HEAD'); // Real commit SHA
  });

  it('lists existing git worktrees from porcelain format', async () => {
    const worktrees = await manager.listWorktrees();
    expect(Array.isArray(worktrees)).toBe(true);
    expect(worktrees.length).toBeGreaterThanOrEqual(1); // Main working copy is at least 1
    const mainWt = worktrees.find((w) => path.resolve(w.path) === workspaceRoot);
    expect(mainWt).toBeDefined();
  });

  it('creates, inspects, and cleans up an isolated worktree', async () => {
    const ctx = await manager.createWorktree(testWorkerId);

    expect(ctx.workerId).toBe(testWorkerId);
    expect(ctx.worktreePath).toContain('test-worker-wt');
    expect(fs.existsSync(ctx.worktreePath)).toBe(true);
    expect(manager.getWorktree(testWorkerId)).toBeDefined();

    // Verify worktree shows in listWorktrees()
    const allWorktrees = await manager.listWorktrees();
    const found = allWorktrees.find((w) => path.resolve(w.path) === path.resolve(ctx.worktreePath));
    expect(found).toBeDefined();

    // Remove worktree
    await manager.removeWorktree(testWorkerId, { force: true, deleteBranch: true });
    expect(fs.existsSync(ctx.worktreePath)).toBe(false);
    expect(manager.getWorktree(testWorkerId)).toBeUndefined();
  }, 30000);

  it('commits changes made inside the isolated worktree', async () => {
    const ctx = await manager.createWorktree(testWorkerId);

    // Write a dummy file inside the worktree
    const testFilePath = path.join(ctx.worktreePath, 'temp-worker-test.txt');
    fs.writeFileSync(testFilePath, 'Isolated worktree test content', 'utf8');

    const commitRes = manager.commitWorktreeChanges(testWorkerId, 'test: commit in worktree');
    expect(commitRes.success).toBe(true);
    expect(typeof commitRes.commitHash).toBe('string');

    // Clean up
    await manager.removeWorktree(testWorkerId, { force: true, deleteBranch: true });
    expect(fs.existsSync(ctx.worktreePath)).toBe(false);
  }, 30000);

  it('handles cleanupAll gracefully', async () => {
    await manager.createWorktree(`${testWorkerId}-1`);
    await manager.cleanupAll();
    expect(manager.getWorktree(`${testWorkerId}-1`)).toBeUndefined();
  }, 30000);
});
