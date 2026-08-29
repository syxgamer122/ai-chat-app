'use client';

/**
 * Bắc cầu reconciler thuần (lib/run-lifecycle.ts) vào React.
 *
 * Vấn đề hiệu năng cần tránh: stream nhả hàng trăm token, nếu mỗi token đẩy
 * một object state mới vào React thì cả cây chat re-render liên tục — trong
 * khi 99% lần `touch()` chỉ đổi `lastProgressAt`, thứ không ảnh hưởng gì tới
 * giao diện.
 *
 * Cách giải quyết: trạng thái CHUẨN nằm trong ref (đọc/ghi đồng bộ, không
 * re-render); React chỉ được thông báo khi phần "đáng để vẽ lại" đổi
 * (observed / desired / terminalReason). Nhãn đếm giây lúc stalled được cập
 * nhật bằng một bộ đếm riêng, chỉ chạy khi thực sự stalled.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  RECONCILE_TICK_MS,
  beginRun,
  describeRun,
  isTerminal,
  markAwaitingUser,
  markFailed,
  markSucceeded,
  newRun,
  reconcile,
  recordRepair,
  requestStop,
  resumeFromUser,
  setCanRepair,
  touchProgress,
  type RunDesired,
  type RunLifecycle,
  type RunObserved,
  type RunStatusView,
  type TerminalReason,
} from '@/lib/run-lifecycle';

/** Phần trạng thái mà giao diện thực sự quan tâm. */
export interface RunSnapshot {
  observed: RunObserved;
  desired: RunDesired;
  terminalReason: TerminalReason | null;
}

export interface UseRunLifecycleOptions {
  /**
   * Run bị kẹt mà có continuation để đẩy lại (client đang giữ tool result chờ
   * resubmit). `attempt` bắt đầu từ 1.
   */
  onRepair?: (attempt: number) => void;
  /** Run cần kết thúc — caller thực thi stop() thật sự + dọn UI. */
  onTerminate?: (reason: TerminalReason) => void;
}

export interface RunLifecycleApi {
  snapshot: RunSnapshot;
  /** Nhãn + tone + busy để vẽ UI. */
  view: RunStatusView;
  busy: boolean;
  /** Trạng thái đầy đủ, luôn tươi — đọc trong callback/event handler. */
  current: () => RunLifecycle;
  /** Bắt đầu run (gửi request). */
  begin: () => void;
  /** Heartbeat — gọi mỗi khi nhận token hoặc tool xong. */
  touch: () => void;
  /** Người dùng bấm dừng. */
  stop: () => void;
  /** Run hoàn tất bình thường. */
  succeed: () => void;
  /** Run lỗi rõ ràng. */
  fail: () => void;
  /** Đánh dấu có/không có continuation để repair. */
  setRepairable: (value: boolean) => void;
  /** Run đậu lại chờ người dùng duyệt (modal) — không bị tính là stalled. */
  awaitUser: () => void;
  /** Người dùng vừa quyết định xong — run chạy tiếp. */
  resume: () => void;
  /** Ghi nhận đã xử lý xong một lần repair. */
  markRepaired: () => void;
  /** Lắp trạng thái đọc được từ kv lúc boot. */
  hydrate: (state: RunLifecycle) => void;
}

function toSnapshot(state: RunLifecycle): RunSnapshot {
  return {
    observed: state.observed,
    desired: state.desired,
    terminalReason: state.terminalReason,
  };
}

function sameSnapshot(a: RunSnapshot, b: RunSnapshot): boolean {
  return (
    a.observed === b.observed &&
    a.desired === b.desired &&
    a.terminalReason === b.terminalReason
  );
}

export function useRunLifecycle(options: UseRunLifecycleOptions = {}): RunLifecycleApi {
  const stateRef = useRef<RunLifecycle>(newRun('run'));
  const [snapshot, setSnapshot] = useState<RunSnapshot>(() => toSnapshot(stateRef.current));
  /** Chỉ tăng khi stalled — để nhãn "Không có phản hồi (Ns)" chạy. */
  const [stallTick, setStallTick] = useState(0);
  /**
   * Mốc thời gian của nhịp reconcile GẦN NHẤT, ghi trong effect (nơi gọi
   * `Date.now()` là hợp lệ). `describeRun` cần `now` để đếm số giây đã chờ khi
   * stalled; đọc nó từ ref thay vì gọi `Date.now()` ngay trong render, vì
   * render phải thuần — gọi hàm không thuần trong render khiến kết quả không
   * lặp lại được (React có quyền gọi lại render bất kỳ lúc nào).
   */
  const nowRef = useRef(0);

  /* Callback để trong ref: đổi callback không được làm giật lại lịch reconcile. */
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  /** Ghi trạng thái mới; chỉ báo React khi phần đáng vẽ lại thay đổi. */
  const publish = useCallback((next: RunLifecycle) => {
    stateRef.current = next;
    const snap = toSnapshot(next);
    setSnapshot((prev) => (sameSnapshot(prev, snap) ? prev : snap));
  }, []);

  /* Vòng reconcile tự hẹn giờ. Chỉ chạy khi run đang sống (không idle/terminal). */
  useEffect(() => {
    if (snapshot.observed === 'idle' || isTerminal(snapshot.observed)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const step = () => {
      if (cancelled) return;
      const now = Date.now();
      nowRef.current = now;
      const { action, next } = reconcile(stateRef.current, now);
      publish(next);

      switch (action.kind) {
        case 'repair': {
          // Ghi nhận repair NGAY: nếu đợi caller xong mới ghi, hai lần tick
          // liên tiếp có thể cùng tính là attempt 1.
          stateRef.current = recordRepair(stateRef.current, now);
          optionsRef.current.onRepair?.(action.attempt);
          timer = setTimeout(step, RECONCILE_TICK_MS);
          break;
        }
        case 'terminate':
          optionsRef.current.onTerminate?.(action.reason);
          break;
        case 'watch':
          timer = setTimeout(step, Math.max(200, action.afterMs));
          break;
        default:
          timer = setTimeout(step, RECONCILE_TICK_MS);
      }

      // Đang stalled thì nhãn cần đếm giây re-render mỗi nhịp.
      if (next.observed === 'stalled') setStallTick((t) => t + 1);
    };

    timer = setTimeout(step, RECONCILE_TICK_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [snapshot.observed, snapshot.desired, publish]);

  const view = useMemo(
    () => describeRun(stateRef.current, nowRef.current || stateRef.current.updatedAt),
    // stateRef/nowRef nằm ngoài hệ reactive của React, nên phụ thuộc vào
    // snapshot + stallTick để tính lại khi có gì thay đổi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, stallTick],
  );

  const begin = useCallback(() => {
    publish(beginRun(stateRef.current));
  }, [publish]);

  const touch = useCallback(() => {
    // Không publish: chỉ đổi lastProgressAt, không ảnh hưởng giao diện.
    stateRef.current = touchProgress(stateRef.current);
  }, []);

  const stop = useCallback(() => {
    publish(requestStop(stateRef.current));
  }, [publish]);

  const succeed = useCallback(() => {
    publish(markSucceeded(stateRef.current));
  }, [publish]);

  const fail = useCallback(() => {
    publish(markFailed(stateRef.current));
  }, [publish]);

  const setRepairable = useCallback((value: boolean) => {
    stateRef.current = setCanRepair(stateRef.current, value);
  }, []);

  const markRepaired = useCallback(() => {
    stateRef.current = recordRepair(stateRef.current);
  }, []);

  const awaitUser = useCallback(() => {
    publish(markAwaitingUser(stateRef.current));
  }, [publish]);

  const resume = useCallback(() => {
    publish(resumeFromUser(stateRef.current));
  }, [publish]);

  const hydrate = useCallback(
    (state: RunLifecycle) => {
      publish(state);
    },
    [publish],
  );

  const current = useCallback(() => stateRef.current, []);

  return {
    snapshot,
    view,
    busy: view.busy,
    current,
    begin,
    touch,
    stop,
    succeed,
    fail,
    setRepairable,
    markRepaired,
    awaitUser,
    resume,
    hydrate,
  };
}
