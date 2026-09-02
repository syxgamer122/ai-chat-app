/**
 * Goal Loop — vòng lặp hướng mục tiêu (Loop Engineering pattern).
 *
 * Vấn đề: agent coding dừng ngay sau câu trả lời đầu tiên dù mục tiêu
 * ("sửa cho test pass", "refactor xong module X") chưa đạt — người dùng phải
 * gõ "cứ làm tiếp đi" nhiều lần. Ngược lại, một outer loop KHÔNG GIỚI HẠN là
 * công thức đốt token (đúng rủi ro debug-loop.ts đã né).
 *
 * Thiết kế: goal loop là một state machine THUẦN, conversation-scoped, do
 * caller (chat-interface.tsx) lái qua cơ chế resubmit có sẵn của useChat —
 * KHÔNG có side effect, KHÔNG đụng route.ts. Mỗi lượt assistant kết thúc
 * (finishReason !== 'tool-calls'), caller gọi evaluateGoalTurn():
 *   - Text cuối chứa marker <goal-complete>  → HOÀN TẤT, dừng.
 *   - Còn lượt + có tiến triển              → 'continue', caller append
 *     steering message và useChat tự resubmit.
 *   - Hết lượt (exhausted) hoặc trả lời y hệt N lần (stalled) → DỪNG, báo UI.
 *
 * Giao thức hoàn thành: steering message dạy model kết thúc câu trả lời bằng
 * `<goal-complete reason="..."/>` KHI VÀ CHỈ KHI mục tiêu thật sự đạt. Marker
 * bị nghi ngờ (fabricate) vẫn được tôn trọng — giới hạn lượt là backstop cuối.
 *
 * Thuần function, không Dexie/React — test được trong node.
 */

/* ------------------------------------------------------------------ */
/* Trạng thái                                                          */
/* ------------------------------------------------------------------ */

export type GoalLoopStatus =
  /** Đang chạy — caller tiếp tục resubmit khi verdict là 'continue'. */
  | 'active'
  /** Model phát marker hoàn thành. */
  | 'succeeded'
  /** Người dùng chủ động dừng. */
  | 'stopped'
  /** Hết lượt mà chưa thấy marker. */
  | 'exhausted'
  /** Trả lời y hệt nhau STALL_THRESHOLD lần liên tiếp — không tiến triển. */
  | 'stalled';

export interface GoalLoopState {
  /** ID ổn định trong phiên — cho UI key. */
  id: string;
  /** Mục tiêu do người dùng đặt, nguyên văn. */
  instruction: string;
  /** Trần lượt do người dùng chọn (đã kẹp bởi LIMIT). */
  maxIterations: number;
  /** Số lượt assistant đã hoàn thành kể từ khi bắt đầu goal. */
  iterations: number;
  status: GoalLoopStatus;
  /** Lý do kết thúc — chỉ có nghĩa khi status !== 'active'. */
  stopReason?: 'goal_complete' | 'user_stop' | 'max_iterations' | 'no_progress';
  /** Hash chuẩn hóa của các câu trả lời cuối gần nhất (stall detection). */
  recentAnswerHashes: string[];
  startedAt: number;
  lastProgressAt: number;
}

/* ------------------------------------------------------------------ */
/* Ngưỡng — mọi con số của vòng lặp nằm ở đây                          */
/* ------------------------------------------------------------------ */

/** Trần lượt mặc định: đủ cho 1 vòng sửa-chạy-verify của agent coding. */
export const GOAL_MAX_ITERATIONS_DEFAULT = 5;

/** Trần cứng — người dùng không thể đặt cao hơn (chống đốt token). */
export const GOAL_MAX_ITERATIONS_LIMIT = 10;

/**
 * Số câu trả lời cuối Y HỆT nhau liên tiếp → coi là không tiến triển, dừng
 * sớm dù chưa hết lượt. Thẳng hàng với NO_PROGRESS_THRESHOLD của debug-loop.
 */
export const GOAL_STALL_THRESHOLD = 3;

/** Bucket goal hết hạn sau khoảng này kể từ lần chạm cuối. */
export const GOAL_LOOP_TTL_MS = 30 * 60_000;

/** Trần số bucket giữ đồng thời — chặn rò rỉ bộ nhớ. */
const MAX_BUCKETS = 200;

/* ------------------------------------------------------------------ */
/* Marker hoàn thành                                                   */
/* ------------------------------------------------------------------ */

/** Tag chuẩn trong steering prompt. Model được dạy viết đúng tag này. */
export const GOAL_COMPLETE_TAG = 'goal-complete';

/**
 * Regex nhận marker hoàn thành — khoan dung với biến thể model hay viết:
 * `<goal-complete>`, `<goal_complete>`, `<goal-complete reason="..."/>`,
 * `[goal-complete]`, `GOAL-COMPLETE:`. Chỉ xét phần TEXT cuối của lượt
 * assistant, không xét tool result.
 */
export const GOAL_COMPLETE_RE =
  /<\s*goal[-_]complete\b[^>]*>|<\s*\/\s*goal[-_]complete\s*>|\[\s*goal[-_]complete\s*\]|goal[-_]complete\s*:/i;

/** true khi text cuối của model tuyên bố hoàn thành mục tiêu. */
export function hasGoalCompleteMarker(text: string): boolean {
  return GOAL_COMPLETE_RE.test(text ?? '');
}

/**
 * Bóc marker khỏi nội dung hiển thị/lưu DB — người dùng không cần thấy
 * `<goal-complete reason="..."/>` trong bubble chat. Xóa mọi biến thể mà
 * GOAL_COMPLETE_RE nhận, kèm khoảng trắng thừa.
 */
export function stripGoalCompleteTag(text: string): string {
  return (text ?? '')
    .replace(/<\s*goal[-_]complete\b[^>]*>([\s\S]*?)<\s*\/\s*goal[-_]complete\s*>/gi, '$1')
    .replace(/<\s*goal[-_]complete\b[^>]*\/?\s*>/gi, '')
    .replace(/\[\s*goal[-_]complete\s*\]/gi, '')
    .replace(/^\s*goal[-_]complete\s*:\s*/i, '')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Store — conversation-scoped, TTL tự dọn (mẫu của tool-call-budget)  */
/* ------------------------------------------------------------------ */

interface GoalBucket {
  state: GoalLoopState;
  touchedAt: number;
}

const buckets = new Map<string, GoalBucket>();

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.touchedAt > GOAL_LOOP_TTL_MS) buckets.delete(key);
  }
  if (buckets.size <= MAX_BUCKETS) return;
  const sorted = [...buckets.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt);
  for (const [key] of sorted.slice(0, buckets.size - MAX_BUCKETS)) buckets.delete(key);
}

let goalSeq = 0;

/** Lấy goal loop đang hoạt động của hội thoại (null nếu không có). */
export function getGoalLoop(conversationId?: string | null): GoalLoopState | null {
  if (!conversationId) return null;
  const bucket = buckets.get(conversationId);
  if (!bucket) return null;
  bucket.touchedAt = Date.now();
  return bucket.state;
}

/**
 * Bắt đầu goal loop cho hội thoại. Goal đang active sẽ bị THAY THẾ — người
 * dùng đổi mục tiêu là hành động có chủ đích, không cần hỏi lại.
 */
export function startGoalLoop(
  conversationId: string | null | undefined,
  opts: { instruction: string; maxIterations?: number },
  now: number = Date.now(),
): GoalLoopState {
  const instruction = (opts.instruction ?? '').trim();
  const maxIterations = Math.min(
    Math.max(1, Math.floor(opts.maxIterations ?? GOAL_MAX_ITERATIONS_DEFAULT)),
    GOAL_MAX_ITERATIONS_LIMIT,
  );
  const state: GoalLoopState = {
    id: `goal-${++goalSeq}`,
    instruction,
    maxIterations,
    iterations: 0,
    status: 'active',
    recentAnswerHashes: [],
    startedAt: now,
    lastProgressAt: now,
  };
  if (conversationId) {
    sweep(now);
    buckets.set(conversationId, { state, touchedAt: now });
  }
  return state;
}

/** Người dùng chủ động dừng (nút × trên chip goal, hoặc gửi tin nhắn mới). */
export function stopGoalLoop(
  conversationId: string | null | undefined,
  reason: Extract<GoalLoopState['stopReason'], 'user_stop'> = 'user_stop',
  now: number = Date.now(),
): GoalLoopState | null {
  if (!conversationId) return null;
  const bucket = buckets.get(conversationId);
  if (!bucket || bucket.state.status !== 'active') return bucket?.state ?? null;
  const next: GoalLoopState = {
    ...bucket.state,
    status: 'stopped',
    stopReason: reason,
    lastProgressAt: now,
  };
  buckets.set(conversationId, { state: next, touchedAt: now });
  return next;
}

/** Xóa hẳn goal (đổi hội thoại, reset UI). */
export function clearGoalLoop(conversationId: string | null | undefined): void {
  if (!conversationId) return;
  buckets.delete(conversationId);
}

/** Chỉ dùng trong test. */
export function __clearAllGoalLoops(): void {
  buckets.clear();
}

/* ------------------------------------------------------------------ */
/* Stall detection                                                     */
/* ------------------------------------------------------------------ */

/** Hash đơn giản, ổn định trong phiên — đủ để so sánh "y hệt nhau". */
function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < Math.min(text.length, 2000); i += 1) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return String(h);
}

/** Chuẩn hóa câu trả lời để so sánh: bỏ marker, bỏ khoảng trắng/markdown thừa. */
export function normalizeGoalAnswer(text: string): string {
  const stripped = stripGoalCompleteTag(text ?? '');
  return stripped.replace(/\s+/g, ' ').trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Đánh giá một lượt assistant                                         */
/* ------------------------------------------------------------------ */

export type GoalVerdict = 'continue' | 'complete' | 'exhausted' | 'stalled';

export interface GoalTurnResult {
  /** Trạng thái SAU khi đánh giá — caller lưu lại qua store (đã tự cập nhật). */
  state: GoalLoopState;
  /** Quyết định cho caller. */
  decision: GoalVerdict;
  /** Steering message khi decision === 'continue' (undefined nếu không). */
  steering?: string;
}

/**
 * Đánh giá lượt assistant vừa kết thúc. GHI TRẠNG THÁI MỚI vào store (bucket
 * theo conversationId) — trả về cả state mới để caller/test kiểm tra.
 *
 * Chỉ có nghĩa khi goal đang 'active'; goal đã terminal thì trả nguyên trạng
 * thái với decision tương ứng, không đếm thêm lượt.
 */
export function evaluateGoalTurn(
  conversationId: string | null | undefined,
  assistantText: string,
  now: number = Date.now(),
): GoalTurnResult {
  const state = getGoalLoop(conversationId);
  if (!state) {
    return { state: null as unknown as GoalLoopState, decision: 'complete' };
  }
  if (state.status !== 'active') {
    const decision: GoalVerdict =
      state.status === 'succeeded' ? 'complete' : state.status === 'stalled' ? 'stalled' : 'exhausted';
    return { state, decision };
  }

  const iterations = state.iterations + 1;

  /* 1. Model tuyên bố hoàn thành → succeeded. */
  if (hasGoalCompleteMarker(assistantText)) {
    const next: GoalLoopState = {
      ...state,
      iterations,
      status: 'succeeded',
      stopReason: 'goal_complete',
      lastProgressAt: now,
    };
    if (conversationId) buckets.set(conversationId, { state: next, touchedAt: now });
    return { state: next, decision: 'complete' };
  }

  /* 2. Stall: câu trả lời y hệt STALL_THRESHOLD lần liên tiếp. */
  const hash = simpleHash(normalizeGoalAnswer(assistantText));
  const recent = [...state.recentAnswerHashes, hash].slice(-GOAL_STALL_THRESHOLD);
  const stalled =
    recent.length >= GOAL_STALL_THRESHOLD && recent.every((h) => h === recent[0]);
  if (stalled) {
    const next: GoalLoopState = {
      ...state,
      iterations,
      status: 'stalled',
      stopReason: 'no_progress',
      recentAnswerHashes: recent,
      lastProgressAt: now,
    };
    if (conversationId) buckets.set(conversationId, { state: next, touchedAt: now });
    return { state: next, decision: 'stalled' };
  }

  /* 3. Hết lượt mà chưa thấy marker → exhausted. */
  if (iterations >= state.maxIterations) {
    const next: GoalLoopState = {
      ...state,
      iterations,
      status: 'exhausted',
      stopReason: 'max_iterations',
      recentAnswerHashes: recent,
      lastProgressAt: now,
    };
    if (conversationId) buckets.set(conversationId, { state: next, touchedAt: now });
    return { state: next, decision: 'exhausted' };
  }

  /* 4. Còn lượt → continue kèm steering cho lượt kế. */
  const next: GoalLoopState = {
    ...state,
    iterations,
    recentAnswerHashes: recent,
    lastProgressAt: now,
  };
  if (conversationId) buckets.set(conversationId, { state: next, touchedAt: now });
  return { state: next, decision: 'continue', steering: buildGoalSteering(next) };
}

/* ------------------------------------------------------------------ */
/* Prompt — kickoff, steering, hiển thị                                */
/* ------------------------------------------------------------------ */

/**
 * Quy tắc giao thức goal, nhét vào TIN NHẮN (không đụng system prompt phía
 * route) để toàn bộ tính năng nằm gọn phía client. Model thấy nó như chỉ thị
 * người dùng — đúng bản chất: mục tiêu là CỦA người dùng.
 */
function goalProtocolLines(instruction: string, iteration: number, max: number): string[] {
  return [
    `[GOAL LOOP] Mục tiêu: ${instruction}`,
    `Lượt ${iteration}/${max}.`,
    '',
    'Quy tắc của vòng lặp mục tiêu này:',
    `1. Làm việc THẰNG TIẾN về mục tiêu ở trên, không hỏi lại xác nhận.`,
    '2. Khi mục tiêu THẬT SỰ hoàn thành (đã kiểm chứng bằng bằng chứng cụ thể — test pass, file tồn tại, output đúng), kết thúc câu trả lời bằng thẻ: <goal-complete reason="bằng chứng ngắn gọn"/>.',
    '3. TUYỆT ĐỐI không gắn thẻ đó khi mục tiêu chưa đạt — hệ thống dừng ngay và người dùng sẽ thấy kết quả sai.',
    '4. Nếu bị kẹt, ĐỔI HƯỚNG tiếp cận thay vì lặp lại cách đã thất bại.',
    '5. Nếu mục tiêu bất khả thi hoặc cần thông tin chỉ người dùng có, hãy nói rõ và gắn thẻ <goal-complete reason="bất khả thi: ..."/> để dừng vòng lặp trung thực.',
  ];
}

/** Tin nhắn khởi động goal (caller append ngay khi user bấm 🎯). */
export function buildGoalKickoff(state: GoalLoopState): string {
  return [
    ...goalProtocolLines(state.instruction, 1, state.maxIterations),
    '',
    'Bắt đầu ngay từ lượt này.',
  ].join('\n');
}

/**
 * Steering message cho lượt kế tiếp. Ngắn hơn kickoff — model đã biết quy tắc;
 * nhắc lại mục tiêu + lượt + cảnh báo gần trần.
 */
export function buildGoalSteering(state: GoalLoopState): string {
  const remaining = state.maxIterations - state.iterations;
  const nearLimit = remaining <= 2;
  const lines = goalProtocolLines(state.instruction, state.iterations + 1, state.maxIterations);
  if (nearLimit) {
    lines.push(
      `CẢNH BÁO: chỉ còn ${remaining} lượt. Ưu tiên hoàn thành phần cốt lõi; ` +
        'nếu không kịp, tổng kết những gì đã xong và những gì còn thiếu.',
    );
  }
  return lines.join('\n');
}

/** Nhãn tiếng Việt cho UI chip/thông báo — một nơi duy nhất quy định từ vựng. */
export function describeGoalStop(state: GoalLoopState): string {
  switch (state.status) {
    case 'succeeded':
      return `🎯 Mục tiêu hoàn tất sau ${state.iterations} lượt.`;
    case 'stopped':
      return '🎯 Goal loop đã được dừng thủ công.';
    case 'exhausted':
      return `🎯 Hết ${state.maxIterations} lượt mà chưa xác nhận hoàn thành — đã dừng để bạn xem lại.`;
    case 'stalled':
      return `🎯 Agent trả lời lặp lại ${GOAL_STALL_THRESHOLD} lần không tiến triển — đã dừng.`;
    default:
      return '🎯 Goal loop đang chạy.';
  }
}
