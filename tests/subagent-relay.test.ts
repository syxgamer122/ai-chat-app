/**
 * Tests cho subagent client-tool relay registry (lib/subagent-relay.ts).
 *
 * Covers:
 * - register → resolve: promise nhận đúng kết quả, entry bị dọn
 * - resolve call không tồn tại → false (stream đã đóng)
 * - timeout: promise resolve chuỗi lỗi JSON, không reject (loop subagent
 *   phải nhận lỗi mạch lạc thay vì treo)
 * - cancelSubagentRelays: tháo đúng request, không đụng request khác
 * - trùng id: call cũ nhận lỗi "thay thế", call mới hoạt động bình thường
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerSubagentRelay,
  resolveSubagentRelay,
  cancelSubagentRelays,
  pendingRelayCount,
  clearSubagentRelaysForTests,
  SUBAGENT_RELAY_TIMEOUT_MS,
} from '@/lib/subagent-relay';

const CALL = { toolCallId: 'emu-0-1', toolName: 'fs_read', args: { path: 'a.txt' } };

beforeEach(() => {
  clearSubagentRelaysForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('register + resolve', () => {
  it('resolve trả kết quả cho promise đang chờ và dọn entry', async () => {
    const p = registerSubagentRelay('req-1', CALL);
    expect(pendingRelayCount()).toBe(1);
    const ok = resolveSubagentRelay('req-1', 'emu-0-1', JSON.stringify({ content: 'nội dung' }));
    expect(ok).toBe(true);
    expect(await p).toBe(JSON.stringify({ content: 'nội dung' }));
    expect(pendingRelayCount()).toBe(0);
  });

  it('resolve call không tồn tại → false (id sai hoặc stream đã đóng)', () => {
    expect(resolveSubagentRelay('req-1', 'khong-co', 'x')).toBe(false);
  });

  it('key scope theo requestId — hai request trùng toolCallId không ăn nhau', async () => {
    const p1 = registerSubagentRelay('req-1', CALL);
    const p2 = registerSubagentRelay('req-2', CALL);
    expect(resolveSubagentRelay('req-2', 'emu-0-1', 'của req-2')).toBe(true);
    expect(await p2).toBe('của req-2');
    // req-1 vẫn chờ — resolve bằng key req-1
    expect(resolveSubagentRelay('req-1', 'emu-0-1', 'của req-1')).toBe(true);
    expect(await p1).toBe('của req-1');
  });
});

describe('timeout', () => {
  it('timeout resolve chuỗi lỗi JSON (không reject) và dọn entry', async () => {
    vi.useFakeTimers();
    const p = registerSubagentRelay('req-1', CALL, { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(51);
    const out = JSON.parse(await p);
    expect(out.error).toContain('fs_read');
    expect(pendingRelayCount()).toBe(0);
  });

  it('timeout mặc định là 180s', () => {
    expect(SUBAGENT_RELAY_TIMEOUT_MS).toBe(180_000);
  });

  it('abort signal resolve lỗi và không double-resolve khi timeout chạy sau', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const p = registerSubagentRelay('req-1', CALL, { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    const out = JSON.parse(await p);
    expect(out.error).toContain('dừng');
    // timeout sau đó không tạo resolve thứ hai — promise đã settle, an toàn.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(pendingRelayCount()).toBe(0);
  });
});

describe('cancelSubagentRelays', () => {
  it('tháo mọi call của đúng requestId, giữ nguyên call của request khác', async () => {
    const p1 = registerSubagentRelay('req-1', CALL);
    const p2 = registerSubagentRelay('req-1', { ...CALL, toolCallId: 'emu-1-1' });
    const pOther = registerSubagentRelay('req-2', CALL);
    expect(cancelSubagentRelays('req-1')).toBe(2);
    const out1 = JSON.parse(await p1);
    const out2 = JSON.parse(await p2);
    expect(out1.error).toContain('kết thúc');
    expect(out2.error).toContain('kết thúc');
    expect(pendingRelayCount()).toBe(1);
    resolveSubagentRelay('req-2', 'emu-0-1', 'ok');
    await pOther;
  });

  it('trùng id: call cũ nhận lỗi thay thế, call mới nhận kết quả thật', async () => {
    vi.useFakeTimers();
    const pOld = registerSubagentRelay('req-1', CALL);
    const pNew = registerSubagentRelay('req-1', CALL);
    const old = JSON.parse(await pOld);
    expect(old.error).toContain('thay thế');
    expect(resolveSubagentRelay('req-1', 'emu-0-1', 'kết quả mới')).toBe(true);
    expect(await pNew).toBe('kết quả mới');
  });
});
