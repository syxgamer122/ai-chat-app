import { describe, it, expect, beforeEach } from 'vitest';
import {
  APPROVAL_TOKEN_TTL_MS,
  canonicalizeForBinding,
  consumeApprovalToken,
  createApprovalToken,
  fingerprintPayload,
  isApprovalTokenLive,
  resetApprovalTokens,
  verifyApprovalToken,
} from '@/lib/approval-binding';
import { canonicalJson } from '@/lib/audit-log';

describe('Approval Binding — ký đúng thứ đã xem (B4)', () => {
  beforeEach(() => {
    resetApprovalTokens();
  });

  describe('canonical JSON khớp audit-log', () => {
    it('sort key đệ quy giống canonicalJson của audit log', () => {
      const samples: unknown[] = [
        { b: 1, a: 2 },
        { z: { y: 1, x: [3, { b: 1, a: 2 }] }, a: null },
        [{ k: 'v' }, 'x', 3, true, null],
        { undef: undefined, keep: 1 },
        'plain',
        42,
      ];
      for (const sample of samples) {
        expect(canonicalizeForBinding(sample)).toBe(canonicalJson(sample));
      }
    });
  });

  describe('fingerprint', () => {
    it('ổn định và phân biệt payload khác nhau', () => {
      const a = { command: 'ls -la', cwd: 'src' };
      const b = { command: 'ls -la', cwd: 'lib' };
      expect(fingerprintPayload(a)).toBe(fingerprintPayload({ cwd: 'src', command: 'ls -la' }));
      expect(fingerprintPayload(a)).not.toBe(fingerprintPayload(b));
    });

    it('là SHA-256 hex 64 ký tự', () => {
      expect(fingerprintPayload({ command: 'ls' })).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('createApprovalToken', () => {
    it('cấp token với fingerprint, hạn và loại', () => {
      const now = 1_000_000;
      const token = createApprovalToken({ kind: 'shell', payload: { command: 'npm test' } }, now);
      expect(token).not.toBeNull();
      expect(token?.kind).toBe('shell');
      expect(token?.issuedAt).toBe(now);
      expect(token?.expiresAt).toBe(now + APPROVAL_TOKEN_TTL_MS);
    });

    it('trả null cho payload rỗng — không có gì để duyệt', () => {
      expect(createApprovalToken({ kind: 'shell', payload: undefined })).toBeNull();
      expect(createApprovalToken({ kind: 'shell', payload: null })).toBeNull();
    });

    it('ttl tuỳ biến được', () => {
      const token = createApprovalToken({ kind: 'shell', payload: { command: 'ls' } }, 0, 1234);
      expect(token?.expiresAt).toBe(1234);
    });
  });

  describe('verifyApprovalToken — chống lệch payload', () => {
    it('chấp nhận đúng payload đã duyệt', () => {
      const token = createApprovalToken({ kind: 'shell', payload: { command: 'ls', cwd: 'src' } })!;
      const verdict = verifyApprovalToken(token.fingerprint, {
        kind: 'shell',
        payload: { command: 'ls', cwd: 'src' },
      });
      expect(verdict.ok).toBe(true);
    });

    it('TỪ CHỐI khi payload đổi sau lúc duyệt (duyệt A, chạy B)', () => {
      const token = createApprovalToken({ kind: 'shell', payload: { command: 'ls', cwd: 'src' } })!;
      const verdict = verifyApprovalToken(token.fingerprint, {
        kind: 'shell',
        payload: { command: 'rm -rf .', cwd: 'src' },
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe('approval_payload_drift');
    });

    it('TỪ CHỐI khi cwd đổi', () => {
      const token = createApprovalToken({ kind: 'shell', payload: { command: 'ls', cwd: 'src' } })!;
      const verdict = verifyApprovalToken(token.fingerprint, {
        kind: 'shell',
        payload: { command: 'ls', cwd: '../outside' },
      });
      expect(verdict.reason).toBe('approval_payload_drift');
    });

    it('TỪ CHỐI khi loại phê duyệt khác (token shell không dùng cho diff)', () => {
      const token = createApprovalToken({ kind: 'shell', payload: { command: 'ls' } })!;
      const verdict = verifyApprovalToken(token.fingerprint, { kind: 'diff', payload: { command: 'ls' } });
      expect(verdict.reason).toBe('approval_kind_mismatch');
    });

    it('TỪ CHỐI khi token không tồn tại', () => {
      expect(verifyApprovalToken('deadbeef', { kind: 'shell', payload: { command: 'ls' } }).reason).toBe(
        'approval_unknown',
      );
    });

    it('TỪ CHỐI token quá hạn và xoá luôn khỏi registry', () => {
      const now = 5_000;
      const token = createApprovalToken({ kind: 'shell', payload: { command: 'ls' } }, now, 1000)!;
      expect(verifyApprovalToken(token.fingerprint, { kind: 'shell', payload: { command: 'ls' } }, now + 500).ok).toBe(true);
      const late = verifyApprovalToken(token.fingerprint, { kind: 'shell', payload: { command: 'ls' } }, now + 2000);
      expect(late.reason).toBe('approval_expired');
      expect(isApprovalTokenLive(token.fingerprint, now + 2000)).toBe(false);
    });

    it('không dùng chéo token giữa hai toolCallId', () => {
      const token = createApprovalToken({
        kind: 'shell',
        payload: { command: 'ls' },
        toolCallId: 'call-1',
      })!;
      expect(
        verifyApprovalToken(token.fingerprint, { kind: 'shell', payload: { command: 'ls' }, toolCallId: 'call-1' }).ok,
      ).toBe(true);
      const wrong = verifyApprovalToken(token.fingerprint, {
        kind: 'shell',
        payload: { command: 'ls' },
        toolCallId: 'call-2',
      });
      expect(wrong.reason).toBe('approval_tool_call_mismatch');
    });
  });

  describe('consumeApprovalToken — dùng đúng một lần', () => {
    it('lần đầu ok, lần hai bị từ chối (chống replay)', () => {
      const token = createApprovalToken({ kind: 'shell', payload: { command: 'ls' } })!;
      expect(consumeApprovalToken(token.fingerprint, { kind: 'shell', payload: { command: 'ls' } }).ok).toBe(true);
      expect(consumeApprovalToken(token.fingerprint, { kind: 'shell', payload: { command: 'ls' } }).ok).toBe(false);
    });

    it('consume KHÔNG tiêu token nếu payload lệch', () => {
      const token = createApprovalToken({ kind: 'shell', payload: { command: 'ls' } })!;
      expect(consumeApprovalToken(token.fingerprint, { kind: 'shell', payload: { command: 'pwd' } }).ok).toBe(false);
      // Token còn sống để hỏi lại đúng lệnh.
      expect(isApprovalTokenLive(token.fingerprint)).toBe(true);
    });

    it('verify KHÔNG tiêu token — có thể kiểm tra nhiều lần trước khi chạy', () => {
      const token = createApprovalToken({ kind: 'shell', payload: { command: 'ls' } })!;
      expect(verifyApprovalToken(token.fingerprint, { kind: 'shell', payload: { command: 'ls' } }).ok).toBe(true);
      expect(verifyApprovalToken(token.fingerprint, { kind: 'shell', payload: { command: 'ls' } }).ok).toBe(true);
      expect(consumeApprovalToken(token.fingerprint, { kind: 'shell', payload: { command: 'ls' } }).ok).toBe(true);
    });
  });

  describe('đa lượt song song', () => {
    it('token của lượt trước không bị lượt sau ghi đè khi payload khác', () => {
      const first = createApprovalToken({ kind: 'shell', payload: { command: 'ls' } })!;
      const second = createApprovalToken({ kind: 'shell', payload: { command: 'pwd' } })!;
      expect(first.fingerprint).not.toBe(second.fingerprint);
      expect(consumeApprovalToken(first.fingerprint, { kind: 'shell', payload: { command: 'ls' } }).ok).toBe(true);
      expect(consumeApprovalToken(second.fingerprint, { kind: 'shell', payload: { command: 'pwd' } }).ok).toBe(true);
    });
  });
});
