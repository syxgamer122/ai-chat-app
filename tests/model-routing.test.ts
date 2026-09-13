import { describe, expect, it } from 'vitest';
import {
  computeRoutingSnapshot,
  DEFAULT_MODEL_ROUTING,
  isToolFailure,
  isUserFailureFeedback,
  normalizeModelRoutingConfig,
  type ModelRoutingConfig,
  type RoutingMessageLike,
  type RoutingToolInvocation,
} from '@/lib/model-routing';

const CFG: ModelRoutingConfig = {
  enabled: true,
  leadModel: 'strong-model',
  workerModel: 'cheap-model',
  plannerModel: 'planner-model',
  leadTurns: 3,
  failureThreshold: 2,
  fallbackTurns: 2,
};

/** user(text) + các assistant tool invocation thuộc lượt đó. */
function turn(userText: string, ...tools: Partial<RoutingToolInvocation>[]): RoutingMessageLike[] {
  return [
    { role: 'user', content: userText },
    ...(tools.length
      ? [{ role: 'assistant', content: '', toolInvocations: tools as RoutingToolInvocation[] }]
      : []),
  ];
}

const okTool = { toolCallId: 't1', toolName: 'fs_read', state: 'result', result: '{"ok":true}' };
const failTool = {
  toolCallId: 't2',
  toolName: 'fs_edit',
  state: 'result',
  result: '{"error":"File not found"}',
};
const deniedTool = {
  toolCallId: 't3',
  toolName: 'git_commit',
  state: 'result',
  result: '{"approved":false,"note":"Người dùng TỪ CHỐI commit này."}',
};
const testFailTool = {
  toolCallId: 't4',
  toolName: 'shell_run',
  state: 'result',
  result: '{"command":"npm test","exitCode":1,"stdout":"1 failed"}',
};

describe('normalizeModelRoutingConfig', () => {
  it('trả default cho giá trị rác', () => {
    expect(normalizeModelRoutingConfig(null)).toEqual(DEFAULT_MODEL_ROUTING);
    expect(normalizeModelRoutingConfig('x')).toEqual(DEFAULT_MODEL_ROUTING);
    expect(normalizeModelRoutingConfig({})).toEqual(DEFAULT_MODEL_ROUTING);
  });

  it('kẹp số vào khoảng hợp lệ và sạch model id', () => {
    const cfg = normalizeModelRoutingConfig({
      enabled: 'yes' as unknown as boolean, // chỉ true mới bật
      leadModel: '  lead.v1  ',
      leadTurns: 99,
      failureThreshold: 0,
      fallbackTurns: -3,
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.leadModel).toBe('lead.v1');
    expect(cfg.leadTurns).toBe(20);
    expect(cfg.failureThreshold).toBe(1);
    expect(cfg.fallbackTurns).toBe(0);
  });
});

describe('isUserFailureFeedback', () => {
  it('nhận phàn nàn tiếng Việt có dấu và không dấu', () => {
    expect(isUserFailureFeedback('Sai rồi, làm lại đi')).toBe(true);
    expect(isUserFailureFeedback('khong dung, van loi')).toBe(true);
    expect(isUserFailureFeedback('Vẫn chưa đúng ý tôi')).toBe(true);
  });

  it('nhận phàn nàn tiếng Anh', () => {
    expect(isUserFailureFeedback('That is wrong, try again')).toBe(true);
    expect(isUserFailureFeedback("Doesn't work, redo")).toBe(true);
  });

  it('câu hỏi/bình luận thường không tính', () => {
    expect(isUserFailureFeedback('Cái gì sai ở đây nhỉ? Giải thích giúp mình')).toBe(false);
    expect(isUserFailureFeedback('Làm ơn thêm unit test cho hàm calculate')).toBe(false);
    expect(isUserFailureFeedback('')).toBe(false);
  });
});

describe('isToolFailure', () => {
  it('nhận diện lỗi tool các dạng: isError, JSON error, exitCode ≠ 0, applied false', () => {
    expect(isToolFailure(failTool)).toBe(true);
    expect(isToolFailure(testFailTool)).toBe(true);
    expect(isToolFailure({ ...okTool, result: { isError: true } })).toBe(true);
    expect(isToolFailure({ ...okTool, result: '{"applied":false}' })).toBe(true);
    expect(isToolFailure({ ...okTool, result: { ok: false } })).toBe(true);
  });

  it('user TỪ CHỐI approval không phải thất bại của agent', () => {
    expect(isToolFailure(deniedTool)).toBe(false);
  });

  it('kết quả thành công / chưa có result / text thuần không tính', () => {
    expect(isToolFailure(okTool)).toBe(false);
    expect(isToolFailure({ ...okTool, state: 'call' })).toBe(false);
    expect(isToolFailure({ ...okTool, result: 'đã đọc file xong' })).toBe(false);
    expect(isToolFailure({ ...okTool, result: null })).toBe(false);
  });
});

describe('computeRoutingSnapshot — state machine', () => {
  it('tắt routing → không override model', () => {
    const snap = computeRoutingSnapshot([], { ...CFG, enabled: false }, 'hello');
    expect(snap.role).toBeNull();
    expect(snap.modelId).toBeNull();
  });

  it('lead cho leadTurns lượt đầu, sau đó worker', () => {
    const msgs = [...turn('lượt 1'), ...turn('lượt 2')];
    const inLead = computeRoutingSnapshot(msgs, CFG, 'lượt 3');
    expect(inLead.role).toBe('lead');
    expect(inLead.modelId).toBe('strong-model');

    const doneLead = computeRoutingSnapshot([...msgs, ...turn('lượt 3')], CFG, 'lượt 4');
    expect(doneLead.role).toBe('worker');
    expect(doneLead.modelId).toBe('cheap-model');
  });

  it('thiếu model của role → giữ model thường', () => {
    const snap = computeRoutingSnapshot([], { ...CFG, workerModel: '' }, 'x');
    // 0 lượt → role lead vẫn có model; thử đường worker
    const snapWorker = computeRoutingSnapshot(
      [...turn('1'), ...turn('2'), ...turn('3')],
      { ...CFG, workerModel: '' },
      '4',
    );
    expect(snap.modelId).toBe('strong-model');
    expect(snapWorker.role).toBeNull();
    expect(snapWorker.modelId).toBeNull();
  });

  it('worker thất bại LIÊN TIẾP → fallback về lead đúng fallbackTurns lượt rồi về worker', () => {
    // 3 lượt lead sạch
    const base = [...turn('1'), ...turn('2'), ...turn('3')];
    // lượt 4 worker: 2 tool fail trong cùng lượt → vượt ngưỡng 2
    const afterFail = computeRoutingSnapshot([...base, ...turn('4', failTool, failTool)], CFG, '5');
    expect(afterFail.phase).toBe('fallback');
    expect(afterFail.role).toBe('lead');
    expect(afterFail.reason).toContain('fallback');

    // fallbackTurns=2: lượt 5 và lượt 6 dùng lead, lượt 7 về lại worker.
    // role(T) tính khi history CHỈ tới T-1 (lượt T chưa chạy).
    const roleAt = (historyTurns: number, next: string) => {
      const extraTurns = Array.from({ length: Math.max(0, historyTurns - 4) }, (_, i) =>
        turn(`lượt ${5 + i}`),
      ).flat();
      return computeRoutingSnapshot(
        [...base, ...turn('4', failTool, failTool), ...extraTurns],
        CFG,
        next,
      );
    };
    expect(roleAt(4, '5').role).toBe('lead');
    expect(roleAt(5, '6').role).toBe('lead');
    expect(roleAt(6, '7').role).toBe('worker');
  });

  it('thất bại NGẮT QUÃNG (có lượt sạch giữa chừng) không kích hoạt fallback', () => {
    const base = [...turn('1'), ...turn('2'), ...turn('3')];
    const snap = computeRoutingSnapshot(
      [...base, ...turn('4', failTool), ...turn('5', okTool), ...turn('6', failTool)],
      CFG,
      '7',
    );
    expect(snap.phase).toBe('worker');
    expect(snap.role).toBe('worker');
  });

  it('user phàn nàn trong tin SẮP GỬI có hiệu lực ngay: bump counter rồi fallback', () => {
    const base = [...turn('1'), ...turn('2'), ...turn('3'), ...turn('4', failTool)];
    // lượt 4 đã có 1 failure; user mở lượt 5 bằng "làm lại" → đủ ngưỡng 2
    const snap = computeRoutingSnapshot(base, CFG, 'làm lại giúp tôi nhé');
    expect(snap.phase).toBe('fallback');
    expect(snap.role).toBe('lead');
  });

  it('fold từ history cho kết quả khớp đường nextUserText: phàn nàn thuộc lượt của nó', () => {
    // Sau khi "làm lại" (lượt 5, sạch tool) chạy xong, tính role lượt 6:
    // phàn nàn ở lượt 5 bump trước khi quyết role lượt 5 → lượt 5 lead;
    // lượt 6 vẫn còn 1 lượt fallback.
    const msgs = [
      ...turn('1'),
      ...turn('2'),
      ...turn('3'),
      ...turn('4', failTool),
      ...turn('làm lại giúp tôi nhé'),
    ];
    const snap = computeRoutingSnapshot(msgs, CFG, '6');
    expect(snap.role).toBe('lead');
    expect(snap.phase).toBe('fallback');
  });

  it('lỗi gateway 429/5xx không nằm trong toolInvocations → không tính failure', () => {
    const base = [...turn('1'), ...turn('2'), ...turn('3')];
    // annotation error (UPSTREAM_SERVER_502) nằm ở annotation, không phải tool
    // result — state machine không hề nhìn thấy.
    const snap = computeRoutingSnapshot(
      [...base, ...turn('4', okTool), ...turn('5', okTool)],
      CFG,
      '6',
    );
    expect(snap.role).toBe('worker');
  });

  it('user TỪ CHỐI approval không tính failure', () => {
    const base = [...turn('1'), ...turn('2'), ...turn('3')];
    const snap = computeRoutingSnapshot(
      [...base, ...turn('4', deniedTool), ...turn('5', deniedTool)],
      CFG,
      '6',
    );
    expect(snap.role).toBe('worker');
  });

  it('build/test fail (shell exitCode ≠ 0) là failure thật', () => {
    const base = [...turn('1'), ...turn('2'), ...turn('3')];
    const snap = computeRoutingSnapshot([...base, ...turn('4', testFailTool, testFailTool)], CFG, '5');
    expect(snap.phase).toBe('fallback');
    expect(snap.role).toBe('lead');
  });

  it('resubmit tool trong cùng lượt không sinh lượt user mới', () => {
    // 1 lượt user + 3 assistant resubmit (maxSteps) → vẫn 1 turn.
    const msgs: RoutingMessageLike[] = [
      { role: 'user', content: 'lượt 1' },
      { role: 'assistant', content: '', toolInvocations: [okTool as RoutingToolInvocation] },
      { role: 'assistant', content: '', toolInvocations: [okTool as RoutingToolInvocation] },
      { role: 'assistant', content: 'xong' },
    ];
    const snap = computeRoutingSnapshot(msgs, CFG, '2');
    expect(snap.turnCount).toBe(1);
    expect(snap.role).toBe('lead');
  });
});
