import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  matchesGlob,
  PermissionBroker,
  ProcessTreeSupervisor,
} from '../lib/teamwork/permission-broker';

describe('PermissionBroker & Capability Policy (OpenMausBot Model)', () => {
  const workspaceRoot = path.resolve(process.cwd());

  describe('matchesGlob', () => {
    it('matches wildcards and directory patterns correctly', () => {
      expect(matchesGlob('lib/teamwork/engine.ts', '**/*')).toBe(true);
      expect(matchesGlob('lib/teamwork/engine.ts', 'lib/**')).toBe(true);
      expect(matchesGlob('lib/teamwork/engine.ts', 'lib/teamwork/*')).toBe(true);
      expect(matchesGlob('lib/teamwork/engine.ts', 'lib/**/*.ts')).toBe(true);
      expect(matchesGlob('lib/teamwork/nested/deep/file.ts', 'lib/**/*.ts')).toBe(true);
      expect(matchesGlob('lib/teamwork/engine.ts', '*.ts')).toBe(false);
      expect(matchesGlob('engine.ts', '*.ts')).toBe(true);
      expect(matchesGlob('tests/engine.test.ts', 'tests/*.test.ts')).toBe(true);
    });
  });

  it('allows writes within registered scope and denies writes outside', async () => {
    const broker = new PermissionBroker({
      workspaceRoot,
      strictMode: true,
    });

    broker.registerScope({
      workerId: 'worker-m1',
      allowedWriteGlobs: ['lib/teamwork/engine.ts', 'tests/teamwork-*.test.ts'],
    });

    const allowed1 = await broker.checkWritePermission('worker-m1', 'lib/teamwork/engine.ts');
    expect(allowed1.granted).toBe(true);

    const allowed2 = await broker.checkWritePermission('worker-m1', 'tests/teamwork-engine.test.ts');
    expect(allowed2.granted).toBe(true);

    // Denied file outside scope
    const denied = await broker.checkWritePermission('worker-m1', 'package.json');
    expect(denied.granted).toBe(false);
    expect(denied.reason).toContain('outside worker "worker-m1" assigned write scope');
  });

  it('strictly denies directory traversal attempts escaping workspaceRoot', async () => {
    const broker = new PermissionBroker({
      workspaceRoot,
    });

    const traversalRes = await broker.checkWritePermission('worker-1', '../outside.txt');
    expect(traversalRes.granted).toBe(false);
    expect(traversalRes.reason).toContain('escapes workspaceRoot boundary');
  });

  it('blocks destructive shell commands regardless of scope', async () => {
    const broker = new PermissionBroker({
      workspaceRoot,
    });

    const dangerous = await broker.checkExecPermission('worker-1', 'rm -rf /');
    expect(dangerous.granted).toBe(false);
    expect(dangerous.reason).toContain('destructive pattern');

    const formatCheck = await broker.checkExecPermission('worker-1', 'format c:');
    expect(formatCheck.granted).toBe(false);
  });

  it('records a comprehensive audit trail of all access decisions', async () => {
    const broker = new PermissionBroker({
      workspaceRoot,
      strictMode: true,
    });

    broker.registerScope({
      workerId: 'audited-worker',
      allowedWriteGlobs: ['lib/foo.ts'],
      allowedCommands: ['npm test'],
    });

    await broker.checkWritePermission('audited-worker', 'lib/foo.ts');
    await broker.checkWritePermission('audited-worker', 'secret.env');
    await broker.checkExecPermission('audited-worker', 'npm test');
    await broker.checkExecPermission('audited-worker', 'rm -rf /');

    const logs = broker.getAuditLogs();
    expect(logs.length).toBe(4);

    expect(logs[0].decision).toBe('allow');
    expect(logs[0].action).toBe('fs_write');

    expect(logs[1].decision).toBe('deny');
    expect(logs[1].action).toBe('fs_write');

    expect(logs[2].decision).toBe('allow');
    expect(logs[2].action).toBe('shell_exec');

    expect(logs[3].decision).toBe('deny');
    expect(logs[3].action).toBe('shell_exec');
  });

  it('supports interactive approval callbacks for scope elevation', async () => {
    let promptInvoked = false;
    const broker = new PermissionBroker({
      workspaceRoot,
      strictMode: true,
      onApprovalRequest: async (req) => {
        promptInvoked = true;
        return req.target === 'special-approved.ts';
      },
    });

    broker.registerScope({
      workerId: 'interactive-worker',
      allowedWriteGlobs: ['lib/normal.ts'],
    });

    const approved = await broker.checkWritePermission('interactive-worker', 'special-approved.ts');
    expect(approved.granted).toBe(true);
    expect(promptInvoked).toBe(true);

    const rejected = await broker.checkWritePermission('interactive-worker', 'other-file.ts');
    expect(rejected.granted).toBe(false);
  });
});

describe('ProcessTreeSupervisor — Managed Execution & Timeout Watchdog', () => {
  it('executes command supervised and captures output', async () => {
    const result = await ProcessTreeSupervisor.executeSupervised('node -e "console.log(\'SUPERVISED_OK\')"', {
      cwd: process.cwd(),
      timeoutMs: 10000,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('SUPERVISED_OK');
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.timedOut).toBeFalsy();
  });

  it('terminates command cleanly upon timeout without hanging', async () => {
    const result = await ProcessTreeSupervisor.executeSupervised(
      'node -e "setTimeout(() => console.log(\'done\'), 10000)"',
      {
        cwd: process.cwd(),
        timeoutMs: 500,
      }
    );

    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain('timed out');
  });
});
