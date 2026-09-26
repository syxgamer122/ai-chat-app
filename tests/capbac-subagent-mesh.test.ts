/**
 * tests/capbac-subagent-mesh.test.ts
 *
 * Kiểm tra CapBAC Subagent Mesh & Virtual Staging OverlayFS (Sprint 6.4).
 * Đảm bảo:
 * 1. Cấp phát Capability Scope bất biến.
 * 2. Ngăn chặn subagent truy cập ngoài phạm vi writePatterns (ví dụ src/**).
 * 3. Thao tác ghi được bẫy vào RAM Virtual Staging OverlayFS không làm biến đổi file trên đĩa thật.
 * 4. Ngăn chặn vượt trần maxToolCalls.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { SubagentMeshCoordinator } from '../core/agent-runtime/subagent-mesh';
import { validateSubagentPermission, createCapabilityScope } from '../core/agent-runtime/capability-context';

describe('=== RUNNING CAPBAC SUBAGENT MESH & VIRTUAL OVERLAYFS TESTS (PHASE 6 SPRINT 6.4) ===', () => {
  it('1. validateSubagentPermission: Cho phép ghi trong writePatterns và từ chối ngoài phạm vi', () => {
    const scope = createCapabilityScope({
      subagentId: 'sub-tester-1',
      parentChatId: 'chat-main',
      allowedTools: ['fs_read', 'fs_write'],
      writePatterns: ['tests/**', 'scratch/**'],
    });

    // Ghi vào tests/ -> Hợp lệ
    const valid = validateSubagentPermission(scope, 'fs_write', { path: 'tests/unit.test.ts' });
    assert.equal(valid.allowed, true);

    // Ghi vào src/core -> Bị từ chối
    const invalid = validateSubagentPermission(scope, 'fs_write', { path: 'src/core/kernel.ts' });
    assert.equal(invalid.allowed, false);
    assert.ok(invalid.reason?.includes('bị cấm ghi vào'));
  });

  it('2. validateSubagentPermission: Chặn tuyệt đối các file hệ thống (.git, .env)', () => {
    const scope = createCapabilityScope({
      subagentId: 'sub-tester-2',
      parentChatId: 'chat-main',
      allowedTools: ['fs_write'],
      writePatterns: ['**'], // Cho phép ghi tất cả ngoại trừ protected
    });

    const envAttempt = validateSubagentPermission(scope, 'fs_write', { path: '.env.local' });
    assert.equal(envAttempt.allowed, false);
    assert.ok(envAttempt.reason?.includes('tệp hệ thống được bảo vệ'));

    const gitAttempt = validateSubagentPermission(scope, 'fs_write', { path: '.git/config' });
    assert.equal(gitAttempt.allowed, false);
  });

  it('3. Virtual Staging OverlayFS: Ghi cô lập trong RAM không chạm đĩa thật', async () => {
    const mesh = new SubagentMeshCoordinator();
    const session = mesh.spawnSubagent({
      subagentId: 'sub-writer',
      parentChatId: 'chat-mesh',
      role: 'Code Generator',
      allowedTools: ['fs_write', 'fs_read'],
      writePatterns: ['scratch/**'],
    });

    // Subagent ghi tệp
    const res = await mesh.executeSubagentTool('sub-writer', 'fs_write', {
      path: 'scratch/generated.ts',
      content: 'export const hello = "world";',
    });

    assert.equal(res.success, true);
    assert.equal((res.result as any)?.stagedInRam, true);

    // Đọc từ OverlayFS
    const stagedContent = await session.overlayFs.readFile('scratch/generated.ts');
    assert.equal(stagedContent, 'export const hello = "world";');

    // Kiểm tra danh sách diff
    const diffs = session.overlayFs.generateConsolidatedDiff();
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].path, 'scratch/generated.ts');
  });

  it('4. CapBAC: Chặn thực thi khi vượt trần maxToolCalls', async () => {
    const mesh = new SubagentMeshCoordinator();
    mesh.spawnSubagent({
      subagentId: 'sub-limited',
      parentChatId: 'chat-mesh',
      role: 'Quick Tester',
      allowedTools: ['fs_read'],
      maxToolCalls: 2,
    });

    // Lượt 1: Thành công
    const r1 = await mesh.executeSubagentTool('sub-limited', 'fs_read', { path: 'file1.txt' });
    assert.equal(r1.success, true);

    // Lượt 2: Thành công
    const r2 = await mesh.executeSubagentTool('sub-limited', 'fs_read', { path: 'file2.txt' });
    assert.equal(r2.success, true);

    // Lượt 3: Vượt quá giới hạn
    const r3 = await mesh.executeSubagentTool('sub-limited', 'fs_read', { path: 'file3.txt' });
    assert.equal(r3.success, false);
    assert.ok(r3.error?.includes('đã vượt quá hạn ngạch'));
  });
});
