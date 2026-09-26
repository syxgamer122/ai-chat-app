/**
 * Immutable Audit Log (P3.5 + Sprint S1).
 *
 * Cơ chế ghi nhật ký bất biến append-only trong Dexie IndexedDB (bảng `auditLogs`).
 * Ghi nhận toàn bộ các quyết định phê duyệt, từ chối, sửa file và thực thi lệnh shell:
 * - seq: số thứ tự tăng dần liên tục (1, 2, 3...)
 * - prevHash: băm SHA-256 của bản ghi trước đó (null cho genesis)
 * - hash: băm SHA-256 của `${prevHash ?? 'GENESIS'}\n${canonicalJsonBody}`
 * - timestamp: thời điểm chính xác
 * - action: approval | rejection | file_modification | shell_execution | auto_approval
 * - tool: tên công cụ được gọi (fs_edit, fs_write, shell_run, mcp__*,...)
 * - target: đường dẫn file hoặc lệnh shell
 * - payloadHash: băm SHA-256 nội dung/đối số để chứng minh tính toàn vẹn (đã che bí mật)
 * - decision: approved | rejected | auto_approved | executed | blocked
 * - chatId: phiên làm việc tương ứng
 * - details: thông tin bổ sung (đã che bí mật)
 *
 * Tính năng tamper-evident:
 * - Hash chaining: mỗi bản ghi liên kết mật mã với bản ghi trước
 * - Disk anchor: nối `{ seq, hash, ts }` vào `.vyen/audit/anchor.log`
 * - Retention cap: giới hạn 50,000 bản ghi
 * - verifyChain(): quét và phát hiện mọi thay đổi hoặc đứt gãy trong chuỗi
 */

import { db, type StoredAuditLogEntry, type AuditActionType, type AuditDecisionType } from '@/lib/db';
import { redactSecretsDeep, redactSecretText } from '@/lib/secret-registry';

export type { StoredAuditLogEntry, AuditActionType, AuditDecisionType };

export const AUDIT_LOG_RETENTION_CAP = 50_000;

/**
 * Deterministic JSON stringifier sorting object keys recursively.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === undefined) {
    return 'null';
  }
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj) ?? 'null';
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => canonicalJson(item === undefined ? null : item)).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];
  for (const key of keys) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== undefined) {
      entries.push(JSON.stringify(key) + ':' + canonicalJson(val));
    }
  }
  return '{' + entries.join(',') + '}';
}

/**
 * Computes SHA-256 hex digest across Browser and Node environments.
 */
export async function sha256Hex(text: string): Promise<string> {
  // Check Browser subtle crypto first when window is present
  if (typeof window !== 'undefined' && globalThis.crypto?.subtle) {
    try {
      const buffer = new TextEncoder().encode(text);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // Fallback
    }
  }

  // Node.js environment
  if (typeof process !== 'undefined' && process.versions?.node) {
    try {
      const { createHash } = await import('node:crypto');
      return createHash('sha256').update(text, 'utf8').digest('hex');
    } catch {
      // Fallback
    }
  }

  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    try {
      const buffer = new TextEncoder().encode(text);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {
      // Fallback
    }
  }

  // Fallback FNV-1a 64-bit if crypto is unavailable
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619);
    h2 = Math.imul(h2 ^ (code << 1), 314159265);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return (hex1 + hex2).repeat(4).slice(0, 64);
}

/**
 * Tính băm SHA-256 của payload một cách an toàn trên cả Browser và Node.js.
 */
export async function computePayloadHash(payload: unknown): Promise<string> {
  if (payload === undefined || payload === null) return '';
  const text = typeof payload === 'string' ? payload : canonicalJson(payload);
  return await sha256Hex(text);
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
 * Đường dẫn anchor chuẩn — NGOÀI workspace (P0.5 S3, residual B3(a)).
 *
 * Anchor cùng nằm trong workspace thì người/agent sở hữu workspace cũng sở hữu
 * anchor: xoá `.vyen/audit/anchor.log` là mất toàn bộ dấu vết. Anchor giờ nằm
 * ở `~/.vyen/audit/anchor.log` — ngoài tầm ghi file của agent. Có thể override
 * bằng biến môi trường cho người dùng muốn giữ ở nơi khác (vd ổ USB).
 */
export function getDiskAnchorPath(): string {
  const override =
    typeof process !== 'undefined' && process.env
      ? process.env.VYEN_AUDIT_ANCHOR_PATH
      : undefined;
  if (override) return override;
  const home =
    typeof process !== 'undefined' && process.env
      ? (process.env.VYEN_HOME_DIR ?? process.env.HOME ?? process.env.USERPROFILE ?? process.cwd())
      : '.';
  const dir = home.replace(/[/\\]$/, '');
  return `${dir}${sep()}vyen${sep()}audit${sep()}anchor.log`;
}

function sep(): string {
  return typeof process !== 'undefined' && process.platform === 'win32' ? '\\' : '/';
}

/**
 * Append disk anchor log entry to `~/.vyen/audit/anchor.log` (ngoài workspace),
 * hoặc `customPath` nếu caller truyền.
 */
export async function appendDiskAnchor(
  anchor: { seq: number; hash: string; ts: number },
  customPath?: string,
): Promise<void> {
  try {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const logFile = customPath || getDiskAnchorPath();
      await fs.mkdir(path.dirname(logFile), { recursive: true });
      await fs.appendFile(logFile, JSON.stringify(anchor) + '\n', 'utf8');
      return;
    }
  } catch (err) {
    // Node fs failed or not available
  }

  // Desktop bridge fallback when running in desktop app web view
  try {      if (typeof window !== 'undefined') {
        const { isVyenDesktop } = await import('@/lib/desktop-bridge');
        if (isVyenDesktop()) {
          const { desktopFsWrite, desktopFsRead } = await import('@/lib/desktop-fs');
          // Desktop bridge bị jail trong workspace nên không ghi được ngoài root:
          // vẫn ghi anchor trong `.vyen/audit/` (kèm giới hạn đã ghi ở J.1/B3).
          const relativeLogPath = customPath || '.vyen/audit/anchor.log';
          let existing = '';
          try {
            const r = await desktopFsRead(relativeLogPath);
            if (r?.content) existing = r.content;
          } catch {
            // File does not exist yet
          }
          await desktopFsWrite(relativeLogPath, existing + JSON.stringify(anchor) + '\n');
        }
      }
  } catch (err) {
    console.warn('[audit-log] Ghi anchor log ra đĩa thất bại:', err);
  }
}

/**
 * Prune audit log entries older than retention limit.
 */
export async function pruneAuditLogs(maxEntries: number = AUDIT_LOG_RETENTION_CAP): Promise<number> {
  try {
    const totalCount = await db.auditLogs.count();
    if (totalCount <= maxEntries) return 0;
    const excess = totalCount - maxEntries;
    const toPrune = await db.auditLogs.orderBy('seq').limit(excess).toArray();
    const ids = toPrune.map((e) => e.id);
    await db.auditLogs.bulkDelete(ids);
    return ids.length;
  } catch (err) {
    console.warn('[audit-log] Pruning audit log thất bại:', err);
    return 0;
  }
}

/** Sequential lock queue ensuring atomic sequential execution for recordAuditLog */
let auditQueue: Promise<unknown> = Promise.resolve();

/**
 * Ghi một bản ghi nhật ký kiểm toán mới (append-only) với Hash Chain và Redaction.
 * Các lượt gọi đồng thời được tuần tự hóa để bảo đảm tính toàn vẹn chuỗi số thứ tự và băm.
 */
export function recordAuditLog(params: RecordAuditLogParams): Promise<StoredAuditLogEntry> {
  const execute = async (): Promise<StoredAuditLogEntry> => {
    let lastEntry: StoredAuditLogEntry | null = null;
    try {
      lastEntry = (await db.auditLogs.orderBy('seq').last()) ?? null;
    } catch {
      // IndexedDB có thể chưa có index seq hoặc đang chạy trong test stub
    }

    const seq = (lastEntry?.seq ?? 0) + 1;
    const prevHash = lastEntry ? (lastEntry.hash ?? null) : null;

    // Redact secrets from payload, details, and target
    const redactedPayload = params.payload !== undefined ? redactSecretsDeep(params.payload) : undefined;
    const redactedDetails = params.details !== undefined ? redactSecretsDeep(params.details) : undefined;
    const redactedTarget = params.target !== undefined ? redactSecretText(params.target) : undefined;

    const payloadHash =
      params.payloadHash ?? (redactedPayload !== undefined ? await computePayloadHash(redactedPayload) : undefined);

    const id = newAuditId();
    const timestamp = Date.now();

    const body: Record<string, unknown> = {
      id,
      seq,
      timestamp,
      action: params.action,
      tool: params.tool,
      ...(redactedTarget !== undefined ? { target: redactedTarget } : {}),
      ...(payloadHash !== undefined ? { payloadHash } : {}),
      decision: params.decision,
      ...(params.chatId !== undefined ? { chatId: params.chatId } : {}),
      ...(redactedDetails !== undefined ? { details: redactedDetails } : {}),
    };

    const canonicalJsonBody = canonicalJson(body);
    const hash = await sha256Hex(`${prevHash ?? 'GENESIS'}\n${canonicalJsonBody}`);

    const entry: StoredAuditLogEntry = {
      ...body,
      prevHash,
      hash,
    } as StoredAuditLogEntry;

    try {
      await db.auditLogs.add(entry);
      const count = await db.auditLogs.count().catch(() => 0);
      if (count > AUDIT_LOG_RETENTION_CAP) {
        void pruneAuditLogs(AUDIT_LOG_RETENTION_CAP);
      }
    } catch (err) {
      console.warn('[audit-log] Ghi nhật ký kiểm toán thất bại:', err);
    }

    // Disk anchoring: append { seq, hash, ts } to .vyen/audit/anchor.log
    void appendDiskAnchor({ seq: entry.seq, hash: entry.hash, ts: entry.timestamp });

    return entry;
  };

  const nextPromise = auditQueue.then(execute, execute);
  auditQueue = nextPromise.catch(() => {});
  return nextPromise;
}

export interface ChainVerificationResult {
  valid: boolean;
  totalChecked: number;
  brokenSeq?: number;
  reason?: string;
  /**
   * Số bản ghi ĐÃ BỊ PRUNE ở đầu chuỗi (P0.5 S3, residual B3(b)).
   * `undefined` = không xác định; `0` = chuỗi đầy đủ từ genesis.
   */
  prunedBeforeSeq?: number;
  /**
   * Chuỗi bắt đầu từ seq > 1: `verifyChain` chỉ có thể xác nhận phần còn lại.
   * Đây là giới hạn thật của mô hình append-only + prune, KHÔNG phải lỗi.
   */
  partialChain?: boolean;
}

/**
 * Scan entries in order and detect any broken links or modified records.
 */
export async function verifyChain(entries?: StoredAuditLogEntry[]): Promise<ChainVerificationResult> {
  try {
    const list = entries ?? (await db.auditLogs.orderBy('seq').toArray());
    if (!list || list.length === 0) {
      return { valid: true, totalChecked: 0 };
    }

    /*
     * Chuỗi đã bị prune: bản ghi đầu tiên có `seq > 1`. Khi đó `prevHash` của nó
     * trỏ tới bản ghi KHÔNG còn trong DB nên không thể kiểm chứng giá trị đó —
     * đây là giới hạn thật của việc cắt đầu chuỗi, không phải hư hỏng. Ta
     * đánh dấu `partialChain` để UI/caller biết chỉ phần còn lại được xác nhận.
     * Mọi liên kết TỪ bản ghi thứ hai trở đi vẫn phải khớp tuyệt đối.
     */
    const prunedBeforeSeq = list[0].seq > 1 ? list[0].seq - 1 : undefined;
    const partialChain = prunedBeforeSeq !== undefined;

    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      const prevEntry = i > 0 ? list[i - 1] : null;

      // 1. Check sequence number validity
      if (typeof entry.seq !== 'number' || entry.seq < 1) {
        return {
          valid: false,
          totalChecked: i,
          brokenSeq: entry.seq,
          reason: `Số thứ tự (seq) không hợp lệ tại vị trí ${i}: ${entry.seq}`,
        };
      }

      if (!entry.hash || typeof entry.hash !== 'string' || entry.hash.length !== 64) {
        return {
          valid: false,
          totalChecked: i,
          brokenSeq: entry.seq,
          reason: `Mã băm (hash) không hợp lệ tại seq ${entry.seq}`,
        };
      }

      // 2. Check sequence ordering and prevHash linking
      if (i === 0) {
        if (entry.seq === 1 && entry.prevHash !== null) {
          return {
            valid: false,
            totalChecked: i,
            brokenSeq: entry.seq,
            reason: `Bản ghi đầu tiên (seq 1) có prevHash không hợp lệ: ${entry.prevHash}`,
            ...(partialChain ? { prunedBeforeSeq, partialChain } : {}),
          };
        }
        // Chuỗi đã prune: prevHash phải khác null — nếu null thì có thể là
        // bản ghi đầu tiên bị xoá rồi giả mạo thành genesis mới.
        if (partialChain && entry.prevHash === null) {
          return {
            valid: false,
            totalChecked: i,
            brokenSeq: entry.seq,
            reason:
              `Chuỗi bắt đầu từ seq ${entry.seq} (đã prune) nhưng bản ghi đầu có prevHash = null — ` +
              `không thể phân biệt với genesis giả mạo.`,
            prunedBeforeSeq,
            partialChain: true,
          };
        }
      } else if (prevEntry) {
        if (entry.seq !== prevEntry.seq + 1) {
          return {
            valid: false,
            totalChecked: i,
            brokenSeq: entry.seq,
            reason: `Đứt gãy chuỗi số thứ tự: seq ${entry.seq} sau seq ${prevEntry.seq}`,
            ...(partialChain ? { prunedBeforeSeq, partialChain } : {}),
          };
        }
        if (entry.prevHash !== prevEntry.hash) {
          return {
            valid: false,
            totalChecked: i,
            brokenSeq: entry.seq,
            reason: `Liên kết băm bị phá vỡ tại seq ${entry.seq}: prevHash (${entry.prevHash}) != hash trước (${prevEntry.hash})`,
            ...(partialChain ? { prunedBeforeSeq, partialChain } : {}),
          };
        }
      }

      // 3. Recompute expected hash
      const body: Record<string, unknown> = {
        id: entry.id,
        seq: entry.seq,
        timestamp: entry.timestamp,
        action: entry.action,
        tool: entry.tool,
        ...(entry.target !== undefined ? { target: entry.target } : {}),
        ...(entry.payloadHash !== undefined ? { payloadHash: entry.payloadHash } : {}),
        decision: entry.decision,
        ...(entry.chatId !== undefined ? { chatId: entry.chatId } : {}),
        ...(entry.details !== undefined ? { details: entry.details } : {}),
      };
      const canonicalJsonBody = canonicalJson(body);
      const expectedHash = await sha256Hex(`${entry.prevHash ?? 'GENESIS'}\n${canonicalJsonBody}`);

      if (entry.hash !== expectedHash) {
        return {
          valid: false,
          totalChecked: i,
          brokenSeq: entry.seq,
          reason: `Phát hiện giả mạo tại seq ${entry.seq}: hash thực tế (${entry.hash}) != hash kỳ vọng (${expectedHash})`,
          ...(partialChain ? { prunedBeforeSeq, partialChain } : {}),
        };
      }
    }

    return {
      valid: true,
      totalChecked: list.length,
      ...(partialChain ? { prunedBeforeSeq, partialChain } : {}),
    };
  } catch (err) {
    return {
      valid: false,
      totalChecked: 0,
      reason: `Lỗi kiểm tra chuỗi: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const verifyAuditLogChain = verifyChain;

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
