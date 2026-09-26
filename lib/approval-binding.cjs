'use strict';

/**
 * Approval Binding — "ký đúng thứ đã xem" (P0.5 S3, C-07 hardening).
 *
 * Tầng thực thi CommonJS phục vụ cho cả privileged IPC chokepoint (lib/ipc.cjs)
 * và frontend React / TypeScript runtime (lib/approval-binding.ts).
 */

const crypto = require('node:crypto');

/** Hạn mặc định của một approval: 10 phút. */
const APPROVAL_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Canonical JSON — sort key đệ quy, KHÔNG undefined, giống hệt `canonicalJson`
 * trong `lib/audit-log.ts`.
 */
function canonicalizeForBinding(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalizeForBinding(item === undefined ? null : item)).join(',') + ']';
  }
  const entries = [];
  for (const key of Object.keys(value).sort()) {
    const val = value[key];
    if (val !== undefined) entries.push(JSON.stringify(key) + ':' + canonicalizeForBinding(val));
  }
  return '{' + entries.join(',') + '}';
}

/** SHA-256 hex của canonical payload. */
function fingerprintPayload(payload) {
  return crypto.createHash('sha256').update(canonicalizeForBinding(payload), 'utf8').digest('hex');
}

/** Token cấp rồi nhưng CHƯA dùng. Bị xoá khi hết hạn hoặc khi consume. */
const issuedTokens = new Map();

/** Token ĐÃ dùng (lưu vết để phát hiện replay attack chính xác). */
const consumedTokens = new Map();

function pruneExpired(now) {
  for (const [token, meta] of issuedTokens) {
    if (meta.expiresAt <= now) issuedTokens.delete(token);
  }
  for (const [token, consumedAt] of consumedTokens) {
    if (now - consumedAt > APPROVAL_TOKEN_TTL_MS * 2) consumedTokens.delete(token);
  }
}

/**
 * Cấp token cho một payload cụ thể (C-07).
 * Gắn chặt token với:
 * - kind (shell, diff, run_code)
 * - payloadFingerprint
 * - toolCallId (ngăn dùng chéo giữa các tool call)
 * - chatId (ngăn dùng chéo giữa các phiên chat/subagent)
 * - activeLeafId (ngăn áp dụng approval sang nhánh khác khi fork/chuyển nhánh - PR 3)
 * - expectedBaseHash (ngăn ghi đè khi file bị sửa đổi ngoài luồng - TOCTOU guard - PR 3)
 * - workspaceFingerprint (ngăn dùng chéo workspace)
 * - nonce ngẫu nhiên (triệt tiêu va chạm khi 2 subagent cùng chạy 1 lệnh)
 */
function createApprovalToken(binding, now = Date.now(), ttlMs = APPROVAL_TOKEN_TTL_MS) {
  if (!binding || binding.payload === undefined || binding.payload === null) return null;

  const payloadFingerprint = fingerprintPayload({ kind: binding.kind, payload: binding.payload });
  const nonce = binding.nonce || crypto.randomBytes(16).toString('hex');

  // Token ID duy nhất và có tính định danh chặt chẽ
  const tokenFingerprint = fingerprintPayload({
    kind: binding.kind,
    payloadFingerprint,
    toolCallId: binding.toolCallId ?? null,
    chatId: binding.chatId ?? null,
    activeLeafId: binding.activeLeafId ?? null,
    expectedBaseHash: binding.expectedBaseHash ?? null,
    workspaceFingerprint: binding.workspaceFingerprint ?? null,
    nonce,
  });

  const token = {
    fingerprint: tokenFingerprint,
    payloadFingerprint,
    kind: binding.kind,
    ...(binding.toolCallId ? { toolCallId: binding.toolCallId } : {}),
    ...(binding.chatId ? { chatId: binding.chatId } : {}),
    ...(binding.activeLeafId ? { activeLeafId: binding.activeLeafId } : {}),
    ...(binding.expectedBaseHash ? { expectedBaseHash: binding.expectedBaseHash } : {}),
    ...(binding.workspaceFingerprint ? { workspaceFingerprint: binding.workspaceFingerprint } : {}),
    nonce,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };

  pruneExpired(now);
  issuedTokens.set(tokenFingerprint, token);
  return token;
}

/** Token có tồn tại và còn hạn không. */
function isApprovalTokenLive(fingerprint, now = Date.now()) {
  const token = issuedTokens.get(fingerprint);
  return Boolean(token && token.expiresAt > now);
}

/**
 * Kiểm tra token khớp payload và định danh mong đợi (chưa tiêu thụ).
 */
function verifyApprovalToken(fingerprint, expected, now = Date.now()) {
  if (!expected || typeof expected !== 'object') {
    return { ok: false, reason: 'approval_invalid_expected' };
  }
  if (!fingerprint || typeof fingerprint !== 'string') {
    return { ok: false, reason: 'approval_invalid_token' };
  }
  if (consumedTokens.has(fingerprint)) {
    return { ok: false, reason: 'approval_replayed', fingerprint };
  }

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
  if ((expected.toolCallId !== undefined || token.toolCallId !== undefined) && token.toolCallId !== expected.toolCallId) {
    return { ok: false, reason: 'approval_tool_call_mismatch', fingerprint };
  }
  if ((expected.chatId !== undefined || token.chatId !== undefined) && token.chatId !== expected.chatId) {
    return { ok: false, reason: 'approval_chat_mismatch', fingerprint };
  }
  if ((expected.activeLeafId !== undefined || token.activeLeafId !== undefined) && token.activeLeafId !== expected.activeLeafId) {
    return { ok: false, reason: 'approval_leaf_mismatch', fingerprint };
  }
  if ((expected.expectedBaseHash !== undefined || token.expectedBaseHash !== undefined) && token.expectedBaseHash !== expected.expectedBaseHash) {
    return { ok: false, reason: 'approval_base_hash_mismatch', fingerprint };
  }
  if (
    (expected.workspaceFingerprint !== undefined || token.workspaceFingerprint !== undefined) &&
    token.workspaceFingerprint !== expected.workspaceFingerprint
  ) {
    return { ok: false, reason: 'approval_workspace_mismatch', fingerprint };
  }
  if (expected.nonce !== undefined && token.nonce !== expected.nonce) {
    return { ok: false, reason: 'approval_nonce_mismatch', fingerprint };
  }

  const expectedPayloadFingerprint = fingerprintPayload({ kind: expected.kind, payload: expected.payload });
  if (expectedPayloadFingerprint !== token.payloadFingerprint) {
    return { ok: false, reason: 'approval_payload_drift', fingerprint };
  }

  return { ok: true, fingerprint };
}

/**
 * Verify + tiêu thụ token (dùng đúng 1 lần, chống replay).
 */
function consumeApprovalToken(fingerprint, expected, now = Date.now()) {
  const result = verifyApprovalToken(fingerprint, expected, now);
  if (!result.ok) return result;
  issuedTokens.delete(fingerprint);
  consumedTokens.set(fingerprint, now);
  return result;
}

/** Xoá toàn bộ token đã cấp và đã dùng (cho test / reset phiên). */
function resetApprovalTokens() {
  issuedTokens.clear();
  consumedTokens.clear();
}

module.exports = {
  APPROVAL_TOKEN_TTL_MS,
  canonicalizeForBinding,
  fingerprintPayload,
  createApprovalToken,
  isApprovalTokenLive,
  verifyApprovalToken,
  consumeApprovalToken,
  resetApprovalTokens,
};
