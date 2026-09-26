/**
 * tests/os-sandbox-dispatcher.test.ts
 *
 * Kiểm tra OS-Level Isolation Sandbox Engine (Sprint 6.2).
 * Kiểm tra việc wrap command, cấu hình network deny, và phân phối đa nền tảng.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { LinuxBubblewrapBackend } from '../lib/os-sandbox/linux-bubblewrap';
import { MacosSeatbeltBackend } from '../lib/os-sandbox/macos-seatbelt';
import { WindowsJobObjectBackend } from '../lib/os-sandbox/windows-job-object';
import { OsSandboxDispatcher } from '../lib/os-sandbox/sandbox-dispatcher';

describe('=== RUNNING OS-LEVEL SANDBOX DISPATCHER TESTS (PHASE 6 SPRINT 6.2) ===', () => {
  it('1. LinuxBubblewrapBackend bọc cờ cách ly network và thư mục', () => {
    const backend = new LinuxBubblewrapBackend();
    const config = {
      workspaceRoot: '/home/user/project',
      allowNetwork: false,
    };

    const wrapped = backend.wrapCommand('git', ['status'], config);
    assert.equal(wrapped.bin, 'bwrap');
    assert.ok(wrapped.args.includes('--unshare-all'));
    assert.ok(wrapped.args.includes('--unshare-net'), 'Phải có cờ --unshare-net khi allowNetwork = false');
    assert.ok(wrapped.args.includes('/home/user/project'));
    assert.equal(wrapped.sandboxedBy, 'bwrap');
  });

  it('2. MacosSeatbeltBackend tạo profile Scheme chuẩn xác', () => {
    const backend = new MacosSeatbeltBackend();
    const config = {
      workspaceRoot: '/Users/vyen/app',
      allowNetwork: false,
    };

    const profile = backend.generateProfile(config);
    assert.ok(profile.includes('(deny default)'));
    assert.ok(profile.includes('(deny network*)'));
    assert.ok(profile.includes('/Users/vyen/app'));

    const wrapped = backend.wrapCommand('node', ['index.js'], config);
    assert.equal(wrapped.bin, '/usr/bin/sandbox-exec');
    assert.equal(wrapped.sandboxedBy, 'seatbelt');
  });

  it('3. WindowsJobObjectBackend khởi tạo wrapper an toàn', () => {
    const backend = new WindowsJobObjectBackend();
    const config = {
      workspaceRoot: 'C:\\Users\\dev\\project',
      memoryLimitMb: 512,
    };

    const wrapped = backend.wrapCommand('npm.cmd', ['test'], config);
    assert.equal(wrapped.sandboxedBy, 'job_object');
    assert.equal(wrapped.bin, 'powershell.exe');
    assert.ok(wrapped.args.includes('-NoProfile'));
  });

  it('4. OsSandboxDispatcher tự động nhận diện và phân phối lệnh', () => {
    const dispatcher = new OsSandboxDispatcher();
    const config = {
      workspaceRoot: process.cwd(),
      allowNetwork: false,
    };

    const result = dispatcher.dispatchCommand('git', ['log', '-n', '1'], config);
    assert.ok(['bwrap', 'job_object', 'seatbelt', 'app_jail'].includes(result.sandboxedBy));
    assert.ok(result.args.length > 0);
  });
});
