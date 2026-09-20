/**
 * Immutable Audit Log (P3.5).
 *
 * Cơ chế ghi nhật ký bất biến append-only trong Dexie IndexedDB (bảng `auditLogs`).
 * Ghi nhận toàn bộ các quyết định phê duyệt, từ chối, sửa file và thực thi lệnh shell:
 * - timestamp: thời điểm chính xác
 * - action: approval | rejection | file_modification | shell_execution | auto_approval
 * - tool: tên công cụ được gọi (fs_edit, fs_write, shell_run, mcp__*,...)
 * - target: đường dẫn file hoặc lệnh shell
 * - payloadHash: băm SHA-256 nội dung/đối số để chứng minh tính toàn vẹn
 * - decision: approved | rejected | auto_approved | executed | blocked
 * - chatId: phiên làm việc tương ứng
 */

import { db, type StoredAuditLogEntry, type AuditActionType, type AuditDecisionType } from '@/lib/db';

export type { StoredAuditLogEntry, AuditActionType, AuditDecisionType };

/**
 * Tính băm SHA-256 của payload một cách an toàn trên cả Browser và Node.js.
 */
export async function computePayloadHash(payload: unknown): Promise<string> {
  if (payload === undefined || payload === null) return '';
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);

  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
      const buffer = new TextEncoder().encode(text);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // Fallback nếu subtle crypto không khả dụng
  }

  // Fallback FNV-1a 32-bit kết hợp chuỗi hóa nếu không có crypto API
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface RecordAuditLogParams {
  action: AuditActionType;
  tool: string;
  target?: string;
  decision: AuditDecisionType;
  payload?: unknown;
  payloadHash?: string;
  chatId?: string;
  details?: Record<string, unknown>;
}

function newAuditId(): string {
  try {
    return globalThis.crypto?.randomUUID() ?? `aud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  } catch {
    return `aud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * Ghi một bản ghi nhật ký kiểm toán mới (append-only).
 */
export async function recordAuditLog(params: RecordAuditLogParams): Promise<StoredAuditLogEntry> {
  const hash = params.payloadHash ?? (params.payload !== undefined ? await computePayloadHash(params.payload) : undefined);

  const entry: StoredAuditLogEntry = {
    id: newAuditId(),
    timestamp: Date.now(),
    action: params.action,
    tool: params.tool,
    ...(params.target ? { target: params.target } : {}),
    ...(hash ? { payloadHash: hash } : {}),
    decision: params.decision,
    ...(params.chatId ? { chatId: params.chatId } : {}),
    ...(params.details ? { details: params.details } : {}),
  };

  try {
    await db.auditLogs.add(entry);
  } catch (err) {
    console.warn('[audit-log] Ghi nhật ký kiểm toán thất bại:', err);
  }

  return entry;
}

export interface AuditLogFilter {
  tool?: string;
  action?: string;
  decision?: string;
  chatId?: string;
  limit?: number;
}

/**
 * Đọc danh sách nhật ký kiểm toán theo bộ lọc, sắp xếp mới nhất trước.
 */
export async function queryAuditLogs(filter?: AuditLogFilter): Promise<StoredAuditLogEntry[]> {
  try {
    let collection = db.auditLogs.orderBy('timestamp').reverse();

    if (filter?.tool) {
      collection = collection.filter((item) => item.tool === filter.tool);
    }
    if (filter?.action) {
      collection = collection.filter((item) => item.action === filter.action);
    }
    if (filter?.decision) {
      collection = collection.filter((item) => item.decision === filter.decision);
    }
    if (filter?.chatId) {
      collection = collection.filter((item) => item.chatId === filter.chatId);
    }

    if (filter?.limit && filter.limit > 0) {
      return await collection.limit(filter.limit).toArray();
    }

    return await collection.toArray();
  } catch (err) {
    console.warn('[audit-log] Truy vấn nhật ký thất bại:', err);
    return [];
  }
}

/**
 * Xoá sạch nhật ký kiểm toán (chỉ dùng khi test hoặc reset dữ liệu cá nhân).
 */
export async function clearAuditLogs(): Promise<void> {
  try {
    await db.auditLogs.clear();
  } catch (err) {
    console.warn('[audit-log] Xóa nhật ký thất bại:', err);
  }
}
