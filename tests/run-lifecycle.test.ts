/**
 * Test cho bộ máy vòng đời run.
 *
 * Module này quyết định CÓ GIẾT một câu trả lời đang chạy hay không, nên sai
 * một nhánh là người dùng mất kết quả thật. Mọi nhánh của `reconcile` đều
 * được phủ — đặc biệt hai nhánh dễ sai nhất: stalled khi không có gì để sửa
 * (phải dừng) và stalled khi có continuation (phải thử lại, có trần).
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_REPAIR_ATTEMPTS,
  ORPHAN_GRACE_MS,
  REPAIR_BACKOFF_BASE_MS,
  REPAIR_BACKOFF_CEIL_MS,
  RUN_DEADLINE_MS,
  STARTUP_GRACE_MS,
  STALL_TIMEOUT_MS,
  backoffDelay,
  beginRun,
  describeRun,
  isTerminal,
  markAwaitingUser,
  markFailed,
  markSucceeded,
  newRun,
  parseRunState,
  reconcile,
  reconcileOnBoot,
  recordRepair,
  requestStop,
  resumeFromUser,
  serializeRunState,
  setCanRepair,
  touchProgress,
  type RunLifecycle,
} from '@/lib/run-lifecycle';

const T0 = 1_700_000_000_000;

/** Run đã bắt đầu tại T0, đang ở trạng thái `starting`. */
function started(): RunLifecycle {
  return beginRun(newRun('r1', T0), T0);
}

describe('chuyển trạng thái cơ bản', () => {
  it('newRun nằm yên ở idle và không cho sửa', () => {
    const s = newRun('r1', T0);
    expect(s.observed).toBe('idle');
    expect(s.canRepair).toBe(false);
    expect(s.repairAttempts).toBe(0);
  });

  it('beginRun chỉ có tác dụng khi đang idle', () => {
    const s = started();
    expect(s.observed).toBe('starting');

    // Gọi lần nữa không được tạo run mới đè lên run đang chạy.
    expect(beginRun(s, T0 + 1)).toBe(s);
  });

  it('touchProgress đưa starting → running và dời mốc tiến triển', () => {
    const s = touchProgress(started(), T0 + 5_000);
    expect(s.observed).toBe('running');
    expect(s.lastProgressAt).toBe(T0 + 5_000);
  });

  it('touchProgress bỏ qua run đã kết thúc', () => {
    const done = markSucceeded(touchProgress(started(), T0 + 1_000), T0 + 2_000);
    expect(touchProgress(done, T0 + 3_000)).toBe(done);
  });

  it('trạng thái terminal là bất biến với mọi lệnh', () => {
    const done = markSucceeded(started(), T0 + 1_000);
    expect(isTerminal(done.observed)).toBe(true);
    expect(beginRun(done, T0 + 2_000)).toBe(done);
    expect(requestStop(done, T0 + 2_000)).toBe(done);
    expect(markAwaitingUser(done, T0 + 2_000)).toBe(done);
  });
});

describe('reconcile — các nhánh điều khiển', () => {
  it('idle + muốn chạy → báo caller gửi request', () => {
    const { action } = reconcile(newRun('r1', T0), T0);
    expect(action).toEqual({ kind: 'start' });
  });

  it('người dùng bấm dừng thắng tuyệt đối', () => {
    // Đang stream khoẻ mạnh, nhưng desired=stopped vẫn phải dừng ngay.
    const running = touchProgress(started(), T0 + 1_000);
    const { action, next } = reconcile(requestStop(running, T0 + 2_000), T0 + 2_000);
    expect(action).toEqual({ kind: 'terminate', reason: 'user_stop' });
    expect(next.observed).toBe('terminated');
    expect(next.terminalReason).toBe('user_stop');
  });

  it('run khoẻ → chỉ hẹn giờ xem lại, không động vào state', () => {
    const running = touchProgress(started(), T0 + 1_000);
    const res = reconcile(running, T0 + 5_000);
    expect(res.action.kind).toBe('watch');
    expect(res.next).toBe(running);
  });

  it('im lặng quá STARTUP_GRACE → đánh dấu stalled', () => {
    const res = reconcile(started(), T0 + STARTUP_GRACE_MS + 1);
    expect(res.next.observed).toBe('stalled');
    // Chuyển sang stalled chưa ra quyết định — quyết định ở nhịp sau.
    expect(res.action.kind).toBe('none');
  });

  it('đã có token thì dùng STALL_TIMEOUT, không dùng STARTUP_GRACE', () => {
    const running = touchProgress(started(), T0 + 1_000);
    const tooEarly = reconcile(running, T0 + 1_000 + STALL_TIMEOUT_MS - 1);
    expect(tooEarly.next.observed).toBe('running');

    const tooLate = reconcile(running, T0 + 1_000 + STALL_TIMEOUT_MS + 1);
    expect(tooLate.next.observed).toBe('stalled');
  });

  it('chờ người dùng phê duyệt thì KHÔNG bị tính là stalled', () => {
    const waiting = markAwaitingUser(started(), T0 + 1_000);
    // Im lặng lâu vượt cả hai ngưỡng — vẫn không được giết.
    const res = reconcile(waiting, T0 + 1_000 + STALL_TIMEOUT_MS * 3);
    expect(res.next.observed).toBe('awaiting_user');
    expect(res.action.kind).toBe('watch');
  });

  it('vượt trần cứng thì dừng dù vẫn đang có heartbeat', () => {
    const running = touchProgress(started(), T0 + 60_000);
    const res = reconcile(running, T0 + RUN_DEADLINE_MS + 1);
    expect(res.action).toEqual({ kind: 'terminate', reason: 'deadline' });
    expect(res.next.terminalReason).toBe('deadline');
  });
});

describe('reconcile — vòng lặp tự sửa', () => {
  /** Run đang stalled, im lặng đã lâu, có quyền sửa. */
  function stalledRepairable(): RunLifecycle {
    const idleAfterStall = reconcile(started(), T0 + STARTUP_GRACE_MS + 1).next;
    return setCanRepair(idleAfterStall, true, T0 + STARTUP_GRACE_MS + 1);
  }

  it('KHÔNG có quyền sửa → dừng luôn, không được treo chờ', () => {
    const stalled = reconcile(started(), T0 + STARTUP_GRACE_MS + 1).next;
    expect(stalled.canRepair).toBe(false);

    const res = reconcile(stalled, T0 + STARTUP_GRACE_MS + 2);
    expect(res.action).toEqual({ kind: 'terminate', reason: 'stalled' });
    expect(res.next.observed).toBe('terminated');
  });

  it('có quyền sửa → yêu cầu sửa lần 1', () => {
    const stalled = stalledRepairable();
    const res = reconcile(stalled, T0 + STARTUP_GRACE_MS + 2);
    expect(res.action).toEqual({ kind: 'repair', attempt: 1, afterMs: expect.any(Number) });
  });

  it('lần sửa kế tiếp phải chờ đủ backoff', () => {
    let s = stalledRepairable();
    const now1 = T0 + STARTUP_GRACE_MS + 2;
    s = recordRepair(s, now1);

    // Quay lại stalled (lần sửa vừa rồi không cứu được).
    s = { ...s, observed: 'stalled' };

    const tooSoon = reconcile(s, now1 + REPAIR_BACKOFF_BASE_MS - 1);
    expect(tooSoon.action.kind).toBe('watch');

    const later = reconcile(s, now1 + REPAIR_BACKOFF_BASE_MS + 1);
    expect(later.action.kind).toBe('repair');
    expect(later.action).toMatchObject({ attempt: 2 });
  });

  it('hết lượt sửa thì bỏ cuộc, không lặp vô hạn', () => {
    let s = stalledRepairable();
    let now = T0 + STARTUP_GRACE_MS + 2;

    for (let i = 1; i <= MAX_REPAIR_ATTEMPTS; i++) {
      const res = reconcile(s, now);
      expect(res.action.kind).toBe('repair');
      expect(res.action).toMatchObject({ attempt: i });
      s = recordRepair(s, now);
      s = { ...s, observed: 'stalled' };
      now += REPAIR_BACKOFF_CEIL_MS + 1;
    }

    const giveUp = reconcile(s, now);
    expect(giveUp.action).toEqual({ kind: 'terminate', reason: 'stalled_give_up' });
    expect(giveUp.next.terminalReason).toBe('stalled_give_up');
  });

  it('backoff tăng gấp đôi và bị kẹp bởi trần', () => {
    expect(backoffDelay(0)).toBe(REPAIR_BACKOFF_BASE_MS);
    expect(backoffDelay(1)).toBe(REPAIR_BACKOFF_BASE_MS);
    expect(backoffDelay(2)).toBe(REPAIR_BACKOFF_BASE_MS * 2);
    expect(backoffDelay(3)).toBe(REPAIR_BACKOFF_BASE_MS * 4);
    expect(backoffDelay(10)).toBe(REPAIR_BACKOFF_CEIL_MS);
  });
});

describe('kết thúc & nhãn hiển thị', () => {
  it('settle trả canRepair về false để run sau không thừa quyền', () => {
    const running = setCanRepair(touchProgress(started(), T0 + 1_000), true, T0 + 1_000);
    const done = markSucceeded(running, T0 + 2_000);
    expect(done.canRepair).toBe(false);
    expect(done.terminalReason).toBe('completed');
  });

  it('lỗi rõ ràng từ upstream → failed', () => {
    const done = markFailed(touchProgress(started(), T0 + 1_000), T0 + 2_000);
    expect(done.observed).toBe('failed');
    expect(done.terminalReason).toBe('error');
  });

  it('nhãn stalled đếm từ lần tiến triển CUỐI, không phải lúc thành stalled', () => {
    // Run bắt đầu ở T0, chưa nhận token nào → lastProgressAt vẫn là T0.
    const stalled = reconcile(started(), T0 + STARTUP_GRACE_MS + 1).next;
    const view = describeRun(stalled, T0 + STARTUP_GRACE_MS + 1 + 7_000);
    // 25s (grace) + 7s = 32s kể từ T0. Đếm từ lúc observed đổi sang stalled
    // thì chỉ ra 7s — sai, vì người dùng quan tâm đã chờ tổng cộng bao lâu.
    expect(view.label).toBe('Không có phản hồi (32s)');
    expect(view.tone).toBe('warn');
    expect(view.busy).toBe(true);
  });

  it('nhãn phân biệt được từng lý do kết thúc', () => {
    const base = touchProgress(started(), T0 + 1_000);
    expect(describeRun(markSucceeded(base, T0 + 2_000), T0 + 2_000).label).toBe('Hoàn tất');
    expect(describeRun(markFailed(base, T0 + 2_000), T0 + 2_000).label).toBe('Lỗi');
    expect(describeRun(requestStop(base, T0 + 2_000), T0 + 2_000).tone).toBe('active'); // chờ reconcile
  });

  it('resumeFromUser đưa awaiting_user về running và xoá lượt sửa cũ', () => {
    let s = markAwaitingUser(started(), T0 + 1_000);
    s = recordRepair(s, T0 + 1_500);
    s = resumeFromUser(s, T0 + 2_000);
    expect(s.observed).toBe('running');
    expect(s.repairAttempts).toBe(0);
    expect(s.lastRepairAt).toBeNull();
  });
});

describe('lưu & khôi phục qua kv', () => {
  it('vòng tròn serialize → parse giữ nguyên state', () => {
    const s = recordRepair(setCanRepair(started(), true, T0 + 1_000), T0 + 1_500);
    expect(parseRunState(serializeRunState(s))).toEqual(s);
  });

  it('rác / sai shape → null, không đoán', () => {
    expect(parseRunState(null)).toBeNull();
    expect(parseRunState('')).toBeNull();
    expect(parseRunState('{ không phải json')).toBeNull();
    expect(parseRunState('{"runId":"r1"}')).toBeNull(); // thiếu observed
    expect(parseRunState('{"observed":"running"}')).toBeNull(); // thiếu runId
    expect(parseRunState('{"runId":"r1","observed":"BẢO TRÌ"}')).toBeNull();
  });

  it('parse bịt lỗ hổng số NaN và desired rác', () => {
    const raw = JSON.stringify({
      runId: 'r1',
      observed: 'running',
      startedAt: 'không phải số',
      desired: 'whatever',
      terminalReason: 'không hợp lệ',
    });
    const s = parseRunState(raw);
    expect(s).not.toBeNull();
    expect(Number.isFinite(s!.startedAt)).toBe(true);
    expect(s!.desired).toBe('running');
    expect(s!.terminalReason).toBeNull();
  });
});

describe('khôi phục run mồ côi sau reload', () => {
  it('run còn tươi → giao lại cho vòng reconcile bình thường', () => {
    const saved = touchProgress(started(), T0);
    const res = reconcileOnBoot(saved, T0 + ORPHAN_GRACE_MS - 1);
    expect(res.action.kind).toBe('watch');
    expect(res.next.observed).toBe('running');
  });

  it('run đã im lặng quá ngưỡng → chốt là gián đoạn, không chờ', () => {
    const saved = touchProgress(started(), T0);
    const res = reconcileOnBoot(saved, T0 + ORPHAN_GRACE_MS + 1);
    expect(res.action).toEqual({ kind: 'terminate', reason: 'stalled' });
    expect(res.next.observed).toBe('terminated');
  });

  it('run đã kết thúc từ trước thì bỏ qua', () => {
    const done = markSucceeded(started(), T0 + 1_000);
    const res = reconcileOnBoot(done, T0 + 999_999);
    expect(res.action).toEqual({ kind: 'none' });
    expect(res.next).toBe(done);
  });
});
