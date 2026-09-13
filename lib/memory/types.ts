/**
 * Memory Types — Cấu trúc dữ liệu bộ nhớ dài hạn có Reviewer Gate (Oh My Hermes port).
 *
 * Phân cấp trạng thái:
 * - pending: Candidate mới do agent đề xuất, chờ user review
 * - active: Đã duyệt, thường xuyên sử dụng
 * - reference: Tham khảo, ít dùng dần theo thời gian
 * - archive: Lưu trữ dài hạn
 * - refused: Đã bị từ chối kèm lý do cụ thể
 */

export type MemoryScopeKind = 'user' | 'project' | 'thread';

export interface MemoryScope {
  kind: MemoryScopeKind;
  ref: string;
}

export type MemoryKind = 'rule' | 'pattern' | 'gotcha' | 'decision' | 'term';

export type MemoryStatus = 'pending' | 'active' | 'reference' | 'archive' | 'refused';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  text: string; // Tối đa 400 ký tự (chuẩn hóa Vyen)
  provenance: {
    threadId: string;
    messageId?: string;
    files?: string[];
  };
  status: MemoryStatus;
  reason?: string; // Bắt buộc khi refused hoặc deferred
  reviewDueAt?: string; // ISO date
  confirmCount: number;
  createdAt: number;
  lastUsedAt?: string;
  digest: string;
}

export interface RecallPackItem {
  id: string;
  text: string;
  why: string;
  score: number;
}

export interface RecallConflict {
  keptId: string;
  droppedId: string;
  rule: 'newer_reviewed_wins' | 'narrower_scope_wins';
}

export interface RecallPack {
  items: RecallPackItem[];
  budget: {
    limitTokens: number;
    usedTokens: number;
    droppedIds: string[];
  };
  conflicts: RecallConflict[];
}

export interface MemoryReviewEntry {
  id: string;
  candidateId: string;
  action: 'remember' | 'refuse' | 'defer';
  reason?: string;
  reviewedAt: number;
}
