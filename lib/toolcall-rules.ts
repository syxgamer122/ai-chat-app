/**
 * Toolcall Rules — Luật kiểm soát hành vi gọi công cụ do người dùng định nghĩa.
 *
 * Cho phép người dùng hoặc dự án đặt các luật cứng:
 * - Chặn thao tác nguy hiểm kèm thông điệp giải thích NGUYÊN VĂN câu chữ của luật.
 * - Yêu cầu xác nhận hoặc tự động cho phép theo pattern đường dẫn / đối số.
 *
 * Thứ tự quyết định quyền thực thi:
 * 1. Danh sách chặn hủy diệt cứng (ALWAYS_BLOCK_PATTERNS)
 * 2. User Toolcall Rules (file này)
 * 3. Chính sách Auto-pilot (always / smart / never)
 * 4. Group overrides
 * 5. Mặc định: hỏi người dùng
 */

import { isAlwaysBlocked } from '@/lib/auto-pilot';

export interface ToolcallRule {
  id: string;
  when: {
    tool?: string;
    group?: string;
    pathGlob?: string;
    argMatches?: string; // regex kiểm tra arguments
  };
  action: 'deny' | 'ask' | 'allow';
  message: string; // Thông điệp hiện nguyên văn cho model + user khi luật được kích hoạt
  scope: 'workspace' | 'global';
}

export type EvaluationVerdict =
  | { decision: 'deny'; reason: string; ruleId?: string }
  | { decision: 'ask'; reason: string; ruleId?: string }
  | { decision: 'allow'; reason?: string; ruleId?: string }
  | { decision: 'pass_through' }; // Không khớp rule nào, chuyển cho auto-pilot xử lý tiếp

import { TOOL_CATEGORY_MAP } from '@/lib/store';

/**
 * Kiểm tra xem một đối số hoặc đường dẫn có khớp rule không.
 */
function matchesRule(
  rule: ToolcallRule,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const { tool, group, pathGlob, argMatches } = rule.when;

  // 1. Khớp tool name nếu có khai báo
  if (tool && tool !== '*' && tool !== toolName) {
    return false;
  }

  // 1.1 Khớp group nếu có khai báo
  if (group && group !== '*') {
    const toolGroup = (TOOL_CATEGORY_MAP as Record<string, string>)[toolName];
    if (toolGroup !== group) return false;
  }

  // 2. Khớp pathGlob nếu có khai báo trong args (path hoặc file hoặc targetFile)
  if (pathGlob) {
    const rawPath = String(args.path || args.file || args.targetFile || '');
    if (!rawPath) return false;

    // Chuẩn hóa dấu phân cách thư mục sang '/' để khớp nhất quán trên Windows và POSIX
    const normalizedPath = rawPath.replace(/\\/g, '/');
    const cleanGlob = pathGlob.replace(/\\/g, '/');

    const globRegex = new RegExp(
      '^' + cleanGlob.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
      'i',
    );
    if (!globRegex.test(normalizedPath) && !globRegex.test(rawPath)) return false;
  }

  // 3. Khớp argMatches (regex trên JSON chuỗi hóa của args)
  if (argMatches) {
    const rawArgs = JSON.stringify(args);
    const regex = new RegExp(argMatches, 'i');
    if (!regex.test(rawArgs)) return false;
  }

  return true;
}

/**
 * Đánh giá một lời gọi công cụ qua tầng luật của người dùng.
 */
export function evaluateToolcallRules(
  toolName: string,
  args: Record<string, unknown>,
  userRules: ToolcallRule[] = [],
): EvaluationVerdict {
  // 1. Destructive blocklist cứng (mức ưu tiên tối thượng)
  if (toolName === 'shell_run') {
    const command = String(args.command ?? '');
    if (isAlwaysBlocked(command)) {
      return {
        decision: 'deny',
        reason: 'Lệnh bị chặn vĩnh viễn bởi bộ lọc hủy diệt hệ thống (Always-Block Safety Policy).',
      };
    }
  }

  // 2. User Toolcall Rules
  for (const rule of userRules) {
    if (matchesRule(rule, toolName, args)) {
      if (rule.action === 'deny') {
        return {
          decision: 'deny',
          reason: rule.message,
          ruleId: rule.id,
        };
      }
      if (rule.action === 'ask') {
        return {
          decision: 'ask',
          reason: rule.message,
          ruleId: rule.id,
        };
      }
      if (rule.action === 'allow') {
        return {
          decision: 'allow',
          reason: rule.message,
          ruleId: rule.id,
        };
      }
    }
  }

  // 3. Không có rule nào chạm -> chuyển tiếp sang Auto-pilot
  return { decision: 'pass_through' };
}
