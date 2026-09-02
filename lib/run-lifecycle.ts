/**
 * Vòng đời một lượt chạy (run) — desired/observed reconciler.
 *
 * Port lõi reconciler của agent-orchestrator (Untrivial-ai/agent-orchestrator)
 * về mô hình single-agent streaming của Vyen.
 *
 * Ở AO, reconciler là trái tim: nó so sánh `desired` (control plane MUỐN sandbox
 * thế nào) với `observed` (sandbox THỰC SỰ đang thế nào) rồi quyết định hành
 * động, có `TerminalStartupTimeout`, `DeletionDeadline` và backoff 30s→5m.
 *
 * Vấn đề tương đương ở Vyen: toàn bộ vòng đời một run hiện tại là MỘT boolean
 * `isLoading` từ useChat. Hệ quả:
 *   - Stream đứt giữa chừng (mạng, tab suspend, upstream treo) → spinner xoay
 *     vô hạn vì không ai định nghĩa "run này đã chết".
 *   - Reload trang khi đang stream → run mồ côi, UI báo "đang trả lời" trên
 *     một thứ không bao giờ quay lại.
 *   - Bấm stop → `stop()` abort request, nhưng không có trạng thái nào ghi
 *     nhận "đã dừng có chủ đích" để phân biệt với "chết do lỗi".
 *
 * Module này tách `desired` (người dùng muốn chạy hay dừng) khỏi `observed`
 * (thực tế run đang ở đâu) và trả về hành động cần làm. **KHÔNG có side
 * effect** — caller (useRunLifecycle / chat-interface) là người thực thi,
 * đúng convention của debug-loop.ts và staging.ts.
 *
 * Thuần function, không Dexie/React — test được trong node.
 */

/* ------------------------------------------------------------------ */
/* Trạng thái                                                          */
/* ------------------------------------------------------------------ */

/** Điều hệ thống MUỐN. Đặt bởi hành động của người dùng. */
export type RunDesired = 'running' | 'stopped';

/** Điều QUAN SÁT được. Đặt bởi reconciler từ heartbeat thực tế. */
export type RunObserved =
  /** Chưa có run nào. */
  | 'idle'
  /** Đã gửi request, chưa nhận token đầu tiên. */
  | 'starting'
  /** Đang nhận token / đang chạy tool. */
  | 'running'
  /**
   * Đậu lại chờ NGƯỜI DÙNG (modal duyệt diff / xác nhận shell). Không phải
   * stalled: không có gì để hết hạn ở đây, vì thời gian chờ là do con người
   * quyết định. Trạng thái này vẫn bị RUN_DEADLINE_MS trói.
   *
   * Thiếu nó thì modal phê duyệt mở 2 phút là bị reconciler kết luận "stream
   * đứt" rồi giết run — đúng luồng agent coding bình thường.
   */
  | 'awaiting_user'
  /** Quá hạn mà không có tiến triển. Chưa chết hẳn — còn cứu được. */
  | 'stalled'
  /** Terminal: hoàn thành bình thường. */
  | 'succeeded'
  /** Terminal: lỗi rõ ràng (upstream ném, network fail). */
  | 'failed'
  /** Terminal: bị dừng hoặc bị dọn, không phải lỗi. */
  | 'terminated';

/** Lý do kết thúc — chỉ có nghĩa khi observed là terminal. */
export type TerminalReason =
  | 'completed'
  | 'error'
  | 'user_stop'
  | 'deadline'
  | 'stalled'
  | 'stalled_give_up';

const TERMINAL_OBSERVED: readonly RunObserved[] = ['succeeded', 'failed', 'terminated'];

export function isTerminal(o: RunObserved): boolean {
  return TERMINAL_OBSERVED.includes(o);
}

export interface RunLifecycle {
  runId: string;
  desired: RunDesired;
  observed: RunObserved;
  /** Lúc bắt đầu run (gửi request), không phải lúc tạo object. */
  startedAt: number;
  /** Lần cuối có tiến triển thực sự (nhận token / tool xong). */
  lastProgressAt: number;
  /**
   * true khi client đang giữ kết quả tool chờ resubmit — tức là "repair" có
   * nghĩa (đẩy lại continuation đang kẹt). false = run đang chờ upstream thuần
   * thì không có gì để sửa, chỉ có thể dừng.
   */
  canRepair: boolean;
  repairAttempts: number;
  lastRepairAt: number | null;
  terminalReason: TerminalReason | null;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Ngưỡng — MỌI con số thời gian của vòng đời run nằm ở đây            */
/* ------------------------------------------------------------------ */

/**
 * Thời gian chờ token ĐẦU TIÊN. Upstream cold-start + reasoning model có thể
 * ngốn 10-20s, nên 25s là rộng rãi nhưng vẫn hữu hạn.
 */
export const STARTUP_GRACE_MS = 25_000;

/**
 * Đã có token mà im lặng quá ngưỡng này = stream chết. SSE khoẻ mạnh nhả
 * chunk mỗi 1-3s, nên 20s là dư sức phân biệt "chậm" với "đứt".
 */
export const STALL_TIMEOUT_MS = 20_000;

/** Tổng thời gian tối đa của một run kể từ startedAt (AO dùng 10 phút). */
export const RUN_DEADLINE_MS = 10 * 60_000;

/** Backoff giữa các lần repair: base × 2^(attempt-1), kẹp bởi trần. */
export const REPAIR_BACKOFF_BASE_MS = 1_000;
export const REPAIR_BACKOFF_CEIL_MS = 8_000;
export const MAX_REPAIR_ATTEMPTS = 3;

/** Nhịp gọi reconcile. */
export const RECONCILE_TICK_MS = 1_000;

/* ------------------------------------------------------------------ */
/* Khởi tạo & chuyển trạng thái (immutable)                            */
/* ------------------------------------------------------------------ */

export function newRun(runId: string, now: number = Date.now()): RunLifecycle {
  return {
    runId,
    desired: 'running',
    observed: 'idle',
    startedAt: now,
    lastProgressAt: now,
    canRepair: false,
    repairAttempts: 0,
    lastRepairAt: null,
    terminalReason: null,
    updatedAt: now,
  };
}

/** Run đã gửi request — chuyển idle → starting. */
export function beginRun(state: RunLifecycle, now: number = Date.now()): RunLifecycle {
  if (state.observed !== 'idle') return state;
  return {
    ...state,
    desired: 'running',
    observed: 'starting',
    startedAt: now,
    lastProgressAt: now,
    repairAttempts: 0,
    lastRepairAt: null,
    terminalReason: null,
    updatedAt: now,
  };
}

/**
 * Heartbeat: có tiến triển. Chuyển starting → running ở lần gọi đầu, và luôn
 * dời `lastProgressAt` để stall detector không kích hoạt oan.
 */
export function touchProgress(state: RunLifecycle, now: number = Date.now()): RunLifecycle {
  if (isTerminal(state.observed)) return state;
  return {
    ...state,
    observed: state.observed === 'starting' ? 'running' : state.observed,
    lastProgressAt: now,
    // Có tiến triển → reset chuỗi repair; lỗi cũ không còn đúng nữa.
    repairAttempts: 0,
    lastRepairAt: null,
    updatedAt: now,
  };
}

/** Client đang giữ kết quả tool chờ resubmit → repair khả dụng. */
export function setCanRepair(
  state: RunLifecycle,
  canRepair: boolean,
  now: number = Date.now(),
): RunLifecycle {
  if (state.canRepair === canRepair) return state;
  return { ...state, canRepair, updatedAt: now };
}

/**
 * Run đậu lại chờ người dùng (mở modal phê duyệt). Từ trạng thái này KHÔNG có
 * auto-stall — phải có `resumeFromUser()` hoặc `requestStop()`.
 */
export function markAwaitingUser(state: RunLifecycle, now: number = Date.now()): RunLifecycle {
  if (isTerminal(state.observed)) return state;
  return {
    ...state,
    observed: 'awaiting_user',
    lastProgressAt: now,
    repairAttempts: 0,
    lastRepairAt: null,
    updatedAt: now,
  };
}

/** Người dùng đã quyết định (duyệt/từ chối) — run chạy tiếp. */
export function resumeFromUser(state: RunLifecycle, now: number = Date.now()): RunLifecycle {
  if (state.observed !== 'awaiting_user') return state;
  return {
    ...state,
    observed: 'running',
    lastProgressAt: now,
    repairAttempts: 0,
    lastRepairAt: null,
    updatedAt: now,
  };
}

/** Người dùng muốn dừng. Chỉ đổi `desired` — reconciler sẽ terminate. */
export function requestStop(state: RunLifecycle, now: number = Date.now()): RunLifecycle {
  if (isTerminal(state.observed)) return state;
  return { ...state, desired: 'stopped', updatedAt: now };
}

function settle(
  state: RunLifecycle,
  observed: Extract<RunObserved, 'succeeded' | 'failed' | 'terminated'>,
  reason: TerminalReason,
  now: number,
): RunLifecycle {
  return {
    ...state,
    observed,
    terminalReason: reason,
    desired: 'stopped',
    canRepair: false,
    lastProgressAt: now,
    updatedAt: now,
  };
}

/** Run hoàn thành bình thường. */
export function markSucceeded(state: RunLifecycle, now: number = Date.now()): RunLifecycle {
  if (isTerminal(state.observed)) return state;
  return settle(state, 'succeeded', 'completed', now);
}

/** Run lỗi rõ ràng từ upstream/network. */
export function markFailed(state: RunLifecycle, now: number = Date.now()): RunLifecycle {
  if (isTerminal(state.observed)) return state;
  return settle(state, 'failed', 'error', now);
}

/** Ghi nhận một lần repair đã được thực thi (caller gọi sau khi xử lý action). */
export function recordRepair(state: RunLifecycle, now: number = Date.now()): RunLifecycle {
  return {
    ...state,
    repairAttempts: state.repairAttempts + 1,
    lastRepairAt: now,
    lastProgressAt: now,
    updatedAt: now,
  };
}

/** Đưa run về trạng thái chờ, giữ nguyên identity (dùng sau retry/continue). */
export function resetRun(state: RunLifecycle, now: number = Date.now()): RunLifecycle {
  return {
    ...newRun(state.runId, now),
    observed: 'idle',
    desired: 'running',
    startedAt: now,
    lastProgressAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Backoff                                                             */
/* ------------------------------------------------------------------ */

/**
 * Thời gian chờ trước lần repair thứ `attempts + 1`.
 * 1s → 2s → 4s, kẹp 8s. AO dùng 30s→5m cho sandbox; ở đây run sống trong
 * một tab trình duyệt đang có người nhìn vào, nên phải nhanh hơn nhiều.
 */
export function backoffDelay(repairAttempts: number): number {
  if (repairAttempts <= 0) return REPAIR_BACKOFF_BASE_MS;
  const raw = REPAIR_BACKOFF_BASE_MS * 2 ** (repairAttempts - 1);
  return Math.min(raw, REPAIR_BACKOFF_CEIL_MS);
}

/* ------------------------------------------------------------------ */
/* Reconciler                                                          */
/* ------------------------------------------------------------------ */

export type ReconcileAction =
  /** Không cần làm gì. */
  | { kind: 'none' }
  /** Chưa có gì chạy và desired=running — caller gửi request đi. */
  | { kind: 'start' }
  /** Run khoẻ, chỉ cần gọi lại sau `afterMs`. */
  | { kind: 'watch'; afterMs: number }
  /** Đẩy lại continuation đang kẹt (resubmit tool result). */
  | { kind: 'repair'; attempt: number; afterMs: number }
  /** Kết thúc run. Caller: stop() + dọn UI. */
  | { kind: 'terminate'; reason: TerminalReason };

export interface ReconcileResult {
  action: ReconcileAction;
  /** Trạng thái SAU khi reconcile — caller lưu lại. */
  next: RunLifecycle;
}

/**
 * Hàm thuần: (trạng thái, thời gian) → (hành động, trạng thái mới).
 * Không side effect, không đụng DOM/DB.
 */
export function reconcile(state: RunLifecycle, now: number = Date.now()): ReconcileResult {
  const keep = (action: ReconcileAction): ReconcileResult => ({ action, next: state });

  /* 1. Terminal là bất biến — không reconcile lại được. */
  if (isTerminal(state.observed)) return keep({ kind: 'none' });

  /* 2. desired=stopped thắng tuyệt đối. */
  if (state.desired === 'stopped') {
    return {
      action: { kind: 'terminate', reason: 'user_stop' },
      next: settle(state, 'terminated', 'user_stop', now),
    };
  }

  /* 3. Chưa bắt đầu: caller là người gửi request, reconciler không gửi thay. */
  if (state.observed === 'idle') return keep({ kind: 'start' });

  /* 4. Trần cứng: một run không được sống quá RUN_DEADLINE_MS dù có heartbeat. */
  if (now - state.startedAt > RUN_DEADLINE_MS) {
    return {
      action: { kind: 'terminate', reason: 'deadline' },
      next: settle(state, 'terminated', 'deadline', now),
    };
  }

  /* 5. Chờ người dùng: chỉ canh trần cứng, KHÔNG canh stall. */
  if (state.observed === 'awaiting_user') {
    return keep({ kind: 'watch', afterMs: RECONCILE_TICK_MS });
  }

  /* 6. Quá hạn tiến triển → đánh dấu stalled. */
  const sinceProgress = now - state.lastProgressAt;
  const startupLate = state.observed === 'starting' && sinceProgress > STARTUP_GRACE_MS;
  const runningLate = state.observed === 'running' && sinceProgress > STALL_TIMEOUT_MS;

  if (startupLate || runningLate) {
    const next: RunLifecycle = { ...state, observed: 'stalled', updatedAt: now };
    return { action: { kind: 'none' }, next };
  }

  /* 7. Đang stalled: quyết định cứu hay bỏ. */
  if (state.observed === 'stalled') {
    // Không có continuation nào đang kẹt → không có gì để sửa.
    if (!state.canRepair) {
      return {
        action: { kind: 'terminate', reason: 'stalled' },
        next: settle(state, 'terminated', 'stalled', now),
      };
    }
    if (state.repairAttempts >= MAX_REPAIR_ATTEMPTS) {
      return {
        action: { kind: 'terminate', reason: 'stalled_give_up' },
        next: settle(state, 'terminated', 'stalled_give_up', now),
      };
    }
    const delay = backoffDelay(state.repairAttempts);
    if (state.lastRepairAt !== null && now - state.lastRepairAt < delay) {
      return keep({ kind: 'watch', afterMs: delay - (now - state.lastRepairAt) });
    }
    return keep({ kind: 'repair', attempt: state.repairAttempts + 1, afterMs: delay });
  }

  /* 8. starting/running bình thường → hẹn giờ kiểm tra lại. */
  const watchIn =
    state.observed === 'starting'
      ? Math.max(500, STARTUP_GRACE_MS - sinceProgress)
      : Math.max(500, STALL_TIMEOUT_MS - sinceProgress);
  return keep({ kind: 'watch', afterMs: Math.min(watchIn, RECONCILE_TICK_MS) });
}

/* ------------------------------------------------------------------ */
/* Hiển thị                                                            */
/* ------------------------------------------------------------------ */

export type RunTone = 'neutral' | 'active' | 'warn' | 'error';

export interface RunStatusView {
  label: string;
  tone: RunTone;
  /** true khi UI nên hiện spinner. */
  busy: boolean;
}

/**
 * Nhãn tiếng Việt cho UI. Tách khỏi component để test được và để mọi nơi
 * hiển thị cùng một từ vựng.
 */
export function describeRun(state: RunLifecycle, now: number = Date.now()): RunStatusView {
  switch (state.observed) {
    case 'idle':
      return { label: 'Sẵn sàng', tone: 'neutral', busy: false };
    case 'starting':
      return { label: 'Đang kết nối…', tone: 'active', busy: true };
    case 'running':
      return { label: 'Đang trả lời…', tone: 'active', busy: true };
    case 'awaiting_user':
      return { label: 'Chờ bạn phê duyệt…', tone: 'warn', busy: true };
    case 'stalled': {
      const waited = Math.round((now - state.lastProgressAt) / 1000);
      return { label: `Không có phản hồi (${waited}s)`, tone: 'warn', busy: true };
    }
    case 'succeeded':
      return { label: 'Hoàn tất', tone: 'neutral', busy: false };
    case 'failed':
      return { label: 'Lỗi', tone: 'error', busy: false };
    case 'terminated': {
      switch (state.terminalReason) {
        case 'user_stop':
          return { label: 'Đã dừng', tone: 'neutral', busy: false };
        case 'deadline':
          return { label: 'Quá thời gian cho phép', tone: 'warn', busy: false };
        case 'stalled':
        case 'stalled_give_up':
          return { label: 'Bị gián đoạn', tone: 'warn', busy: false };
        default:
          return { label: 'Đã kết thúc', tone: 'neutral', busy: false };
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Persist — serialize vào Dexie kv (để reconcile khi reload trang)    */
/* ------------------------------------------------------------------ */

export const RUN_LIFECYCLE_KV_KEY = 'run:lifecycle';

const VALID_OBSERVED: readonly RunObserved[] = [
  'idle',
  'starting',
  'running',
  'awaiting_user',
  'stalled',
  'succeeded',
  'failed',
  'terminated',
];
const VALID_REASONS: readonly TerminalReason[] = [
  'completed',
  'error',
  'user_stop',
  'deadline',
  'stalled',
  'stalled_give_up',
];

export function serializeRunState(state: RunLifecycle): string {
  return JSON.stringify(state);
}

/** Parse từ kv. Rác / sai shape → null (an toàn hơn đoán). */
export function parseRunState(raw: unknown): RunLifecycle | null {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.runId !== 'string' || !o.runId) return null;
  if (!VALID_OBSERVED.includes(o.observed as RunObserved)) return null;
  const observed = o.observed as RunObserved;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const now = Date.now();
  return {
    runId: o.runId,
    desired: o.desired === 'stopped' ? 'stopped' : 'running',
    observed,
    startedAt: num(o.startedAt, now),
    lastProgressAt: num(o.lastProgressAt, now),
    canRepair: o.canRepair === true,
    repairAttempts: Math.max(0, Math.floor(num(o.repairAttempts, 0))),
    lastRepairAt: typeof o.lastRepairAt === 'number' ? o.lastRepairAt : null,
    terminalReason: VALID_REASONS.includes(o.terminalReason as TerminalReason)
      ? (o.terminalReason as TerminalReason)
      : null,
    updatedAt: num(o.updatedAt, now),
  };
}

/**
 * Dọn run mồ côi sau khi reload: một run không ở terminal mà `lastProgressAt`
 * đã cũ hơn ngưỡng này thì coi là chết theo tab, không recover được.
 *
 * Khác với STALL_TIMEOUT_MS (dùng khi tab đang sống và có thể repair): khi
 * vừa reload, mọi goroutine/timer cũ đều đã mất, repair là vô nghĩa. Ngưỡng
 * ngắn để UI nhanh chóng hiện "Bị gián đoạn" thay vì spinner ma.
 */
export const ORPHAN_GRACE_MS = 5_000;

/**
 * Reconcile đặc biệt cho lần boot: run đang chạy dở mà đã im lặng quá
 * ORPHAN_GRACE_MS thì chốt luôn là gián đoạn — không repair, không chờ.
 */
export function reconcileOnBoot(
  state: RunLifecycle,
  now: number = Date.now(),
): ReconcileResult {
  if (isTerminal(state.observed)) return { action: { kind: 'none' }, next: state };
  if (now - state.lastProgressAt <= ORPHAN_GRACE_MS) {
    return { action: { kind: 'watch', afterMs: RECONCILE_TICK_MS }, next: state };
  }
  return {
    action: { kind: 'terminate', reason: 'stalled' },
    next: settle(state, 'terminated', 'stalled', now),
  };
}
