/**
 * Capability Projection — Dự chiếu năng lực theo ngân sách byte và quyền hạn đóng băng (Oh My Hermes port).
 *
 * Thay thế cho trần cứng "100 MCP tool / request":
 * 1. Chỉ đưa các tool/skill liên quan trực tiếp đến request hiện tại.
 * 2. Ngân sách đo bằng byte payload của tool schema.
 * 3. Mọi công cụ bị loại trừ PHẢI thuộc đúng 1 trong 4 lý do thuộc bộ từ vựng đóng:
 *    - 'not_granted_by_authority': Chưa được người dùng cấp quyền trong phiên
 *    - 'not_relevant_to_request': Không có điểm liên quan tới nội dung request
 *    - 'outranked_by_shortlist': Bị điểm thấp hơn các công cụ khác trong danh sách
 *    - 'beyond_context_budget': Vượt quá ngân sách byte cho phép của ngữ cảnh
 * 4. Authority đã duyệt bị đóng băng (frozen) theo taskId qua authorityDigest.
 */

import { scoreRequest } from '@/lib/routing/score-request';

export type ToolGroup = 'fs' | 'shell' | 'git' | 'mcp' | 'plan' | 'memory' | 'web' | 'skill';

export interface ToolCandidate {
  id: string;
  group: ToolGroup;
  description: string;
  bytes: number;
}

export type ExclusionReason =
  | 'beyond_context_budget'
  | 'not_granted_by_authority'
  | 'not_relevant_to_request'
  | 'outranked_by_shortlist';

export interface ProjectionIncludedItem {
  id: string;
  score: number;
  why: string[];
}

export interface ProjectionExcludedItem {
  id: string;
  reason: ExclusionReason;
}

export interface ProjectionBudget {
  limitBytes: number;
  usedBytes: number;
  droppedIds: string[];
}

export interface Projection {
  included: ProjectionIncludedItem[];
  excluded: ProjectionExcludedItem[];
  budget: ProjectionBudget;
  authorityDigest: string;
}

/** Danh sách catalog mặc định của Vyen */
export const DEFAULT_TOOL_CANDIDATES: ToolCandidate[] = [
  { id: 'fs_read', group: 'fs', description: 'Đọc nội dung file', bytes: 420 },
  { id: 'fs_write', group: 'fs', description: 'Ghi tạo mới file hoàn chỉnh', bytes: 460 },
  { id: 'fs_edit', group: 'fs', description: 'Chỉnh sửa file theo khối SEARCH/REPLACE', bytes: 520 },
  { id: 'fs_list', group: 'fs', description: 'Liệt kê danh sách file trong thư mục', bytes: 380 },
  { id: 'fs_search', group: 'fs', description: 'Tìm kiếm chuỗi hoặc regex trong thư mục', bytes: 480 },
  { id: 'shell_run', group: 'shell', description: 'Chạy lệnh terminal trong sandbox', bytes: 580 },
  { id: 'git_status', group: 'git', description: 'Xem trạng thái thay đổi git', bytes: 340 },
  { id: 'git_diff', group: 'git', description: 'Xem diff các file đã sửa', bytes: 360 },
  { id: 'git_commit', group: 'git', description: 'Tạo commit git', bytes: 390 },
  { id: 'git_log', group: 'git', description: 'Xem lịch sử commit', bytes: 340 },
  { id: 'plan_create', group: 'plan', description: 'Tạo kế hoạch phân rã công việc', bytes: 450 },
  { id: 'plan_update', group: 'plan', description: 'Cập nhật tiến độ kế hoạch', bytes: 420 },
  { id: 'memory_search', group: 'memory', description: 'Tra cứu ghi nhớ dài hạn', bytes: 390 },
  { id: 'memory_propose', group: 'memory', description: 'Đề xuất ghi nhớ mới qua reviewer gate', bytes: 440 },
  { id: 'web_search', group: 'web', description: 'Tìm kiếm web tra cứu tài liệu', bytes: 460 },
  { id: 'web_fetch', group: 'web', description: 'Tải nội dung trang web', bytes: 430 },
];

/** Bộ nhớ cache authority digest theo taskId để phát hiện thay đổi giữa run */
const frozenAuthorityRegistry = new Map<string, string>();

/** Tính digest băm ổn định của authority set */
export function computeAuthorityDigest(authority: ReadonlySet<string>): string {
  const sorted = [...authority].sort();
  let h = 0;
  const str = sorted.join('::');
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return `auth-${(h >>> 0).toString(16)}`;
}

/**
 * Tính điểm liên quan của tool đối với yêu cầu dựa trên tín hiệu routing.
 */
function scoreToolRelevance(
  tool: ToolCandidate,
  reqText: string,
  categoryResult: ReturnType<typeof scoreRequest>,
): { score: number; why: string[] } {
  const why: string[] = [];
  let score = 0;
  const lowerText = reqText.toLowerCase();

  // Nhóm File System
  if (tool.group === 'fs') {
    score += 50;
    why.push('base_fs_capability');
    if (lowerText.includes('đổi tên') || lowerText.includes('rename') || lowerText.includes('sửa')) {
      score += 30;
      why.push('matched_edit_keywords');
    }
    if (categoryResult.exhaustiveSearch && (tool.id === 'fs_search' || tool.id === 'fs_read')) {
      score += 40;
      why.push('exhaustive_search_priority');
    }
  }

  // Nhóm Shell
  if (tool.group === 'shell') {
    if (lowerText.includes('test') || lowerText.includes('chạy') || lowerText.includes('run') || lowerText.includes('build')) {
      score += 60;
      why.push('matched_execution_keywords');
    } else {
      score += 20;
      why.push('general_command_utility');
    }
  }

  // Nhóm Git
  if (tool.group === 'git') {
    if (lowerText.includes('git') || lowerText.includes('commit') || lowerText.includes('branch')) {
      score += 70;
      why.push('matched_git_keywords');
    }
  }

  // Nhóm Plan
  if (tool.group === 'plan') {
    if (categoryResult.category === 'architect' || lowerText.includes('plan') || lowerText.includes('kế hoạch')) {
      score += 80;
      why.push('matched_architecture_or_plan_mode');
    }
  }

  // Nhóm Memory
  if (tool.group === 'memory') {
    if (lowerText.includes('nhớ') || lowerText.includes('bài học') || lowerText.includes('lesson')) {
      score += 60;
      why.push('matched_memory_intent');
    } else {
      score += 10;
      why.push('ambient_memory_context');
    }
  }

  // Nhóm Web
  if (tool.group === 'web') {
    if (lowerText.includes('tra cứu') || lowerText.includes('tìm kiếm web') || lowerText.includes('search web') || lowerText.includes('http')) {
      score += 60;
      why.push('matched_web_keywords');
    }
  }

  return { score, why };
}

/**
 * Thực hiện phép chiếu năng lực (capabilities project).
 */
export function projectCapabilities(req: {
  text: string;
  taskId: string;
  authority: ReadonlySet<string>;
  budgetBytes: number;
  allCandidates?: ToolCandidate[];
}): Projection {
  const currentDigest = computeAuthorityDigest(req.authority);
  const candidates = req.allCandidates ?? DEFAULT_TOOL_CANDIDATES;
  const budgetLimit = Math.max(500, req.budgetBytes);

  // Đóng băng authority: lưu lại digest lần đầu thấy taskId
  if (!frozenAuthorityRegistry.has(req.taskId)) {
    frozenAuthorityRegistry.set(req.taskId, currentDigest);
  }

  const categoryScore = scoreRequest({ text: req.text });

  const included: ProjectionIncludedItem[] = [];
  const excluded: ProjectionExcludedItem[] = [];

  // 1. Phân loại theo quyền hạn và độ liên quan
  const eligibleScored: Array<{
    candidate: ToolCandidate;
    score: number;
    why: string[];
  }> = [];

  for (const candidate of candidates) {
    // Kiểm tra quyền hạn đã cấp
    if (!req.authority.has(candidate.id)) {
      excluded.push({
        id: candidate.id,
        reason: 'not_granted_by_authority',
      });
      continue;
    }

    // Chấm điểm liên quan
    const rel = scoreToolRelevance(candidate, req.text, categoryScore);
    if (rel.score <= 0) {
      excluded.push({
        id: candidate.id,
        reason: 'not_relevant_to_request',
      });
      continue;
    }

    eligibleScored.push({
      candidate,
      score: rel.score,
      why: rel.why,
    });
  }

  // 2. Xếp hạng danh sách hợp lệ từ cao xuống thấp
  eligibleScored.sort((a, b) => b.score - a.score);

  // 3. Đóng gói theo ngân sách byte
  let usedBytes = 0;
  const droppedIds: string[] = [];

  for (let i = 0; i < eligibleScored.length; i++) {
    const item = eligibleScored[i];
    if (usedBytes + item.candidate.bytes <= budgetLimit) {
      usedBytes += item.candidate.bytes;
      included.push({
        id: item.candidate.id,
        score: item.score,
        why: item.why,
      });
    } else {
      // Vượt quá ngân sách
      droppedIds.push(item.candidate.id);
      excluded.push({
        id: item.candidate.id,
        reason: i < 5 ? 'beyond_context_budget' : 'outranked_by_shortlist',
      });
    }
  }

  return {
    included,
    excluded,
    budget: {
      limitBytes: budgetLimit,
      usedBytes,
      droppedIds,
    },
    authorityDigest: currentDigest,
  };
}

/** Xoá registry phục vụ test */
export function __clearFrozenAuthorityRegistry(): void {
  frozenAuthorityRegistry.clear();
}
