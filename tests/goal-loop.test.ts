/**
 * Goal Loop — pure module tests.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  GOAL_MAX_ITERATIONS_DEFAULT,
  GOAL_MAX_ITERATIONS_LIMIT,
  GOAL_STALL_THRESHOLD,
  buildGoalKickoff,
  buildGoalSteering,
  clearGoalLoop,
  describeGoalStop,
  evaluateGoalTurn,
  getGoalLoop,
  hasGoalCompleteMarker,
  normalizeGoalAnswer,
  startGoalLoop,
  stopGoalLoop,
  stripGoalCompleteTag,
  __clearAllGoalLoops,
} from '@/lib/goal-loop';

const CONV = 'conv-goal-1';
const T0 = 1_700_000_000_000;

beforeEach(() => {
  __clearAllGoalLoops();
});

describe('hasGoalCompleteMarker', () => {
  it.each([
    ['<goal-complete reason="tests pass"/>', true],
    ['<goal-complete>', true],
    ['<goal_complete/>', true],
    ['<goal-complete reason="x">chi tiết</goal-complete>', true],
    ['[goal-complete]', true],
    ['goal-complete: đã xong', true],
    ['Chưa xong đâu, còn lỗi build.', false],
    ['<tool-call>{"name":"fs_read"}</tool-call>', false],
    ['', false],
  ])('%s → %s', (text, expected) => {
    expect(hasGoalCompleteMarker(text)).toBe(expected);
  });
});

describe('stripGoalCompleteTag', () => {
  it('bóc tag tự đóng, giữ nội dung còn lại', () => {
    const out = stripGoalCompleteTag('Đã sửa xong, test pass.\n<goal-complete reason="vitest 25/25"/>');
    expect(out).toBe('Đã sửa xong, test pass.');
  });

  it('bóc tag cặp mở-đóng nhưng giữ inner text', () => {
    const out = stripGoalCompleteTag('<goal-complete reason="ok">Tất cả test pass</goal-complete>');
    expect(out).toBe('Tất cả test pass');
  });

  it('bóc biến thể [goal-complete] và goal-complete:', () => {
    expect(stripGoalCompleteTag('Xong [goal-complete]')).toBe('Xong');
    expect(stripGoalCompleteTag('goal-complete: đã xong')).toBe('đã xong');
  });

  it('không đụng text thường', () => {
    const text = 'Bình thường, không có tag nào.';
    expect(stripGoalCompleteTag(text)).toBe(text);
  });
});

describe('normalizeGoalAnswer', () => {
  it('chuẩn hóa whitespace + lowercase + bỏ marker', () => {
    expect(normalizeGoalAnswer('  ĐÃ   Xong\n\n<goal-complete/>  ')).toBe('đã xong');
  });
});

describe('startGoalLoop', () => {
  it('mặc định maxIterations và kẹp trần', () => {
    const s = startGoalLoop(CONV, { instruction: 'làm cho test pass' }, T0);
    expect(s.maxIterations).toBe(GOAL_MAX_ITERATIONS_DEFAULT);
    expect(s.status).toBe('active');
    expect(s.iterations).toBe(0);

    const capped = startGoalLoop(CONV, { instruction: 'x', maxIterations: 999 }, T0);
    expect(capped.maxIterations).toBe(GOAL_MAX_ITERATIONS_LIMIT);

    const floor = startGoalLoop(CONV, { instruction: 'x', maxIterations: 0 }, T0);
    expect(floor.maxIterations).toBe(1);
  });

  it('goal mới thay thế goal đang active', () => {
    startGoalLoop(CONV, { instruction: 'mục tiêu A' }, T0);
    const s2 = startGoalLoop(CONV, { instruction: 'mục tiêu B' }, T0 + 1);
    expect(getGoalLoop(CONV)?.instruction).toBe('mục tiêu B');
    expect(s2.id).not.toBe(getGoalLoop(CONV)?.id === undefined);
    expect(getGoalLoop(CONV)?.iterations).toBe(0);
  });

  it('bucket TTL bị sweep khi bắt đầu goal mới ở thời điểm xa', () => {
    startGoalLoop('conv-A', { instruction: 'a' }, T0);
    // 30 phút + 1ms sau, bắt đầu conv-B → sweep dọn conv-A.
    startGoalLoop('conv-B', { instruction: 'b' }, T0 + 30 * 60_000 + 1);
    expect(getGoalLoop('conv-A')).toBeNull();
    expect(getGoalLoop('conv-B')).not.toBeNull();
  });

  it('không có conversationId thì vẫn trả state nhưng không lưu', () => {
    const s = startGoalLoop(null, { instruction: 'a' }, T0);
    expect(s.status).toBe('active');
    expect(getGoalLoop(null)).toBeNull();
  });
});

describe('evaluateGoalTurn — luồng chính', () => {
  it('không có goal → decision complete, không crash', () => {
    const r = evaluateGoalTurn(CONV, 'câu trả lời', T0);
    expect(r.decision).toBe('complete');
    expect(r.state).toBeNull();
  });

  it('lượt chưa xong → continue kèm steering, tăng iterations', () => {
    startGoalLoop(CONV, { instruction: 'sửa bug', maxIterations: 5 }, T0);
    const r = evaluateGoalTurn(CONV, 'Tôi đã đọc code, đang sửa.', T0 + 1_000);
    expect(r.decision).toBe('continue');
    expect(r.state.iterations).toBe(1);
    expect(r.steering).toContain('sửa bug');
    expect(r.steering).toContain('2/5');
    expect(getGoalLoop(CONV)?.iterations).toBe(1);
  });

  it('marker goal-complete → succeeded', () => {
    startGoalLoop(CONV, { instruction: 'sửa bug' }, T0);
    const r = evaluateGoalTurn(CONV, 'Xong. Test pass 25/25. <goal-complete reason="vitest 25/25"/>', T0 + 1_000);
    expect(r.decision).toBe('complete');
    expect(r.state.status).toBe('succeeded');
    expect(r.state.stopReason).toBe('goal_complete');
  });

  it('hết lượt → exhausted (dù không marker)', () => {
    startGoalLoop(CONV, { instruction: 'x', maxIterations: 2 }, T0);
    evaluateGoalTurn(CONV, 'lần 1', T0 + 1);
    const r = evaluateGoalTurn(CONV, 'lần 2 — khác lần 1', T0 + 2);
    expect(r.decision).toBe('exhausted');
    expect(r.state.status).toBe('exhausted');
    expect(r.state.stopReason).toBe('max_iterations');
    expect(r.steering).toBeUndefined();
  });

  it('trả lời y hệt ' + GOAL_STALL_THRESHOLD + ' lần liên tiếp → stalled', () => {
    startGoalLoop(CONV, { instruction: 'x', maxIterations: 10 }, T0);
    const answers = ['Tôi không biết làm sao.', '  Tôi   không biết làm sao.  ', 'TÔI KHÔNG BIẾT LÀM SAO.'];
    let last;
    for (let i = 0; i < answers.length; i += 1) {
      last = evaluateGoalTurn(CONV, answers[i], T0 + i + 1);
      if (i < answers.length - 1) expect(last.decision).toBe('continue');
    }
    expect(last?.decision).toBe('stalled');
    expect(last?.state.status).toBe('stalled');
    expect(last?.state.stopReason).toBe('no_progress');
  });

  it('trả lời lặp 2 lần rồi khác → không stall, reset chuỗi', () => {
    startGoalLoop(CONV, { instruction: 'x', maxIterations: 10 }, T0);
    evaluateGoalTurn(CONV, 'giống nhau', T0 + 1);
    evaluateGoalTurn(CONV, 'giống nhau', T0 + 2);
    const r = evaluateGoalTurn(CONV, 'hướng mới hoàn toàn', T0 + 3);
    expect(r.decision).toBe('continue');
    expect(r.state.recentAnswerHashes.length).toBeLessThanOrEqual(GOAL_STALL_THRESHOLD);
  });

  it('goal đã terminal thì không đếm thêm lượt', () => {
    startGoalLoop(CONV, { instruction: 'x' }, T0);
    evaluateGoalTurn(CONV, 'xong <goal-complete/>', T0 + 1);
    const r = evaluateGoalTurn(CONV, 'tin nhắn sau đó', T0 + 2);
    expect(r.decision).toBe('complete');
    expect(r.state.iterations).toBe(1);
    expect(r.state.status).toBe('succeeded');
  });
});

describe('stopGoalLoop', () => {
  it('dừng goal đang active', () => {
    startGoalLoop(CONV, { instruction: 'x' }, T0);
    const s = stopGoalLoop(CONV, 'user_stop', T0 + 1);
    expect(s?.status).toBe('stopped');
    expect(s?.stopReason).toBe('user_stop');
    const r = evaluateGoalTurn(CONV, 'câu trả lời muộn', T0 + 2);
    expect(r.decision).toBe('exhausted'); // status stopped → ánh xạ exhausted
  });

  it('dừng khi không có goal → null, không crash', () => {
    expect(stopGoalLoop(CONV)).toBeNull();
  });

  it('clearGoalLoop xóa hẳn', () => {
    startGoalLoop(CONV, { instruction: 'x' }, T0);
    clearGoalLoop(CONV);
    expect(getGoalLoop(CONV)).toBeNull();
  });
});

describe('steering & kickoff', () => {
  it('kickoff chứa mục tiêu, protocol và trần lượt', () => {
    const s = startGoalLoop(CONV, { instruction: 'refactor module X', maxIterations: 4 }, T0);
    const k = buildGoalKickoff(s);
    expect(k).toContain('refactor module X');
    expect(k).toContain('<goal-complete');
    expect(k).toContain('1/4');
    expect(k).toContain('không gắn thẻ');
  });

  it('steering gần trần lượt có cảnh báo', () => {
    const s = startGoalLoop(CONV, { instruction: 'x', maxIterations: 3 }, T0);
    evaluateGoalTurn(CONV, 'lượt 1', T0 + 1); // iterations=1, còn 2 → near limit
    const cur = getGoalLoop(CONV)!;
    const st = buildGoalSteering(cur);
    expect(st).toContain('chỉ còn 2 lượt');
  });

  it('steering xa trần không có cảnh báo', () => {
    const s = startGoalLoop(CONV, { instruction: 'x', maxIterations: 10 }, T0);
    evaluateGoalTurn(CONV, 'lượt 1', T0 + 1);
    const st = buildGoalSteering(getGoalLoop(CONV)!);
    expect(st).not.toContain('CẢNH BÁO');
  });
});

describe('describeGoalStop', () => {
  it('nhãn theo từng trạng thái', () => {
    startGoalLoop(CONV, { instruction: 'x', maxIterations: 2 }, T0);
    expect(describeGoalStop(getGoalLoop(CONV)!)).toContain('đang chạy');
    evaluateGoalTurn(CONV, 'a', T0 + 1);
    evaluateGoalTurn(CONV, 'b khác', T0 + 2);
    expect(describeGoalStop(getGoalLoop(CONV)!)).toContain('Hết 2 lượt');
  });
});
