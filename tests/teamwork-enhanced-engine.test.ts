import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCliArgs, runCli } from '../lib/teamwork/cli';
import { TeamworkEngine } from '../lib/teamwork/engine';
import { PermissionBroker } from '../lib/teamwork/permission-broker';
import { RepoDependencyGraph } from '../lib/teamwork/repo-graph';
import { GitWorktreeManager } from '../lib/teamwork/worktree';

describe('Enhanced Teamwork Harness — End-to-End Orca & OpenMausBot Integration', () => {
  const workspaceRoot = path.resolve(process.cwd());

  // Test quyền ghi chạm đĩa thật — dùng workspace tạm để không rò file vào cây nguồn
  const scratchDirs: string[] = [];
  afterAll(() => {
    for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('auto-enriches verification commands when enableRepoGraph is active', async () => {
    const repoGraph = new RepoDependencyGraph({ workspaceRoot });
    const engine = new TeamworkEngine({
      workspaceRoot,
      enableRepoGraph: true,
      repoGraph,
      confirmPrompt: async () => true,
    });

    const summary = await engine.run(
      {
        purpose: 'Verify repo graph enrichment for file-lock',
        files: ['lib/teamwork/file-lock.ts'],
        acceptanceCriteria: [
          {
            description: 'Run tests for file-lock',
            verifyCommand: 'npm test', // Generic command that should be auto-optimized
          },
        ],
        milestones: [
          {
            title: 'Verify file-lock module',
            ownedFiles: ['lib/teamwork/file-lock.ts'],
            verifyCommand: 'npm test',
          },
        ],
      },
      { dryRun: true }
    );

    expect(summary.status).toBe('COMPLETED');
    expect(summary.milestones[0].verifyCommand).toMatch(/teamwork-file-lock/);
  });

  it('enforces capability scope permissions during milestone worker execution', async () => {
    // fsWrite ghi thật xuống đĩa — workspace tạm tránh để lại rác trong repo
    const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vyen-perm-scope-'));
    scratchDirs.push(scratchRoot);
    const scopedDummy = 'lib/teamwork/test-dummy.ts';

    const permissionBroker = new PermissionBroker({
      workspaceRoot: scratchRoot,
      strictMode: true,
    });

    const engine = new TeamworkEngine({
      workspaceRoot: scratchRoot,
      permissionBroker,
      confirmPrompt: async () => true,
      workerExecutor: async (milestone, attempt, tools) => {
        // Attempt to write to a forbidden file outside declared scope
        const writeRes = await tools.fsWrite('package.json', '{}', milestone.assignedWorker);
        expect(writeRes.written).toBe(false);
        expect(writeRes.error).toContain('outside worker');

        // Permitted write to declared scope
        const validRes = await tools.fsWrite(scopedDummy, '// ok', milestone.assignedWorker);
        expect(validRes.written).toBe(true);

        return { filesTouched: [scopedDummy] };
      },
    });

    // Provide mock critic that PASSes directly
    (engine as any).critic.verifyMilestone = async () => ({
      verdict: 'PASS',
      command: 'npm test',
      exitCode: 0,
      outputPreview: 'All tests pass',
      issues: [],
      passCriteriaMet: true,
    });

    const summary = await engine.run(
      {
        purpose: 'Security capability isolation test',
        files: [scopedDummy],
        acceptanceCriteria: [
          {
            description: 'Permission enforcement',
            verifyCommand: 'npm test',
          },
        ],
      },
      { userConfirm: true }
    );

    expect(summary.status).toBe('COMPLETED');
    const logs = permissionBroker.getAuditLogs();
    expect(logs.some((l) => l.decision === 'deny' && l.target === 'package.json')).toBe(true);
  });

  it('supports isolated worktree execution when useWorktrees is enabled', async () => {
    const worktreeManager = new GitWorktreeManager({
      workspaceRoot,
      baseWorktreeDir: path.join(workspaceRoot, '.teamwork', 'engine-wt-test'),
      branchPrefix: 'teamwork/eng-wt',
    });

    if (!worktreeManager.isGitRepo()) {
      return; // Skip if environment lacks git
    }

    let executedInWorktree = false;
    let worktreeDirSeen = '';

    const engine = new TeamworkEngine({
      workspaceRoot,
      useWorktrees: true,
      worktreeManager,
      confirmPrompt: async () => true,
      workerExecutor: async (milestone, attempt, tools) => {
        executedInWorktree = tools.workspaceRoot.includes('engine-wt-test');
        worktreeDirSeen = tools.workspaceRoot;
        return { filesTouched: [] };
      },
    });

    // Mock critic PASS
    (engine as any).critic.verifyMilestone = async () => ({
      verdict: 'PASS',
      command: 'npm test',
      exitCode: 0,
      outputPreview: 'Clean pass in worktree',
      issues: [],
      passCriteriaMet: true,
    });

    const summary = await engine.run(
      {
        purpose: 'Isolated worktree milestone execution',
        files: ['lib/teamwork/engine.ts'],
        acceptanceCriteria: [{ description: 'Test worktree', verifyCommand: 'npm test' }],
      },
      { userConfirm: true }
    );

    expect(summary.status).toBe('COMPLETED');
    expect(executedInWorktree).toBe(true);
    expect(worktreeDirSeen).toContain('engine-wt-test');

    // Verify all worktrees were cleaned up
    await worktreeManager.cleanupAll();
  }, 30000);

  it('CLI parses and honors --worktrees and --repo-graph flags', async () => {
    const parsed = parseCliArgs([
      '--goal',
      'Optimize build pipeline',
      '--worktrees',
      '--repo-graph',
      '--auto-approve',
    ]);

    expect(parsed.worktrees).toBe(true);
    expect(parsed.repoGraph).toBe(true);
    expect(parsed.autoApprove).toBe(true);
    expect(parsed.goal).toBe('Optimize build pipeline');

    // Run dry-run via CLI with flags enabled
    const res = await runCli(
      [
        '--goal',
        'Dry run with worktrees and repoGraph',
        '--worktrees',
        '--repo-graph',
        '--dry-run',
        '--auto-approve',
      ],
      { workspaceRoot }
    );

    expect(res.exitCode).toBe(0);
    expect(res.summary?.status).toBe('COMPLETED');
  });
});
