import Dexie, { type Table } from 'dexie';
import { tokenize } from '@/lib/search-utils';
import type { MemoryRecord, MemoryReviewEntry } from '@/lib/memory/types';
import type { AgentMemoryRecord } from '@/lib/memory/agent-memory';
import type { ZeroMemTrace, ZeroMemEntity, ZeroMemRelation } from '@/lib/zeromem/types';

/**
 * IndexedDB KHÔNG index được `null`. Message gốc phải mang sentinel này,
 * nếu không sẽ biến mất khỏi [chatId+parentId] và làm sập cấp phát branchOrder.
 * `null` chỉ tồn tại ở tầng domain; DB luôn thấy string.
 */
export const ROOT_KEY = '__ROOT__';

export function toParentKey(parentId: string | null | undefined): string {
  return parentId == null || parentId === ROOT_KEY ? ROOT_KEY : parentId;
}
export function fromParentKey(key: string | null | undefined): string | null {
  return key == null || key === ROOT_KEY ? null : key;
}

export type StoredMessageRole = 'user' | 'assistant' | 'system' | 'data';
export type StoredMessageFinishReason = 'stop' | 'abort' | 'error';
export type StoredMessageStatus = 'complete' | 'streaming' | 'aborted' | 'error';

export interface ChatSession {
  id: string;
  title: string;
  titleTokens?: string[];
  pinned: 0 | 1;
  createdAt: number;
  updatedAt: number;
  activeLeafId?: string;
  /** key = parentId đã chuẩn hóa (ROOT_KEY cho gốc), value = childId được chọn */
  branchSelection?: Record<string, string>;
  revision?: number;
  lastWriterId?: string;
  /** Thư mục làm việc gắn liền với phiên (P2-8) */
  workspacePath?: string;
  /**
   * Marker nén hội thoại (compaction): mọi tin nhắn TRƯỚC/TRÊN `upToId`
   * dọc nhánh hiện tại đã được thay thế bằng `summary` khi gửi lên model.
   * summary rỗng = hard-trim (tóm tắt thất bại, bỏ tin cũ không tóm tắt).
   * Tính hợp lệ theo nhánh: upToId không còn trong projection → marker bỏ qua.
   *
   * `state` là dữ kiện tích lũy qua các lần nén (file đã chạm, yêu cầu đã nêu).
   * Field không index → mở rộng không cần bump Dexie schema. Bản nén cũ trước
   * khi nâng cấp sẽ thiếu field này — code đọc phải xử lý undefined.
   */
  compaction?: {
    upToId: string;
    summary: string;
    compactedCount: number;
    createdAt: number;
    state?: {
      filesRead: string[];
      filesWritten: string[];
      filesEdited: string[];
      completedRequests: string[];
      generation: number;
    };
  };
}

export interface StoredAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  /** Blob lưu trực tiếp trong IndexedDB. Không data URL, không blob: URL. */
  blob?: Blob;
  /** File nằm ở remote storage (http/https) — khi đó không có blob. */
  remoteUrl?: string;
}

export interface StoredMessage {
  id: string;
  chatId: string;
  role: StoredMessageRole;
  content: string;
  /** Luôn là string trong DB. Dùng fromParentKey() khi đọc ra domain. */
  parentId: string;
  seq: number;
  branchOrder: number;
  branchTieBreaker: string;
  createdAt: number;
  attachments?: StoredAttachment[];
  finishReason?: StoredMessageFinishReason;
  status?: StoredMessageStatus;
  tokens?: string[];
  /** Annotation từ data stream (requestId, attempt, key, model...). */
  annotations?: Array<Record<string, unknown>>;
  /**
   * Kết quả tool client-executed (fs_*) do useChat gắn vào assistant message.
   * PHẢI persist: route.attachToolResultParts() dựng lại tool-call parts từ
   * đây, thiếu nó thì sau khi tải lại trang model mất sạch kết quả đã đọc và
   * gọi lại từ đầu; đồng thời estimateContextTokens() đếm hụt ngân sách.
   * Trường không index → không cần bump version Dexie.
   */
  toolInvocations?: StoredToolInvocation[];
}

/**
 * Bản thu gọn của ToolInvocation (AI SDK) đủ để tái tạo tool-call parts.
 * `result` được cắt trần trước khi ghi (xem sanitizeToolInvocations).
 */
export interface StoredToolInvocation {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  state: string;
  result?: unknown;
}


/** Nhà cung cấp API (provider preset) — chuẩn OpenAI-compatible. */
export interface ProviderPresetRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  createdAt: number;
  updatedAt: number;
  models?: Array<{ id: string; name?: string; contextLength?: number }>;
  modelsFetchedAt?: number;
}

/** KV chung: directory handle auto-backup, flags seed... */
export interface KVEntry {
  key: string;
  value: unknown;
}

/**
 * Checkpoint workspace cho agent coding: nội dung file NGAY TRƯỚC khi agent
 * ghi (fs_write/fs_edit được duyệt). Rollback = ghi lại content cũ; file có
 * existedBefore=false thì rollback XÓA file đi (tham khảo thiết kế snapshot
 * của numasec: "file did not exist in snapshot, deleting").
 */
export interface WsSnapshotFile {
  path: string;
  /** Nội dung trước khi agent ghi ('' khi existedBefore=false). */
  content: string;
  existedBefore: boolean;
}

export interface WorkspaceSnapshot {
  id: string;
  chatId: string;
  createdAt: number;
  files: WsSnapshotFile[];
  /**
   * Có file không chụp được trước khi ghi (quá lớn / lỗi đọc) → snapshot
   * KHÔNG đầy đủ → bị chặn rollback (an toàn hơn chiến lược bỏ-im-lặng của
   * numasec vì browser không có git làm lưới cứu).
   */
  incomplete?: boolean;
  /** Đã hoàn tác — chỉ còn là lịch sử, không restorable. */
  undoneAt?: number;
}

/** Ghi nhớ dài hạn kiểu fx-memory: fact ngắn user/model muốn giữ xuyên chat. */
export interface StoredMemory {
  id: string;
  text: string;
  createdAt: number;
}

/**
 * Recipe: workflow đóng gói tái sử dụng. `content` là text
 * yaml/json nguyên văn; parse qua lib/recipes/parse.ts khi cần dùng.
 */
export interface RecipeRecord {
  id: string;
  title: string;
  /** 'yaml' | 'json' — cách đọc lại content. */
  format: 'yaml' | 'json';
  content: string;
  source: 'local' | 'imported';
  createdAt: number;
  updatedAt: number;
}

/** Quyền per-tool hoặc per-category lưu Dexie v14 (P1-6). */
export interface StoredToolPermissionRecord {
  toolName: string;
  permission: 'default' | 'auto' | 'ask' | 'deny';
  updatedAt: number;
}

export type ScheduleStatus = 'idle' | 'running' | 'success' | 'failure';

/** Bản ghi lịch chạy recipe tự động theo cron (P2-9). */
export interface ScheduleRecord {
  id: string;
  recipeId: string;
  recipeName?: string;
  cron: string;
  enabled: boolean;
  lastRunAt?: number;
  lastStatus?: ScheduleStatus;
  lastError?: string;
  sessions: string[];
  workspacePath?: string;
  createdAt: number;
  updatedAt: number;
}

export type AuditActionType =
  | 'approval'
  | 'rejection'
  | 'file_modification'
  | 'shell_execution'
  | 'auto_approval'
  | string;

export type AuditDecisionType =
  | 'approved'
  | 'rejected'
  | 'auto_approved'
  | 'executed'
  | 'blocked'
  | string;

/**
 * Bản ghi nhật ký kiểm toán bất biến (P3.5 Immutable Audit Log).
 * Ghi nhận mọi lượt duyệt, từ chối, sửa file và chạy shell.
 */
export interface StoredAuditLogEntry {
  id: string;
  timestamp: number;
  action: AuditActionType;
  tool: string;
  target?: string;
  payloadHash?: string;
  decision: AuditDecisionType;
  chatId?: string;
  details?: Record<string, unknown>;
}

function newAttachmentId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `att-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * Chuẩn hoá trước khi persist: tự sinh id/size nếu thiếu.
 * Bỏ (không throw) attachment không có Blob hay remote URL hợp lệ —
 * một record lỗi không được làm sập toàn bộ lượt ghi.
 */
function sanitizeAttachments(list?: StoredAttachment[]): StoredAttachment[] | undefined {
  if (!list?.length) return list;
  const cleaned: StoredAttachment[] = [];
  for (const a of list) {
    const { blob, id, name, contentType, size, remoteUrl } = a as StoredAttachment & {
      url?: string;
    };
    if (!(blob instanceof Blob) && !/^https?:\/\//i.test(remoteUrl ?? '')) {
      console.warn(`[db] Bỏ attachment "${name}" — không có Blob/remote URL hợp lệ.`);
      continue;
    }
    cleaned.push({
      id: id || newAttachmentId(),
      name,
      contentType,
      size: size ?? blob?.size ?? 0,
      ...(blob instanceof Blob ? { blob } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
    });
  }
  return cleaned.length ? cleaned : undefined;
}

/**
 * Trần ký tự (JSON) cho `result` của một tool invocation khi persist.
 * Khớp TOOL_RESULT_MAX_CHARS ở lib/tool-limits.ts — giữ số ở đây độc lập để
 * db.ts không phụ thuộc module runtime của agent.
 */
export const STORED_TOOL_RESULT_CHARS = 24_000;
/** Số invocation tối đa giữ lại trên MỘT message (khớp trần zod của route). */
export const STORED_TOOL_INVOCATIONS_MAX = 12;

/**
 * Chuẩn hoá tool invocation trước khi ghi: chỉ giữ invocation đã có kết quả
 * (state 'result' — pending không tái tạo được part hợp lệ), cắt trần result
 * quá lớn thành ghi chú, và giới hạn số lượng để một lượt agent coding dài
 * không thổi phồng một record IndexedDB.
 */
export function sanitizeToolInvocations(
  list?: StoredToolInvocation[],
): StoredToolInvocation[] | undefined {
  if (!list?.length) return undefined;
  const cleaned: StoredToolInvocation[] = [];
  for (const inv of list) {
    if (!inv || typeof inv.toolName !== 'string' || inv.state !== 'result') continue;
    let result = inv.result;
    try {
      const raw = JSON.stringify(result ?? null) ?? 'null';
      if (raw.length > STORED_TOOL_RESULT_CHARS) {
        result = {
          truncated: true,
          note: `[kết quả ${raw.length} ký tự đã bị cắt khi lưu — gọi lại công cụ nếu cần đầy đủ]`,
          preview: raw.slice(0, STORED_TOOL_RESULT_CHARS),
        };
      }
    } catch {
      // Kết quả không serialize được (circular/BigInt) → không thể persist.
      result = { note: '[kết quả không lưu được]' };
    }
    cleaned.push({
      toolCallId: String(inv.toolCallId ?? ''),
      toolName: inv.toolName,
      ...(inv.args !== undefined ? { args: inv.args } : {}),
      state: 'result',
      result,
    });
  }
  if (!cleaned.length) return undefined;
  // Giữ những invocation MỚI NHẤT khi vượt trần: chúng gần câu hỏi hiện tại nhất.
  return cleaned.slice(-STORED_TOOL_INVOCATIONS_MAX);
}

export class ChatAppDatabase extends Dexie {
  chats!: Table<ChatSession, string>;
  messages!: Table<StoredMessage, string>;
  kv!: Table<KVEntry, string>;
  providers!: Table<ProviderPresetRecord, string>;
  memories!: Table<StoredMemory, string>;
  wsSnapshots!: Table<WorkspaceSnapshot, string>;
  memoryCandidates!: Table<MemoryRecord, string>;
  memoryRecords!: Table<MemoryRecord, string>;
  memoryReviews!: Table<MemoryReviewEntry, string>;
  recipes!: Table<RecipeRecord, string>;
  agentMemories!: Table<AgentMemoryRecord, string>;
  toolPermissions!: Table<StoredToolPermissionRecord, string>;
  schedules!: Table<ScheduleRecord, string>;
  zeromemTraces!: Table<ZeroMemTrace, string>;
  zeromemEntities!: Table<ZeroMemEntity, string>;
  zeromemRelations!: Table<ZeroMemRelation, string>;
  auditLogs!: Table<StoredAuditLogEntry, string>;

  constructor() {
    super('ai_chat_app_db');

    this.version(1).stores({
      chats: 'id, createdAt, updatedAt, pinned',
      messages: 'id, chatId, role, createdAt, seq, parentId',
    });

    this.version(2).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId',
      messages:
        'id, chatId, role, createdAt, seq, parentId, [chatId+parentId], [chatId+createdAt]',
    });

    this.version(3).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId',
      messages:
        'id, chatId, role, createdAt, seq, parentId, [chatId+parentId], [chatId+createdAt], *tokens',
    });

    this.version(4)
      .stores({
        chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
        messages:
          'id, chatId, role, createdAt, seq, parentId, ' +
          '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
          '[chatId+parentId+branchOrder], *tokens',
        leases: 'chatId, expiresAt, writerId',
      })
      .upgrade(async (tx) => {        const counters = new Map<string, number>();
        await tx
          .table<StoredMessage>('messages')
          .toCollection()
          .modify((m) => {
            const legacy = m as StoredMessage & { parentId: string | null };
            m.parentId = toParentKey(legacy.parentId);
            if (typeof m.branchTieBreaker !== 'string') m.branchTieBreaker = m.id;
            if (!Array.isArray(m.tokens) || m.tokens.length === 0) {
              m.tokens = tokenize(m.content || '');
            }
            if (typeof m.branchOrder !== 'number') {
              const bucket = `${m.chatId}::${m.parentId}`;
              const next = counters.get(bucket) ?? 0;
              m.branchOrder = next;
              counters.set(bucket, next + 1);
            }
          });

        await tx
          .table<ChatSession>('chats')
          .toCollection()
          .modify((c) => {
            if (!Array.isArray(c.titleTokens) || c.titleTokens.length === 0) {
              c.titleTokens = tokenize(c.title || '');
            }
            delete (c as unknown as Record<string, unknown>).activeLease;
          });
      });

    // v5: bỏ bảng leases (hệ thống stream lease đã được gỡ hoàn toàn).
    // Table thiếu trong schema mới sẽ bị Dexie tự động xoá.
    this.version(5).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
    });

    // v6: thư viện prompt ("/") + bảng KV (lưu directory handle auto-backup, flags).
    this.version(6).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
    });

    // v7: provider presets — nhiều nhà cung cấp API OpenAI-compatible.
    this.version(7).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
      providers: 'id, updatedAt',
    });

    // v8: ghi nhớ dài hạn kiểu fx-memory — model tra qua tool memory_search.
    this.version(8).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
      providers: 'id, updatedAt',
      memories: 'id, createdAt',
    });

    // v9: workspace checkpoint — snapshot file trước khi agent coding ghi đĩa,
    // phục vụ hoàn tác (undo). Chỉ thêm bảng mới, không đụng store cũ.
    this.version(9).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
      providers: 'id, updatedAt',
      memories: 'id, createdAt',
      ws_snapshots: 'id, chatId, createdAt',
    });

    // v10: sửa bug đặt tên — schema v9 khai báo 'ws_snapshots' (snake_case)
    // nhưng code truy cập db.wsSnapshots (camelCase) → undefined.where() crash.
    // Tạo bảng đúng tên và migrate snapshot cũ; bảng snake_case sẽ bị Dexie tự xoá.
    this.version(10)
      .stores({
        chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
        messages:
          'id, chatId, role, createdAt, seq, parentId, ' +
          '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
          '[chatId+parentId+branchOrder], *tokens',
        prompts: 'id, updatedAt',
        kv: 'key',
        providers: 'id, updatedAt',
        memories: 'id, createdAt',
        wsSnapshots: 'id, chatId, createdAt',
      })
      .upgrade(async (tx) => {
        const legacy = tx.table<WorkspaceSnapshot>('ws_snapshots');
        const rows = await legacy.toArray();
        if (rows.length) {
          await tx.table<WorkspaceSnapshot>('wsSnapshots').bulkPut(rows);
        }
      });

    // v11: reviewer-gated long-term memory (P1-D)
    // - memoryCandidates: pending candidates do agent đề xuất, chờ user review
    // - memoryRecords: ký ức đã duyệt (active/reference/archive) kèm reviewDueAt + provenance
    // - memoryReviews: nhật ký kiểm duyệt (remember/refuse/defer)
    this.version(11)
      .stores({
        chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
        messages:
          'id, chatId, role, createdAt, seq, parentId, ' +
          '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
          '[chatId+parentId+branchOrder], *tokens',
        prompts: 'id, updatedAt',
        kv: 'key',
        providers: 'id, updatedAt',
        memories: 'id, createdAt',
        wsSnapshots: 'id, chatId, createdAt',
        memoryCandidates: 'id, status, createdAt, digest, [scope.kind+scope.ref]',
        memoryRecords: 'id, status, createdAt, reviewDueAt, digest, [scope.kind+scope.ref]',
        memoryReviews: 'id, candidateId, action, reviewedAt',
      })
      .upgrade(async (tx) => {
        try {
          const legacyMemories = await tx.table<StoredMemory>('memories').toArray();
          if (legacyMemories.length) {
            const records: MemoryRecord[] = legacyMemories.map((m) => ({
              id: m.id,
              scope: { kind: 'user', ref: 'default' },
              kind: m.text.startsWith('[LESSON:') ? 'rule' : 'pattern',
              text: m.text.slice(0, 400),
              provenance: { threadId: 'migrated' },
              status: 'active',
              confirmCount: 1,
              createdAt: m.createdAt,
              digest: `migrated-${m.id}`,
              lastUsedAt: new Date(m.createdAt).toISOString(),
              reviewDueAt: new Date(m.createdAt + 30 * 86400_000).toISOString(),
            }));
            await tx.table<MemoryRecord>('memoryRecords').bulkPut(records);
          }
        } catch {
          /* Bỏ qua nếu bảng cũ không có */
        }
      });

    // v12: recipes — workflow đóng gói tái sử dụng (recipe).
    // content giữ NGUYÊN VĂN yaml/json để export lại y hệt; parse/schema nằm ở
    // lib/recipes. source phân biệt recipe người dùng tự tạo và recipe import
    // từ link/file.
    this.version(12).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
      providers: 'id, updatedAt',
      memories: 'id, createdAt',
      wsSnapshots: 'id, chatId, createdAt',
      memoryCandidates: 'id, status, createdAt, digest, [scope.kind+scope.ref]',
      memoryRecords: 'id, status, createdAt, reviewDueAt, digest, [scope.kind+scope.ref]',
      memoryReviews: 'id, candidateId, action, reviewedAt',
      recipes: 'id, title, updatedAt, source',
    });

    // v13: agentMemories — bộ nhớ có cấu trúc (P1-4): category +
    // tags + scope local/global; tách biệt hệ reviewer-gate (v11) — hệ này là
    // kho ghi nhanh do tool remember_memory ghi, không qua duyệt.
    this.version(13).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
      providers: 'id, updatedAt',
      memories: 'id, createdAt',
      wsSnapshots: 'id, chatId, createdAt',
      memoryCandidates: 'id, status, createdAt, digest, [scope.kind+scope.ref]',
      memoryRecords: 'id, status, createdAt, reviewDueAt, digest, [scope.kind+scope.ref]',
      memoryReviews: 'id, candidateId, action, reviewedAt',
      recipes: 'id, title, updatedAt, source',
      agentMemories: 'id, category, scope, workspaceKey, createdAt, *tags',
    });

    // v14: toolPermissions — quyền per-tool / per-category (P1-6): auto | ask | deny.
    this.version(14).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
      providers: 'id, updatedAt',
      memories: 'id, createdAt',
      wsSnapshots: 'id, chatId, createdAt',
      memoryCandidates: 'id, status, createdAt, digest, [scope.kind+scope.ref]',
      memoryRecords: 'id, status, createdAt, reviewDueAt, digest, [scope.kind+scope.ref]',
      memoryReviews: 'id, candidateId, action, reviewedAt',
      recipes: 'id, title, updatedAt, source',
      agentMemories: 'id, category, scope, workspaceKey, createdAt, *tags',
      toolPermissions: 'toolName, permission, updatedAt',
    });

    // v15: gắn workspacePath vào chats (P2-8), index workspacePath để truy vấn/lọc theo thư mục
    this.version(15).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, workspacePath, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
      providers: 'id, updatedAt',
      memories: 'id, createdAt',
      wsSnapshots: 'id, chatId, createdAt',
      memoryCandidates: 'id, status, createdAt, digest, [scope.kind+scope.ref]',
      memoryRecords: 'id, status, createdAt, reviewDueAt, digest, [scope.kind+scope.ref]',
      memoryReviews: 'id, candidateId, action, reviewedAt',
      recipes: 'id, title, updatedAt, source',
      agentMemories: 'id, category, scope, workspaceKey, createdAt, *tags',
      toolPermissions: 'toolName, permission, updatedAt',
    });

    // v16: schedules (P2-9) — chạy recipe theo lịch cron (desktop/CLI runner)
    this.version(16).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, workspacePath, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
      providers: 'id, updatedAt',
      memories: 'id, createdAt',
      wsSnapshots: 'id, chatId, createdAt',
      memoryCandidates: 'id, status, createdAt, digest, [scope.kind+scope.ref]',
      memoryRecords: 'id, status, createdAt, reviewDueAt, digest, [scope.kind+scope.ref]',
      memoryReviews: 'id, candidateId, action, reviewedAt',
      recipes: 'id, title, updatedAt, source',
      agentMemories: 'id, category, scope, workspaceKey, createdAt, *tags',
      toolPermissions: 'toolName, permission, updatedAt',
      schedules: 'id, recipeId, cron, enabled, lastRunAt, lastStatus, createdAt, updatedAt',
    });

    // v17: Zero-Mem (sarsvankelsion/zero-mem) — zero-token memory operations: traces, entities, relations
    this.version(17).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, workspacePath, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      prompts: 'id, updatedAt',
      kv: 'key',
      providers: 'id, updatedAt',
      memories: 'id, createdAt',
      wsSnapshots: 'id, chatId, createdAt',
      memoryCandidates: 'id, status, createdAt, digest, [scope.kind+scope.ref]',
      memoryRecords: 'id, status, createdAt, reviewDueAt, digest, [scope.kind+scope.ref]',
      memoryReviews: 'id, candidateId, action, reviewedAt',
      recipes: 'id, title, updatedAt, source',
      agentMemories: 'id, category, scope, workspaceKey, createdAt, *tags',
      toolPermissions: 'toolName, permission, updatedAt',
      schedules: 'id, recipeId, cron, enabled, lastRunAt, lastStatus, createdAt, updatedAt',
      zeromemTraces: 'id, sessionId, episodeId, timestamp, *entityIds',
      zeromemEntities: 'id, name, kind, scope, createdAt',
      zeromemRelations: 'id, sourceId, targetId, relationType, createdAt',
    });

    /*
     * v18: XOÁ bảng `prompts` — rác còn sót từ bản web chat cũ.
     *
     * Bảng này chứa "thư viện prompt" của một trợ lý chat đa dụng (5 mẫu seed:
     * "Dịch Trung - Việt", "Sửa lỗi chính tả", "Tóm tắt văn bản"...), không
     * liên quan gì tới coding agent. Nó sống sót qua lần dọn trước vì được tái
     * sử dụng cho mục "Skills cũ (trình duyệt)" trong Cài đặt — mục đó nay đã
     * gỡ cùng `lib/prompt-library.ts`.
     *
     * Dexie xoá bảng khi bảng không còn xuất hiện trong `.stores()` của version
     * mới nhất, nên chỉ cần khai báo lại danh sách KHÔNG có `prompts`.
     *
     * Ba bảng `zeromem*` được GIỮ LẠI: chúng đã có người ghi thật qua
     * `lib/zeromem/persistence.ts` (trước đó khai báo nhưng không ai ghi).
     * `memories`, `memoryCandidates/Records/Reviews` cũng giữ — đã kiểm chứng
     * là còn được dùng trong luồng đề xuất/duyệt ghi nhớ.
     */
    this.version(18).stores({
      chats: 'id, createdAt, updatedAt, pinned, activeLeafId, workspacePath, *titleTokens',
      messages:
        'id, chatId, role, createdAt, seq, parentId, ' +
        '[chatId+parentId], [chatId+createdAt], [chatId+seq], ' +
        '[chatId+parentId+branchOrder], *tokens',
      kv: 'key',
      providers: 'id, updatedAt',
      memories: 'id, createdAt',
      wsSnapshots: 'id, chatId, createdAt',
      memoryCandidates: 'id, status, createdAt, digest, [scope.kind+scope.ref]',
      memoryRecords: 'id, status, createdAt, reviewDueAt, digest, [scope.kind+scope.ref]',
      memoryReviews: 'id, candidateId, action, reviewedAt',
      recipes: 'id, title, updatedAt, source',
      agentMemories: 'id, category, scope, workspaceKey, createdAt, *tags',
      toolPermissions: 'toolName, permission, updatedAt',
      schedules: 'id, recipeId, cron, enabled, lastRunAt, lastStatus, createdAt, updatedAt',
      zeromemTraces: 'id, sessionId, episodeId, timestamp, *entityIds',
      zeromemEntities: 'id, name, kind, scope, createdAt',
      zeromemRelations: 'id, sourceId, targetId, relationType, createdAt',
    });

    /*
     * v19: Bổ sung bảng `auditLogs` — nhật ký kiểm toán bất biến append-only (P3.5).
     * Ghi nhận phê duyệt, từ chối, chỉnh sửa file và thực thi lệnh shell kèm băm SHA-256.
     */
    this.version(19).stores({
      auditLogs: 'id, timestamp, action, tool, decision, chatId',
    });

    this.messages.hook('creating', (_primKey, obj) => {
      obj.parentId = toParentKey(obj.parentId as string | null);
      if (typeof obj.branchTieBreaker !== 'string') obj.branchTieBreaker = obj.id;
      if (typeof obj.branchOrder !== 'number') obj.branchOrder = 0;
      obj.attachments = sanitizeAttachments(obj.attachments);
      obj.toolInvocations = sanitizeToolInvocations(obj.toolInvocations);
      if (obj.status !== 'streaming' && (!obj.tokens || obj.tokens.length === 0)) {
        obj.tokens = tokenize(obj.content || '');
      }
    });

    this.messages.hook('updating', (mods: Partial<StoredMessage>, _primKey, obj) => {
      const patch: Partial<StoredMessage> = {};

      const nextStatus = ('status' in mods ? mods.status : obj.status) ?? 'complete';
      const nextContent = ('content' in mods ? mods.content : obj.content) ?? '';
      const contentChanged = 'content' in mods && typeof mods.content === 'string';
      const leftStreaming = obj.status === 'streaming' && nextStatus !== 'streaming';

      if ((contentChanged || leftStreaming) && nextStatus !== 'streaming') {
        patch.tokens = tokenize(nextContent);
      }
      if ('parentId' in mods) {
        patch.parentId = toParentKey(mods.parentId as unknown as string | null);
      }
      if ('attachments' in mods) {
        patch.attachments = sanitizeAttachments(mods.attachments);
      }
      if ('toolInvocations' in mods) {
        patch.toolInvocations = sanitizeToolInvocations(mods.toolInvocations);
      }
      return Object.keys(patch).length ? { ...mods, ...patch } : mods;
    });

    this.chats.hook('creating', (_primKey, obj) => {
      obj.titleTokens = tokenize(obj.title || '');
    });
    this.chats.hook('updating', (mods: Partial<ChatSession>) => {
      if ('title' in mods && typeof mods.title === 'string') {
        return { ...mods, titleTokens: tokenize(mods.title) };
      }
      return mods;
    });

    this.on('blocked', () => {
      console.warn('[db] Upgrade bị chặn bởi tab khác đang mở phiên bản cũ.');
    });
    this.on('versionchange', () => {
      this.close();
      if (typeof window !== 'undefined') window.location.reload();
    });
  }
}

export const db = new ChatAppDatabase();

/* ------------------------------------------------------------------ */
/* Ghi nhớ dài hạn (memory) — CRUD dùng chung client                   */
/* ------------------------------------------------------------------ */

/** Trần số fact và độ dài mỗi fact — khớp schema /api/chat (memories). */
export const MAX_MEMORIES = 40;
export const MAX_MEMORY_CHARS = 400;

function newMemoryId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export async function listMemories(): Promise<StoredMemory[]> {
  try {
    const all = await db.memories.orderBy('createdAt').reverse().toArray();
    return all.slice(0, MAX_MEMORIES).map(({ id, text, createdAt }) => ({ id, text, createdAt }));
  } catch {
    return [];
  }
}

/** Thêm fact: bỏ trùng nguyên văn, cắt trần ký tự, giữ tối đa MAX_MEMORIES (cũ nhất bị loại). */
export async function addMemory(rawText: string): Promise<StoredMemory | null> {
  const text = rawText.trim().slice(0, MAX_MEMORY_CHARS);
  if (!text) return null;
  const existing = await db.memories.toArray();
  if (existing.some((m) => m.text === text)) return null;
  if (existing.length >= MAX_MEMORIES) {
    const oldest = existing.sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) await db.memories.delete(oldest.id);
  }
  const record: StoredMemory = { id: newMemoryId(), text, createdAt: Date.now() };
  await db.memories.put(record);
  return record;
}

export async function deleteMemory(id: string): Promise<void> {
  await db.memories.delete(id);
}

export async function clearMemories(): Promise<void> {
  await db.memories.clear();
}

/* ------------------------------------------------------------------ */
/* Allocator ATOMIC — mọi lệnh chèn message PHẢI đi qua đây            */
/* ------------------------------------------------------------------ */

export interface AppendMessageInput
  extends Omit<StoredMessage, 'parentId' | 'seq' | 'branchOrder' | 'branchTieBreaker' | 'createdAt'> {
  parentId: string | null;
  createdAt?: number;
}

export async function appendMessage(input: AppendMessageInput): Promise<StoredMessage> {
  const parentKey = toParentKey(input.parentId);

  return db.transaction('rw', db.messages, db.chats, async () => {
    const lastSibling = await db.messages
      .where('[chatId+parentId+branchOrder]')
      .between(
        [input.chatId, parentKey, Dexie.minKey],
        [input.chatId, parentKey, Dexie.maxKey],
      )
      .last();

    const lastInChat = await db.messages
      .where('[chatId+seq]')
      .between([input.chatId, Dexie.minKey], [input.chatId, Dexie.maxKey])
      .last();

    const record: StoredMessage = {
      ...input,
      parentId: parentKey,
      seq: (lastInChat?.seq ?? -1) + 1,
      branchOrder: (lastSibling?.branchOrder ?? -1) + 1,
      branchTieBreaker: input.id,
      createdAt: input.createdAt ?? Date.now(),
      attachments: sanitizeAttachments(input.attachments),
      toolInvocations: sanitizeToolInvocations(input.toolInvocations),
    };

    await db.messages.add(record);
    await db.chats.update(input.chatId, {
      updatedAt: record.createdAt,
      activeLeafId: record.id,
    });
    return record;
  });
}

/** Cascade delete: messages + attachments + workspace snapshots của cả chat. */
export async function deleteChatCascade(chatId: string): Promise<void> {
  await db.transaction('rw', db.messages, db.chats, db.wsSnapshots, async () => {
    await db.messages.where('chatId').equals(chatId).delete();
    await db.wsSnapshots.where('chatId').equals(chatId).delete();
    await db.chats.delete(chatId);
  });
}
