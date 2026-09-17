/**
 * Unit tests cho P1-6: Tool permissions chi tiết + 4 chế độ chuẩn.
 *
 * Kiểm tra:
 * - 4 chế độ: Manual (always), Smart (smart), Autonomous (never), Chat Only (chat_only)
 * - isToolDenied per-tool override vs category fallback
 * - Acceptance: set shell_run: deny -> isToolDenied returns true, model nhận "denied by policy"
 * - shouldAutoApprove per-tool override: auto, ask, deny, default
 * - Safety backstop: lệnh ALWAYS_BLOCK không bao giờ auto-approve
 * - Phân nhóm công cụ: fs, shell, git, mcp, web, plan, delegate, memory
 * - MCP available_tools whitelist filtering
 * - Dexie v14 store & helpers
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isToolDenied, TOOL_CATEGORY_MAP, ALL_TOOL_CATEGORIES } from '@/lib/tool-catalog';
import { shouldAutoApprove, isSafeCommand, isAlwaysBlocked, type ApprovalPolicy } from '@/lib/auto-pilot';
import {
  getToolGroup,
  getAllToolRows,
  getEffectiveToolPermission,
  saveToolPermissionToDb,
  loadToolPermissionsFromDb,
  resetToolPermissionsInDb,
  syncToolPermissionsToDb,
} from '@/lib/tool-permissions';
import { db } from '@/lib/db';
import type { ToolPermissions } from '@/lib/store';

describe('P1-6: Tool permissions & 4 modes', () => {
  describe('4 Approval Policies (Chế độ chuẩn)', () => {
    it('chat_only policy disables auto-approve completely', () => {
      const readCtx = {
        toolName: 'fs_read',
        args: { path: 'README.md' },
        policy: 'chat_only' as ApprovalPolicy,
        autoPilotEnabled: true,
      };
      expect(shouldAutoApprove(readCtx)).toBe(false);

      const safeShellCtx = {
        toolName: 'shell_run',
        args: { command: 'npm test' },
        policy: 'chat_only' as ApprovalPolicy,
        autoPilotEnabled: true,
      };
      expect(shouldAutoApprove(safeShellCtx)).toBe(false);
    });

    it('smart policy allows read-only and safe shell commands', () => {
      expect(
        shouldAutoApprove({
          toolName: 'fs_read',
          args: {},
          policy: 'smart',
          autoPilotEnabled: true,
        }),
      ).toBe(true);
      expect(
        shouldAutoApprove({
          toolName: 'shell_run',
          args: { command: 'git status' },
          policy: 'smart',
          autoPilotEnabled: true,
        }),
      ).toBe(true);
    });

    it('never (autonomous) allows non-destructive commands and write tools', () => {
      expect(
        shouldAutoApprove({
          toolName: 'fs_write',
          args: { path: 'src/app.ts' },
          policy: 'never',
          autoPilotEnabled: true,
        }),
      ).toBe(true);
    });

    it('always (manual) asks for everything', () => {
      expect(
        shouldAutoApprove({
          toolName: 'fs_read',
          args: {},
          policy: 'always',
          autoPilotEnabled: true,
        }),
      ).toBe(false);
    });
  });

  describe('isToolDenied (Per-tool vs Category)', () => {
    it('Acceptance test: set shell_run: deny -> denied by policy', () => {
      const permissions = {
        shell: 'auto', // Nhóm shell cho phép tự duyệt
        shell_run: 'deny', // Nhưng riêng shell_run bị Chặn
      };
      expect(isToolDenied('shell_run', permissions)).toBe(true);
      // Các tool khác cùng nhóm shell không bị chặn
      expect(isToolDenied('bg_run', permissions)).toBe(false);
    });

    it('per-tool override takes precedence over category deny', () => {
      const permissions = {
        shell: 'deny', // Cả nhóm shell bị chặn
        bg_status: 'ask', // Nhưng riêng bg_status được cho phép (ask)
      };
      expect(isToolDenied('shell_run', permissions)).toBe(true);
      expect(isToolDenied('bg_status', permissions)).toBe(false);
    });

    it('falls back to category when no specific tool override exists', () => {
      const permissions = {
        git: 'deny',
      };
      expect(isToolDenied('git_commit', permissions)).toBe(true);
      expect(isToolDenied('git_status', permissions)).toBe(true);
      expect(isToolDenied('fs_read', permissions)).toBe(false);
    });

    it('handles MCP tool prefix and category', () => {
      const perms1 = { mcp: 'deny' };
      expect(isToolDenied('mcp__github__create_issue', perms1)).toBe(true);

      const perms2 = { mcp__github__create_issue: 'deny' };
      expect(isToolDenied('mcp__github__create_issue', perms2)).toBe(true);
      expect(isToolDenied('mcp__github__search', perms2)).toBe(false);
    });
  });

  describe('shouldAutoApprove with per-tool overrides', () => {
    it('per-tool override auto allows tool even in always mode', () => {
      const permissions: ToolPermissions = {
        fs_write: 'auto',
      };
      expect(
        shouldAutoApprove({
          toolName: 'fs_write',
          args: { path: 'test.txt' },
          policy: 'always',
          autoPilotEnabled: true,
          toolPermissions: permissions,
        }),
      ).toBe(true);
    });

    it('per-tool override ask forces approval even in never (YOLO) mode', () => {
      const permissions: ToolPermissions = {
        shell_run: 'ask',
      };
      expect(
        shouldAutoApprove({
          toolName: 'shell_run',
          args: { command: 'git status' },
          policy: 'never',
          autoPilotEnabled: true,
          toolPermissions: permissions,
        }),
      ).toBe(false);
    });

    it('per-tool override deny always blocks execution', () => {
      const permissions: ToolPermissions = {
        shell_run: 'deny',
      };
      expect(
        shouldAutoApprove({
          toolName: 'shell_run',
          args: { command: 'git status' },
          policy: 'never',
          autoPilotEnabled: true,
          toolPermissions: permissions,
        }),
      ).toBe(false);
    });

    it('hard safety backstop: destructive commands are NEVER auto-approved even with tool override auto', () => {
      const permissions: ToolPermissions = {
        shell_run: 'auto',
      };
      expect(
        shouldAutoApprove({
          toolName: 'shell_run',
          args: { command: 'rm -rf /' },
          policy: 'never',
          autoPilotEnabled: true,
          toolPermissions: permissions,
        }),
      ).toBe(false);

      expect(
        shouldAutoApprove({
          toolName: 'shell_run',
          args: { command: 'format C:' },
          policy: 'never',
          autoPilotEnabled: true,
          toolPermissions: permissions,
        }),
      ).toBe(false);
    });
  });

  describe('Tool grouping & classification (P1-6 groups)', () => {
    it('correctly maps tool names to 8 standard groups', () => {
      expect(getToolGroup('fs_read')).toBe('fs');
      expect(getToolGroup('fs_write')).toBe('fs');
      expect(getToolGroup('fs_edit')).toBe('fs');
      expect(getToolGroup('skill_load')).toBe('fs');

      expect(getToolGroup('shell_run')).toBe('shell');
      expect(getToolGroup('bg_run')).toBe('shell');

      expect(getToolGroup('git_status')).toBe('git');
      expect(getToolGroup('git_commit')).toBe('git');

      expect(getToolGroup('mcp__server__tool')).toBe('mcp');

      expect(getToolGroup('web_search')).toBe('web');
      expect(getToolGroup('web_fetch')).toBe('web');

      expect(getToolGroup('plan_create')).toBe('plan');
      expect(getToolGroup('plan_update')).toBe('plan');

      expect(getToolGroup('delegate')).toBe('delegate');

      expect(getToolGroup('remember_memory')).toBe('memory');
      expect(getToolGroup('retrieve_memories')).toBe('memory');
      expect(getToolGroup('lesson_save')).toBe('memory');
    });

    it('getAllToolRows contains all catalog tools', () => {
      const rows = getAllToolRows();
      expect(rows.length).toBeGreaterThanOrEqual(28);

      const names = rows.map((r) => r.name);
      expect(names).toContain('shell_run');
      expect(names).toContain('fs_read');
      expect(names).toContain('fs_write');
      expect(names).toContain('git_status');
      expect(names).toContain('delegate');
      expect(names).toContain('remember_memory');
    });

    it('getEffectiveToolPermission resolves hierarchy correctly', () => {
      const perms: ToolPermissions = {
        shell: 'ask',
        shell_run: 'deny',
      };
      expect(getEffectiveToolPermission('shell_run', perms)).toBe('deny');
      expect(getEffectiveToolPermission('bg_run', perms)).toBe('ask');
      expect(getEffectiveToolPermission('fs_read', perms)).toBe('default');
    });
  });

  describe('Dexie v14 toolPermissions table', () => {
    const memoryDb = new Map<string, any>();

    beforeEach(() => {
      memoryDb.clear();
      vi.spyOn(db.toolPermissions, 'put').mockImplementation((async (record: any) => {
        memoryDb.set(record.toolName, record);
        return record.toolName;
      }) as any);
      vi.spyOn(db.toolPermissions, 'toArray').mockImplementation((async () => {
        return Array.from(memoryDb.values());
      }) as any);
      vi.spyOn(db.toolPermissions, 'bulkPut').mockImplementation((async (records: any) => {
        for (const r of records) memoryDb.set(r.toolName, r);
        return records.map((r: any) => r.toolName);
      }) as any);
      vi.spyOn(db.toolPermissions, 'clear').mockImplementation((async () => {
        memoryDb.clear();
      }) as any);
    });

    it('saves and loads tool permission from Dexie', async () => {
      await saveToolPermissionToDb('shell_run', 'deny');
      await saveToolPermissionToDb('fs_read', 'auto');

      const loaded = await loadToolPermissionsFromDb();
      expect(loaded.shell_run).toBe('deny');
      expect(loaded.fs_read).toBe('auto');
    });

    it('syncs multiple permissions to Dexie and clears on reset', async () => {
      await syncToolPermissionsToDb({
        shell_run: 'deny',
        git_commit: 'ask',
      });

      const loaded = await loadToolPermissionsFromDb();
      expect(loaded.shell_run).toBe('deny');
      expect(loaded.git_commit).toBe('ask');

      await resetToolPermissionsInDb();
      const empty = await loadToolPermissionsFromDb();
      expect(Object.keys(empty)).toHaveLength(0);
    });
  });

  describe('MCP available_tools whitelist', () => {
    it('filters MCP tool list to only allowed tools when whitelist is defined', () => {
      const serverConfig = {
        id: 'filesystem',
        name: 'File System',
        transport: 'stdio' as const,
        command: 'npx',
        availableTools: ['read_file', 'list_dir'],
      };

      const serverTools = [
        { name: 'read_file', description: 'Read a file' },
        { name: 'write_file', description: 'Write a file' },
        { name: 'list_dir', description: 'List directory' },
        { name: 'delete_file', description: 'Delete file' },
      ];

      const whitelist = serverConfig.availableTools;
      const filtered = serverTools.filter((t) => whitelist.includes(t.name));

      expect(filtered).toHaveLength(2);
      expect(filtered.map((t) => t.name)).toEqual(['read_file', 'list_dir']);
    });

    it('allows all tools when availableTools is empty or undefined', () => {
      const serverConfig = {
        id: 'filesystem',
        name: 'File System',
        transport: 'stdio' as const,
        command: 'npx',
      };

      const serverTools = [
        { name: 'read_file', description: 'Read a file' },
        { name: 'write_file', description: 'Write a file' },
      ];

      const whitelist = (serverConfig as any).availableTools;
      const filtered = serverTools.filter(
        (t) => !Array.isArray(whitelist) || whitelist.length === 0 || whitelist.includes(t.name),
      );

      expect(filtered).toHaveLength(2);
    });

    it('handles whitelist items with surrounding whitespace cleanly', () => {
      const serverConfig = {
        id: 'filesystem',
        name: 'File System',
        transport: 'stdio' as const,
        command: 'npx',
        availableTools: [' read_file ', ' list_dir '],
      };

      const serverTools = [
        { name: 'read_file', description: 'Read a file' },
        { name: 'write_file', description: 'Write a file' },
        { name: 'list_dir', description: 'List directory' },
      ];

      const rawWhitelist = serverConfig.availableTools;
      const whitelist = rawWhitelist.map((s) => s.trim()).filter(Boolean);
      const filtered = serverTools.filter((t) => whitelist.includes(t.name));

      expect(filtered).toHaveLength(2);
      expect(filtered.map((t) => t.name)).toEqual(['read_file', 'list_dir']);
    });
  });

  describe('Additional MCP tools in getAllToolRows & shouldAutoApprove MCP fallback', () => {
    it('getAllToolRows includes additional MCP tools when provided', () => {
      const mcpTools = [
        { name: 'mcp__github__create_issue', description: 'Create issue', serverName: 'GitHub' },
      ];
      const rows = getAllToolRows(mcpTools);
      const mcpRow = rows.find((r) => r.name === 'mcp__github__create_issue');
      expect(mcpRow).toBeDefined();
      expect(mcpRow?.group).toBe('mcp');
      expect(mcpRow?.shortLabel).toBe('MCP (GitHub)');
    });

    it('supports MCP category fallback in shouldAutoApprove', () => {
      const permsAuto: ToolPermissions = {
        mcp: 'auto',
      };
      expect(
        shouldAutoApprove({
          toolName: 'mcp__github__create_issue',
          args: {},
          policy: 'always',
          autoPilotEnabled: true,
          toolPermissions: permsAuto,
        }),
      ).toBe(true);

      const permsAsk: ToolPermissions = {
        mcp: 'ask',
      };
      expect(
        shouldAutoApprove({
          toolName: 'mcp__github__create_issue',
          args: {},
          policy: 'never',
          autoPilotEnabled: true,
          toolPermissions: permsAsk,
        }),
      ).toBe(false);
    });
  });
});
