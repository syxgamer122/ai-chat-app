/**
 * Approval Binding — "ký đúng thứ đã xem" (P0.5 S3, C-07 hardening).
 *
 * ## Vấn đề & Giải pháp (C-07)
 *
 * Token phê duyệt gắn chặt danh tính với:
 * - kind (shell, diff, run_code)
 * - canonical payload (lệnh, cwd, diff)
 * - toolCallId (chống dùng chéo giữa các tool call)
 * - chatId (chống va chạm giữa các subagent / phiên chat)
 * - workspaceFingerprint (chống thực thi nhầm workspace)
 * - unique nonce (loại bỏ token confusion khi hai subagent cùng gọi một lệnh)
 *
 * Module này cung cấp wrapper TypeScript cho lib/approval-binding.cjs dùng chung
 * với privileged IPC chokepoint (lib/ipc.cjs).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bindingImpl = require('./approval-binding.cjs');

/** Hạn mặc định của một approval: 10 phút. */
export const APPROVAL_TOKEN_TTL_MS: number = bindingImpl.APPROVAL_TOKEN_TTL_MS;

export type ApprovalBindingKind = 'diff' | 'shell' | 'run_code';

export interface ApprovalBinding {
  /** Loại phê duyệt — một token không dùng chéo được cho loại khác. */
  kind: ApprovalBindingKind;
  /** Payload người dùng thực sự nhìn thấy (lệnh, cwd, diff, code). */
  payload: unknown;
  /** ID lời gọi tool nếu có — gắn approval vào đúng một tool call (C-07). */
  toolCallId?: string;
  /** ID phiên chat / hội thoại sở hữu phê duyệt này (C-07). */
  chatId?: string;
  /** ID nhánh lá tích cực đang mở — ngăn áp dụng approval sang nhánh khác khi fork/chuyển nhánh (PR 3). */
  activeLeafId?: string;
  /** Hash SHA-256 base của file trước khi áp diff — bảo vệ TOCTOU (PR 3). */
  expectedBaseHash?: string;
  /** Fingerprint / định danh workspace nơi lệnh/diff được duyệt (C-07). */
  workspaceFingerprint?: string;
  /** Nonce ngẫu nhiên đảm bảo tính duy nhất tuyệt đối (C-07). */
  nonce?: string;
}

export interface ApprovalToken {
  /** Fingerprint của token (hex SHA-256), là định danh phê duyệt duy nhất. */
  fingerprint: string;
  payloadFingerprint?: string;
  kind: ApprovalBindingKind;
  toolCallId?: string;
  chatId?: string;
  activeLeafId?: string;
  expectedBaseHash?: string;
  workspaceFingerprint?: string;
  nonce?: string;
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
 * trong `lib/audit-log.ts`.
 */
export function canonicalizeForBinding(value: unknown): string {
  return bindingImpl.canonicalizeForBinding(value);
}

/** SHA-256 hex của canonical payload. */
export function fingerprintPayload(payload: unknown): string {
  return bindingImpl.fingerprintPayload(payload);
}

/**
 * Cấp token cho một payload cụ thể (C-07).
 */
export function createApprovalToken(
  binding: ApprovalBinding,
  now: number = Date.now(),
  ttlMs: number = APPROVAL_TOKEN_TTL_MS,
): ApprovalToken | null {
  return bindingImpl.createApprovalToken(binding, now, ttlMs);
}

/** Token có tồn tại và còn hạn không (không kiểm tra payload). */
export function isApprovalTokenLive(fingerprint: string, now: number = Date.now()): boolean {
  return bindingImpl.isApprovalTokenLive(fingerprint, now);
}

/**
 * Kiểm tra token khớp payload và danh tính mong đợi (chưa tiêu thụ).
 */
export function verifyApprovalToken(
  fingerprint: string,
  expected: ApprovalBinding,
  now: number = Date.now(),
): ApprovalVerification {
  return bindingImpl.verifyApprovalToken(fingerprint, expected, now);
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
  return bindingImpl.consumeApprovalToken(fingerprint, expected, now);
}

/** Xoá toàn bộ token đã cấp (test, đổi phiên). */
export function resetApprovalTokens(): void {
  bindingImpl.resetApprovalTokens();
}
