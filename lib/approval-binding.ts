/**
 * Approval Binding — "ký đúng thứ đã xem" (P0.5 S3, chống B4).
 *
 * ## Vấn đề
 *
 * `ApprovalQueue` (`lib/approval-queue.ts`) trả về `boolean` cho caller. Giữa lúc
 * modal hiện và lúc caller dùng kết quả, có ba đường lệch payload:
 *
 * 1. **Re-render / đổi chat**: modal thuộc chat A, nhưng run tiếp tục ở chat B.
 * 2. **Retry / re-submit**: cùng một lệnh được duyệt lại nhưng args đã bị thay.
 * 3. **Stale approval**: token cấp lúc T, thực thi lúc T+30 phút (queue dài hạn,
 *    tab bị treo, session headless) — nội dung workspace đã đổi.
 *
 * Nguyên tắc: **approval chỉ có giá trị với đúng payload đã hiển thị, trong
 * hạn ngắn, và dùng đúng một lần.** Không có cơ chế này thì "đã duyệt" chỉ là
 * lời hứa của UI chứ không phải bằng chứng.
 *
 * ## Vì sao tự chứa, không import `lib/audit-log.ts`
 *
 * `audit-log` kéo theo Dexie (`@/lib/db`) — module này nằm trên đường phê duyệt
 * (mọi lệnh shell) và phải chạy được trong test node thuần, nên tự cài
 * canonical JSON + SHA-256. Giá trị hash phải GIỐNG HỆT giá trị audit log dùng
 * (canonical JSON sort key) để đối chiếu chéo được.
 *
 * ## Hợp đồng
 *
 * - `createApprovalToken(binding)`: ký `{fingerprint, kind, toolCallId, issuedAt}`.
 * - `verifyApprovalToken(token, expected)`: kiểm tra fingerprint + hạn + chưa dùng.
 * - `consumeApprovalToken(token, expected)`: verify + đánh dấu đã dùng (chống replay).
 */

import { createHash } from 'node:crypto';

/** Hạn mặc định của một approval: 10 phút. */
export const APPROVAL_TOKEN_TTL_MS = 10 * 60 * 1000;

export type ApprovalBindingKind = 'diff' | 'shell' | 'run_code';

export interface ApprovalBinding {
  /** Loại phê duyệt — một token không dùng chéo được cho loại khác. */
  kind: ApprovalBindingKind;
  /** Payload người dùng thực sự nhìn thấy (lệnh, cwd, diff, code). */
  payload: unknown;
  /** ID lời gọi tool nếu có — gắn approval vào đúng một tool call. */
  toolCallId?: string;
}

export interface ApprovalToken {
  /** Fingerprint của payload (hex SHA-256), là định danh phê duyệt. */
  fingerprint: string;
  kind: ApprovalBindingKind;
  toolCallId?: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ApprovalVerification {
  ok: boolean;
  reason?: string;
  /** Fingerprint token mang theo, để caller ghi vào audit log. */
  fingerprint?: string;
}

/**
 * Canonical JSON — sort key đệ quy, KHÔNG undefined, giống hệt `canonicalJson`
 * trong `lib/audit-log.ts`. Hai bản phải luôn cho cùng chuỗi với cùng input.
 */
export function canonicalizeForBinding(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalizeForBinding(item === undefined ? null : item)).join(',') + ']';
  }
  const entries: string[] = [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const val = (value as Record<string, unknown>)[key];
    if (val !== undefined) entries.push(JSON.stringify(key) + ':' + canonicalizeForBinding(val));
  }
  return '{' + entries.join(',') + '}';
}

/** SHA-256 hex của canonical payload. */
export function fingerprintPayload(payload: unknown): string {
  return createHash('sha256').update(canonicalizeForBinding(payload), 'utf8').digest('hex');
}

/** Token cấp rồi nhưng CHƯA dùng. Bị xoá khi hết hạn. */
const issuedTokens = new Map<string, ApprovalToken>();

function pruneExpired(now: number): void {
  for (const [token, meta] of issuedTokens) {
    if (meta.expiresAt <= now) issuedTokens.delete(token);
  }
}

/**
 * Cấp token cho một payload cụ thể. Trả về `null` nếu payload rỗng/undefined —
 * không có gì để duyệt thì không được tạo token trông như hợp lệ.
 */
export function createApprovalToken(
  binding: ApprovalBinding,
  now: number = Date.now(),
  ttlMs: number = APPROVAL_TOKEN_TTL_MS,
): ApprovalToken | null {
  if (binding.payload === undefined || binding.payload === null) return null;
  const fingerprint = fingerprintPayload({ kind: binding.kind, payload: binding.payload });
  const token: ApprovalToken = {
    fingerprint,
    kind: binding.kind,
    ...(binding.toolCallId ? { toolCallId: binding.toolCallId } : {}),
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  pruneExpired(now);
  issuedTokens.set(fingerprint, token);
  return token;
}

/** Token có tồn tại và còn hạn không (không kiểm tra payload). */
export function isApprovalTokenLive(fingerprint: string, now: number = Date.now()): boolean {
  const token = issuedTokens.get(fingerprint);
  return Boolean(token && token.expiresAt > now);
}

/**
 * Kiểm tra token khớp payload mong đợi. KHÔNG tiêu thụ token — dùng khi muốn
 * kiểm tra trước rồi mới quyết định duyệt hay từ chối.
 */
export function verifyApprovalToken(
  fingerprint: string,
  expected: ApprovalBinding,
  now: number = Date.now(),
): ApprovalVerification {
  const token = issuedTokens.get(fingerprint);
  if (!token) {
    return { ok: false, reason: 'approval_unknown' };
  }
  if (token.expiresAt <= now) {
    issuedTokens.delete(fingerprint);
    return { ok: false, reason: 'approval_expired' };
  }
  if (token.kind !== expected.kind) {
    return { ok: false, reason: 'approval_kind_mismatch', fingerprint };
  }
  if (expected.toolCallId !== undefined && token.toolCallId !== expected.toolCallId) {
    return { ok: false, reason: 'approval_tool_call_mismatch', fingerprint };
  }
  const expectedFingerprint = fingerprintPayload({ kind: expected.kind, payload: expected.payload });
  if (expectedFingerprint !== fingerprint) {
    return { ok: false, reason: 'approval_payload_drift', fingerprint };
  }
  return { ok: true, fingerprint };
}

/**
 * Verify + đánh dấu đã dùng. Đây là hàm caller phải gọi TRƯỚC khi thực thi.
 * Lần gọi thứ hai với cùng fingerprint luôn thất bại (chống replay).
 */
export function consumeApprovalToken(
  fingerprint: string,
  expected: ApprovalBinding,
  now: number = Date.now(),
): ApprovalVerification {
  const result = verifyApprovalToken(fingerprint, expected, now);
  if (!result.ok) return result;
  issuedTokens.delete(fingerprint);
  return result;
}

/** Xoá toàn bộ token đã cấp (test, đổi phiên). */
export function resetApprovalTokens(): void {
  issuedTokens.clear();
}
