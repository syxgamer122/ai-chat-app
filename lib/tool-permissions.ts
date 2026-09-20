/**
 * Quản lý quyền chi tiết theo từng tool và theo category (P1-6).
 *
 * Lưu trữ đồng thời:
 * - Zustand persist (localStorage 'ai-chat-settings' v2): truy cập đồng bộ tức thì lúc chạy tool
 * - Dexie IndexedDB v14 (`toolPermissions`): lưu trữ bền vững local-first, hỗ trợ query và export
 *
 * Hỗ trợ 4 chế độ:
 * - always: Manual (hỏi tất cả)
 * - smart: Smart (tự duyệt read & safe commands, hỏi ghi/destructive)
 * - never: Autonomous / YOLO (tự duyệt tất cả trừ ALWAYS_BLOCK)
 * - chat_only: Chat Only (vô hiệu toàn bộ tool, kể cả fs_read)
 */

import { db, type StoredToolPermissionRecord } from '@/lib/db';
import type { PermissionOverride, ToolPermissions } from '@/lib/store';
import { TOOL_CATALOG, TOOL_CATEGORY_MAP, type ToolCatalogEntry } from '@/lib/tool-catalog';

export type ToolPermissionGroup =
  | 'fs'
  | 'shell'
  | 'git'
  | 'mcp'
  | 'web'
  | 'plan'
  | 'delegate'
  | 'memory';

export interface ToolGroupMeta {
  key: ToolPermissionGroup;
  label: string;
  description: string;
  icon: string;
}

export const TOOL_PERMISSION_GROUPS: readonly ToolGroupMeta[] = [
  {
    key: 'fs',
    label: 'Tập tin & Thư mục (fs)',
    description: 'Đọc, liệt kê, tìm kiếm, sửa và tạo file trong workspace.',
    icon: 'folder-open',
  },
  {
    key: 'shell',
    label: 'Shell & Tiến trình nền',
    description: 'Chạy lệnh shell máy chủ và quản lý tiến trình nền (bg_*).',
    icon: 'terminal',
  },
  {
    key: 'git',
    label: 'Kiểm soát phiên bản (Git)',
    description: 'Xem trạng thái, log, diff, stage và commit git.',
    icon: 'git-branch',
  },
  {
    key: 'mcp',
    label: 'Model Context Protocol (MCP)',
    description: 'Các công cụ mở rộng từ các MCP server được kết nối.',
    icon: 'server',
  },
  {
    key: 'web',
    label: 'Tìm kiếm & Đọc web',
    description: 'Tìm kiếm web, cào dữ liệu URL và tiện ích thông tin.',
    icon: 'globe',
  },
  {
    key: 'plan',
    label: 'Kế hoạch (Plan)',
    description: 'Tạo và cập nhật subtasks trong kế hoạch công việc.',
    icon: 'list-checks',
  },
  {
    key: 'delegate',
    label: 'Subagent (Delegate)',
    description: 'Giao việc phân nhánh cho subagent chạy độc lập.',
    icon: 'users',
  },
  {
    key: 'memory',
    label: 'Bộ nhớ dài hạn & Ghi nhớ',
    description: 'Ghi nhớ quy tắc dự án và truy xuất kinh nghiệm đã lưu.',
    icon: 'bookmark',
  },
];

/** Map tool name sang 8 nhóm phân quyền chuẩn P1-6. */
export function getToolGroup(toolName: string): ToolPermissionGroup {
  if (toolName.startsWith('mcp__') || toolName === 'mcp' || toolName === 'tools_search' || toolName === 'tools_load') return 'mcp';
  if (toolName === 'run_code') return 'shell';
  const category = TOOL_CATEGORY_MAP[toolName];
  if (category === 'fs_read' || category === 'fs_write') return 'fs';
  if (category === 'shell') return 'shell';
  if (category === 'git') return 'git';
  if (category === 'web') return 'web';
  if (category === 'plan') return 'plan';
  if (category === 'delegate') return 'delegate';
  if (category === 'memory') return 'memory';
  return 'fs';
}

/**
 * Lấy danh sách toàn bộ tool chuẩn hóa kèm nhóm cho bảng phân quyền.
 */
export interface ToolRowItem {
  name: string;
  group: ToolPermissionGroup;
  shortLabel: string;
  description: string;
  kind: 'server' | 'client';
  desktopOnly?: boolean;
}

export interface AdditionalMcpToolItem {
  name: string;
  description: string;
  serverName?: string;
}

export function getAllToolRows(additionalMcpTools: AdditionalMcpToolItem[] = []): ToolRowItem[] {
  const rows: ToolRowItem[] = TOOL_CATALOG.map((entry) => ({
    name: entry.name,
    group: getToolGroup(entry.name),
    shortLabel: entry.shortLabel,
    description: entry.description,
    kind: entry.kind,
    desktopOnly: entry.desktopOnly,
  }));

  // Gộp các tool MCP nếu có
  for (const mcp of additionalMcpTools) {
    if (!rows.some((r) => r.name === mcp.name)) {
      rows.push({
        name: mcp.name,
        group: 'mcp',
        shortLabel: mcp.serverName ? `MCP (${mcp.serverName})` : 'MCP Tool',
        description: mcp.description || 'Tool từ MCP server',
        kind: 'client',
        desktopOnly: true,
      });
    }
  }

  return rows;
}

/**
 * Kiểm tra xem một tool có phải là dynamic MCP tool định dạng `mcp__<server>__<tool>` hay không.
 */
export function isDynamicMcpTool(toolName: string): boolean {
  return typeof toolName === 'string' && /^mcp__[a-zA-Z0-9_.-]+__[a-zA-Z0-9_.-]+$/.test(toolName);
}

/**
 * Rút trích đường dẫn mục tiêu từ args hoặc chuỗi path.
 */
export function extractTargetPath(argsOrPath?: Record<string, unknown> | string): string | undefined {
  if (typeof argsOrPath === 'string') return argsOrPath;
  if (!argsOrPath || typeof argsOrPath !== 'object') return undefined;
  const raw =
    argsOrPath.path ??
    argsOrPath.relPath ??
    argsOrPath.file ??
    argsOrPath.filepath ??
    argsOrPath.file_path ??
    argsOrPath.targetFile;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(argsOrPath.paths) && typeof argsOrPath.paths[0] === 'string') {
    return argsOrPath.paths[0];
  }
  return undefined;
}

/**
 * Kiem tra duong dan co khop glob pattern khong (ho tro *, **, ?).
 * Xu ly chuan xac globstar (khop ca 0 cap thu muc trung gian),
 * chuan hoa dau gach cheo Windows va tien to './'.
 */
export function matchesGlobPattern(filePath: string, globPattern: string): boolean {
  if (!filePath || !globPattern) return false;
  const normPath = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const cleanGlob = globPattern.replace(/\\/g, '/').replace(/^\.\//, '');

  if (cleanGlob === '**' || cleanGlob === '*') return true;

  // 1. Thoát các ký tự đặc biệt của regex trừ * và ?
  let pattern = cleanGlob.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  // 2. Tokenize các glob pattern thành các marker duy nhất bằng replaceAll chuỗi thuần
  pattern = pattern
    .replaceAll('/**/', '§§GLOBSTAR_DIR§§')
    .replace(/\/\*\*$/, '§§GLOBSTAR_TRAILING§§')
    .replaceAll('/**', '§§GLOBSTAR_SLASH§§')
    .replace(/^\*\*\//, '§§GLOBSTAR_LEADING§§')
    .replaceAll('**', '§§GLOBSTAR§§')
    .replaceAll('*', '§§STAR§§')
    .replaceAll('?', '§§QUESTION§§');

  // 3. Thay thế các marker bằng regex tương ứng
  pattern = pattern
    .replaceAll('§§GLOBSTAR_DIR§§', '(?:/|/.+/)')
    .replaceAll('§§GLOBSTAR_TRAILING§§', '(?:/.*)?')
    .replaceAll('§§GLOBSTAR_SLASH§§', '(?:/.*)')
    .replaceAll('§§GLOBSTAR_LEADING§§', '(?:.+/)?')
    .replaceAll('§§GLOBSTAR§§', '.*')
    .replaceAll('§§STAR§§', '[^/]*')
    .replaceAll('§§QUESTION§§', '[^/]');

  try {
    const regex = new RegExp(`^${pattern}$`, 'i');
    return regex.test(normPath);
  } catch {
    return false;
  }
}

/**
 * Lấy quyền hiệu lực cho một tool cụ thể (P3.6 Policy-as-Data):
 * Thứ tự ưu tiên:
 * 1. Path-scoped rule theo tool cụ thể (`toolName:glob` ví dụ: `fs_write:*.ts`)
 * 2. Path-scoped rule chung (`path:glob` hoặc `*:glob`)
 * 3. Tool override cụ thể (`permissions[toolName]`)
 * 4. Path glob pattern trực tiếp trên key (`permissions['*.config.js']`)
 * 5. Dynamic MCP server-level pattern (`permissions['mcp__<server>__*']`)
 * 6. Category override (`permissions[category]`) hoặc `permissions['mcp']`
 * 7. Deny-by-default cho dynamic MCP tool chưa được phê duyệt (`mcp__<server>__<tool>`)
 * 8. 'default'
 */
export function getEffectiveToolPermission(
  toolName: string,
  permissions: ToolPermissions,
  argsOrPath?: Record<string, unknown> | string,
): PermissionOverride {
  const targetPath = extractTargetPath(argsOrPath);

  // 1 & 2: Kiểm tra path-scoped rule nếu có đường dẫn
  if (targetPath) {
    for (const [key, perm] of Object.entries(permissions)) {
      if (!perm || perm === 'default') continue;
      if (key.includes(':')) {
        const colonIdx = key.indexOf(':');
        const ruleTool = key.slice(0, colonIdx);
        const globPattern = key.slice(colonIdx + 1);
        if (
          (ruleTool === toolName || ruleTool === '*' || ruleTool === 'path') &&
          matchesGlobPattern(targetPath, globPattern)
        ) {
          return perm;
        }
      }
    }

    // 4. Pure glob keys (vd: `*.env*`, `src/**`)
    for (const [key, perm] of Object.entries(permissions)) {
      if (!perm || perm === 'default') continue;
      if ((key.includes('*') || key.includes('?')) && !key.startsWith('mcp__')) {
        if (matchesGlobPattern(targetPath, key)) {
          return perm;
        }
      }
    }
  }

  // 3. Tool override cụ thể (permissions[toolName])
  const specific = permissions[toolName];
  if (specific && specific !== 'default') return specific;

  // 5. Dynamic MCP server-level pattern (vd: mcp__github__*)
  if (isDynamicMcpTool(toolName)) {
    const serverMatch = toolName.match(/^mcp__([a-zA-Z0-9_.-]+)__/);
    if (serverMatch) {
      const serverWildcard = `mcp__${serverMatch[1]}__*`;
      if (permissions[serverWildcard] && permissions[serverWildcard] !== 'default') {
        return permissions[serverWildcard]!;
      }
    }
  }

  // 6. Category override
  const category = TOOL_CATEGORY_MAP[toolName];
  if (category && permissions[category] && permissions[category] !== 'default') {
    return permissions[category]!;
  }

  if (
    (toolName.startsWith('mcp__') || toolName === 'tools_search' || toolName === 'tools_load') &&
    permissions['mcp'] &&
    permissions['mcp'] !== 'default'
  ) {
    return permissions['mcp']!;
  }

  if (toolName === 'run_code' && permissions['shell'] && permissions['shell'] !== 'default') {
    return permissions['shell']!;
  }

  // 7. Enforce deny-by-default cho unapproved dynamic MCP tools (mcp__<server>__<tool>)
  if (isDynamicMcpTool(toolName)) {
    return 'deny';
  }

  return 'default';
}

/**
 * Lưu một quyền vào bảng Dexie `toolPermissions`.
 */
export async function saveToolPermissionToDb(
  toolName: string,
  permission: PermissionOverride,
): Promise<void> {
  try {
    await db.toolPermissions.put({
      toolName,
      permission,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.warn(`[tool-permissions] Lưu Dexie thất bại cho ${toolName}:`, err);
  }
}

/**
 * Đọc toàn bộ quyền từ bảng Dexie `toolPermissions`.
 */
export async function loadToolPermissionsFromDb(): Promise<Record<string, PermissionOverride>> {
  try {
    const list = await db.toolPermissions.toArray();
    const map: Record<string, PermissionOverride> = {};
    for (const item of list) {
      if (item.toolName && item.permission) {
        map[item.toolName] = item.permission;
      }
    }
    return map;
  } catch (err) {
    console.warn('[tool-permissions] Đọc Dexie thất bại:', err);
    return {};
  }
}

/**
 * Đồng bộ toàn bộ permissions từ store vào Dexie.
 */
export async function syncToolPermissionsToDb(
  permissions: ToolPermissions,
): Promise<void> {
  try {
    const now = Date.now();
    const records: StoredToolPermissionRecord[] = Object.entries(permissions).map(
      ([toolName, permission]) => ({
        toolName,
        permission,
        updatedAt: now,
      }),
    );
    if (records.length > 0) {
      await db.toolPermissions.bulkPut(records);
    }
  } catch (err) {
    console.warn('[tool-permissions] Đồng bộ sang Dexie thất bại:', err);
  }
}

/**
 * Xóa sạch toàn bộ override trong Dexie và trả về cấu hình mặc định sạch.
 */
export async function resetToolPermissionsInDb(): Promise<void> {
  try {
    await db.toolPermissions.clear();
  } catch (err) {
    console.warn('[tool-permissions] Xóa Dexie thất bại:', err);
  }
}
