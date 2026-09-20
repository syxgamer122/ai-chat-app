import { describe, expect, it, vi } from 'vitest';
import { ApprovalQueue } from '@/lib/approval-queue';

/**
 * Hàng đợi phê duyệt là ĐƯỜNG AN TOÀN của app: nó quyết định khi nào agent được
 * chạy tiếp và khi nào phải dừng chờ người dùng trả lời. Trước đây logic này nằm
 * lẫn trong `chat-interface.tsx` (5.686 dòng) nên chỉ test được sự tồn tại của
 * tên biến, không test được hành vi. Tách ra `lib/approval-queue.ts` để kiểm
 * chứng thật.
 */

/** Kiểu mục mô phỏng hai loại phê duyệt thật của app. */
type Item = { kind: 'diff' | 'shell'; label: string };

/** Dựng queue kèm log để quan sát chuỗi sự kiện. */
function makeQueue() {
  const presented: Array<Item | null> = [];
  const requests: number[] = [];
  let drained = 0;
  const queue = new ApprovalQueue<Item>({
    onRequest: () => requests.push(requests.length + 1),
    onPresent: (item) => presented.push(item),
    onDrained: () => {
      drained += 1;
    },
  });
  return {
    queue,
    presented,
    requests,
    drainedCount: () => drained,
    /** Mục đang hiện = lần present cuối cùng (null nếu đã đóng hết). */
    current: () => presented[presented.length - 1] ?? null,
  };
}

describe('ApprovalQueue — hiện ngay và xếp hàng', () => {
  it('yêu cầu đầu tiên hiện NGAY', () => {
    const t = makeQueue();
    const resolve = vi.fn();
    const shownNow = t.queue.request({ kind: 'diff', label: 'a.ts' }, resolve);

    expect(shownNow).toBe(true);
    expect(t.current()).toEqual({ kind: 'diff', label: 'a.ts' });
    expect(t.queue.isBusy).toBe(true);
    expect(t.queue.pending).toBe(0);
  });

  it('yêu cầu thứ hai khi đang bận thì XẾP HÀNG, không hiện chồng', () => {
    const t = makeQueue();
    t.queue.request({ kind: 'diff', label: 'a.ts' }, vi.fn());
    const shownNow = t.queue.request({ kind: 'shell', label: 'npm test' }, vi.fn());

    expect(shownNow).toBe(false);
    // Vẫn chỉ mục đầu đang hiện — đây chính là lỗi cũ: hai modal cùng render.
    expect(t.current()).toEqual({ kind: 'diff', label: 'a.ts' });
    expect(t.queue.pending).toBe(1);
  });

  it('onRequest được gọi cho MỌI yêu cầu, kể cả khi phải xếp hàng', () => {
    /*
     * Bắt buộc: component dùng onRequest để báo reconciler biết run đang chờ
     * người dùng. Thiếu lời gọi cho mục xếp hàng nghĩa là run có thể bị kết luận
     * nhầm "stream đứt" và bị giết trong lúc vẫn đang chờ duyệt.
     */
    const t = makeQueue();
    t.queue.request({ kind: 'diff', label: 'a' }, vi.fn());
    t.queue.request({ kind: 'shell', label: 'b' }, vi.fn());
    t.queue.request({ kind: 'diff', label: 'c' }, vi.fn());

    expect(t.requests).toHaveLength(3);
  });
});

describe('ApprovalQueue — đóng và mở mục kế tiếp', () => {
  it('close() mở mục kế tiếp theo FIFO', () => {
    const t = makeQueue();
    t.queue.request({ kind: 'diff', label: '1' }, vi.fn());
    t.queue.request({ kind: 'shell', label: '2' }, vi.fn());
    t.queue.request({ kind: 'diff', label: '3' }, vi.fn());

    expect(t.queue.close()).toBe(true);
    expect(t.current()).toEqual({ kind: 'shell', label: '2' });
    expect(t.queue.pending).toBe(1);

    expect(t.queue.close()).toBe(true);
    expect(t.current()).toEqual({ kind: 'diff', label: '3' });
    expect(t.queue.pending).toBe(0);
  });

  it('close() khi hàng đợi cạn → present(null) và báo onDrained đúng MỘT lần', () => {
    const t = makeQueue();
    t.queue.request({ kind: 'shell', label: 'only' }, vi.fn());

    expect(t.queue.close()).toBe(false);
    expect(t.current()).toBeNull();
    expect(t.queue.isBusy).toBe(false);
    expect(t.drainedCount()).toBe(1);
  });

  it('onDrained KHÔNG được gọi khi vẫn còn mục chờ', () => {
    /*
     * Gọi onDrained sớm sẽ cho run chạy tiếp trong lúc vẫn còn phê duyệt chưa
     * trả lời — agent vượt qua cổng duyệt. Đây là bất biến an toàn.
     */
    const t = makeQueue();
    t.queue.request({ kind: 'diff', label: '1' }, vi.fn());
    t.queue.request({ kind: 'shell', label: '2' }, vi.fn());

    t.queue.close();
    expect(t.drainedCount()).toBe(0);
  });

  it('chuỗi request/close xen kẽ vẫn đúng thứ tự', () => {
    const t = makeQueue();
    t.queue.request({ kind: 'diff', label: '1' }, vi.fn());
    t.queue.request({ kind: 'shell', label: '2' }, vi.fn());
    t.queue.close();
    t.queue.request({ kind: 'diff', label: '3' }, vi.fn());
    t.queue.close();
    t.queue.close();

    const shown = t.presented.filter((p): p is Item => p !== null).map((p) => p.label);
    expect(shown).toEqual(['1', '2', '3']);
    expect(t.drainedCount()).toBe(1);
  });
});

describe('ApprovalQueue — ca lỗi gốc: diff và shell gọi song song', () => {
  it('hai loại khác nhau KHÔNG bao giờ cùng hiện', () => {
    /*
     * Đây là hồi quy cho lỗi thật: trước đây diff và shell có hàng đợi riêng nên
     * khi agent gọi song song một fs_edit và một shell_run, cả hai modal cùng
     * render ở z-[80] — chồng nhau và modal dưới không bấm được.
     */
    const t = makeQueue();
    const diffResolve = vi.fn();
    const shellResolve = vi.fn();

    t.queue.request({ kind: 'diff', label: 'fs_edit' }, diffResolve);
    t.queue.request({ kind: 'shell', label: 'shell_run' }, shellResolve);

    /* Tại mọi thời điểm chỉ có đúng một mục được present. */
    const nonNull = t.presented.filter((p) => p !== null);
    expect(nonNull).toHaveLength(1);
    expect(nonNull[0]).toEqual({ kind: 'diff', label: 'fs_edit' });

    /* Mục xếp hàng chưa được present cho tới khi mục đầu đóng. */
    t.queue.close();
    expect(t.current()).toEqual({ kind: 'shell', label: 'shell_run' });
  });

  it('mỗi yêu cầu giữ đúng resolver của mình', () => {
    /*
     * Resolver phải đi kèm mục: nếu lẫn resolver, thao tác "Duyệt" trên modal
     * shell có thể resolve nhầm promise của diff → ghi file dù người dùng bấm
     * huỷ lệnh shell. Đây là hậu quả nặng nhất có thể của việc gộp hàng đợi.
     */
    const t = makeQueue();
    const diffResolve = vi.fn();
    const shellResolve = vi.fn();

    t.queue.request({ kind: 'diff', label: 'd' }, diffResolve);
    t.queue.request({ kind: 'shell', label: 's' }, shellResolve);

    /* Component gọi close() → mục shell được present. Người dùng bấm "Từ chối". */
    t.queue.close();
    shellResolve(false);

    expect(shellResolve).toHaveBeenCalledWith(false);
    expect(diffResolve).not.toHaveBeenCalled();
  });
});

describe('ApprovalQueue — reset', () => {
  it('reset() xoá cả mục đang hiện lẫn hàng chờ, không báo onDrained', () => {
    /*
     * Dùng khi unmount / đổi phiên: promise của tool sẽ không bao giờ resolve,
     * nhưng lượt chạy cũng đã bị huỷ nên không còn ai await. Cố tình KHÔNG gọi
     * onDrained — resume lúc này sẽ đánh thức một run đã chết.
     */
    const t = makeQueue();
    t.queue.request({ kind: 'diff', label: '1' }, vi.fn());
    t.queue.request({ kind: 'shell', label: '2' }, vi.fn());

    t.queue.reset();

    expect(t.queue.isBusy).toBe(false);
    expect(t.queue.pending).toBe(0);
    expect(t.drainedCount()).toBe(0);
  });
});

describe('ApprovalQueue — abortAll (P0.5)', () => {
  it('abortAll() resolves all active and pending requests with false and drains queue', () => {
    const t = makeQueue();
    const resolve1 = vi.fn();
    const resolve2 = vi.fn();
    const resolve3 = vi.fn();

    t.queue.request({ kind: 'diff', label: '1' }, resolve1);
    t.queue.request({ kind: 'shell', label: '2' }, resolve2);
    t.queue.request({ kind: 'diff', label: '3' }, resolve3);

    expect(t.queue.isBusy).toBe(true);
    expect(t.queue.pending).toBe(2);

    t.queue.abortAll(false);

    expect(resolve1).toHaveBeenCalledWith(false);
    expect(resolve2).toHaveBeenCalledWith(false);
    expect(resolve3).toHaveBeenCalledWith(false);
    expect(t.queue.isBusy).toBe(false);
    expect(t.queue.pending).toBe(0);
    expect(t.current()).toBeNull();
    expect(t.drainedCount()).toBe(1);
  });
});

