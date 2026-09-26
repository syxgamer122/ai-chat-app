/**
 * core/agent-runtime/capability-context.ts
 *
 * Phân quyền Năng lực Subagent (Capability-Based Access Control - CapBAC).
 * Cấp phát các phạm vi quyền hạn (scopes) mang tính bất biến và có thời hạn,
 * bảo vệ chống rò rỉ hoặc lạm quyền giữa Orchestrator và các Subagents.
 */

import { isProtectedPath } from '../../lib/path-utils';

export interface AgentFileSystemScope {
  readPatterns: string[];    // E.g., ["src/**", "tests/**"]
  writePatterns: string[];   // E.g., ["tests/**"] -> Cấm tuyệt đối đụng vào src/
  deniedPatterns: string[];  // Luôn thừa kế isProtectedPath
}

export interface AgentNetworkScope {
  allowEgress: boolean;
  allowedDomains?: string[]; // Allowlist domain cụ thể khi web_fetch
}

export interface AgentCapabilityScope {
  subagentId: string;
  parentChatId: string;
  allowedTools: ReadonlySet<string>;
  fileSystemScope: AgentFileSystemScope;
  networkScope: AgentNetworkScope;
  maxExecutionTimeMs: number;
  maxToolCalls: number;
  createdAt: number;
}

/**
 * Kiểm tra xem một đường dẫn tương đối có khớp với mẫu glob đơn giản không.
 */
export function matchesSimpleGlob(relPath: string, pattern: string): boolean {
  const normPath = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const normPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');

  if (normPattern === '**' || normPattern === '*') return true;
  if (normPattern.endsWith('/**')) {
    const prefix = normPattern.slice(0, -3);
    return normPath === prefix || normPath.startsWith(prefix + '/');
  }
  return normPath === normPattern;
}

export function createCapabilityScope(
  opts: {
    subagentId: string;
    parentChatId: string;
    allowedTools?: string[];
    readPatterns?: string[];
    writePatterns?: string[];
    allowEgress?: boolean;
    allowedDomains?: string[];
    maxExecutionTimeMs?: number;
    maxToolCalls?: number;
  }
): AgentCapabilityScope {
  return {
    subagentId: opts.subagentId,
    parentChatId: opts.parentChatId,
    allowedTools: new Set(opts.allowedTools || ['fs_read', 'fs_list', 'run_code']),
    fileSystemScope: {
      readPatterns: opts.readPatterns || ['**'],
      writePatterns: opts.writePatterns || ['scratch/**', 'tests/**'],
      deniedPatterns: ['.git/**', 'node_modules/**', '.env*'],
    },
    networkScope: {
      allowEgress: Boolean(opts.allowEgress),
      allowedDomains: opts.allowedDomains || [],
    },
    maxExecutionTimeMs: opts.maxExecutionTimeMs || 60_000,
    maxToolCalls: opts.maxToolCalls || 25,
    createdAt: Date.now(),
  };
}

export function validateSubagentPermission(
  scope: AgentCapabilityScope,
  toolName: string,
  args: Record<string, unknown>
): { allowed: boolean; reason?: string } {
  // 1. Kiểm tra allowlist công cụ
  if (!scope.allowedTools.has(toolName)) {
    return {
      allowed: false,
      reason: `[CapBAC] Subagent '${scope.subagentId}' không có quyền gọi tool '${toolName}'.`,
    };
  }

  // 2. Kiểm tra quyền File System
  const targetPath = typeof args.path === 'string' ? args.path : typeof args.relPath === 'string' ? args.relPath : null;
  if (targetPath) {
    // Luôn từ chối protected fs paths
    if (isProtectedPath(targetPath)) {
      return {
        allowed: false,
        reason: `[CapBAC] Đường dẫn '${targetPath}' là tệp hệ thống được bảo vệ nghiêm ngặt.`,
      };
    }

    // Từ chối denied patterns
    for (const pattern of scope.fileSystemScope.deniedPatterns) {
      if (matchesSimpleGlob(targetPath, pattern)) {
        return {
          allowed: false,
          reason: `[CapBAC] Đường dẫn '${targetPath}' bị từ chối bởi quy tắc deniedPattern '${pattern}'.`,
        };
      }
    }

    // Nếu là thao tác ghi
    if (['fs_write', 'fs_edit', 'code_patch'].includes(toolName)) {
      const isAllowedWrite = scope.fileSystemScope.writePatterns.some((pattern) =>
        matchesSimpleGlob(targetPath, pattern)
      );
      if (!isAllowedWrite) {
        return {
          allowed: false,
          reason: `[CapBAC] Subagent '${scope.subagentId}' bị cấm ghi vào '${targetPath}' (phạm vi cho phép: ${scope.fileSystemScope.writePatterns.join(', ')}).`,
        };
      }
    }

    // Nếu là thao tác đọc
    if (['fs_read', 'fs_list'].includes(toolName)) {
      const isAllowedRead = scope.fileSystemScope.readPatterns.some((pattern) =>
        matchesSimpleGlob(targetPath, pattern)
      );
      if (!isAllowedRead) {
        return {
          allowed: false,
          reason: `[CapBAC] Subagent '${scope.subagentId}' bị cấm đọc '${targetPath}'.`,
        };
      }
    }
  }

  // 3. Kiểm tra quyền Network Egress
  if (['web_search', 'web_fetch'].includes(toolName) && !scope.networkScope.allowEgress) {
    return {
      allowed: false,
      reason: `[CapBAC] Subagent '${scope.subagentId}' không được cấp quyền truy cập mạng (allowEgress = false).`,
    };
  }

  return { allowed: true };
}
