/**
 * Lead/Worker model routing (port Goose P1-5).
 *
 * Goose dùng model mạnh cho N lượt đầu (lập kế hoạch) rồi chuyển model rẻ để
 * thực thi; khi worker thất bại thật thì tự quay lại lead vài lượt. Vyen port
 * nguyên state machine đó nhưng tính CLIENT-SIDE hoàn toàn:
 *
 * - Trạng thái KHÔNG được lưu riêng — fold lại toàn bộ message history mỗi
 *   lượt (≤100 tin, deterministic, sống sót qua reload/F5 và không cần bảng
 *   Dexie mới). Server không biết gì về routing: client chỉ override field
 *   `model` trong body như đường media/recipe vẫn làm.
 * - "Thất bại thật" = tool trả lỗi (kể cả lệnh build/test exit ≠ 0) hoặc user
 *   phàn nàn ("sai rồi", "làm lại", "wrong"...). Timeout/429/5xx của LLM nằm
 *   ở annotation error chứ không nằm trong toolInvocations nên tự nhiên
 *   KHÔNG bao giờ bị đếm — đúng yêu cầu "retry im lặng như hiện tại".
 * - User TỪ CHỐI approval (`approved: false`) không phải lỗi của agent —
 *   đó là lựa chọn của người dùng, không được tính failure.
 */

import { foldText } from '@/lib/search-utils';

/** Vai trò của model trong 1 lượt — planner chỉ xuất hiện qua lệnh /plan. */
export type RoutingRole = 'lead' | 'worker' | 'planner';

/** Phase nội bộ của state machine; 'fallback' nghĩa là đang tạm dùng lead trở lại. */
export type RoutingPhase = 'lead' | 'worker' | 'fallback';

export interface ModelRoutingConfig {
  enabled: boolean;
  /** Model mạnh dùng cho leadTurns lượt đầu + khi fallback. Rỗng = tắt override. */
  leadModel: string;
  /** Model rẻ dùng cho thực thi sau leadTurns. */
  workerModel: string;
  /** Model chỉ dùng bởi lệnh /plan (chế độ chỉ-đọc). */
  plannerModel: string;
  /** Số lượt đầu dùng lead. Mặc định 3. */
  leadTurns: number;
  /** Số failure LIÊN TIẾP để kích hoạt fallback về lead. Mặc định 2. */
  failureThreshold: number;
  /** Số lượt giữ lead khi fallback trước khi về lại worker. Mặc định 2. */
  fallbackTurns: number;
}

export const DEFAULT_MODEL_ROUTING: ModelRoutingConfig = {
  enabled: false,
  leadModel: '',
  workerModel: '',
  plannerModel: '',
  leadTurns: 3,
  failureThreshold: 2,
  fallbackTurns: 2,
};

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanModelId(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 120) : '';
}

/** Sanitize config từ localStorage/hand-edited — mọi giá trị rạc về default. */
export function normalizeModelRoutingConfig(raw: unknown): ModelRoutingConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_MODEL_ROUTING };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    leadModel: cleanModelId(r.leadModel),
    workerModel: cleanModelId(r.workerModel),
    plannerModel: cleanModelId(r.plannerModel),
    leadTurns: clampInt(r.leadTurns, DEFAULT_MODEL_ROUTING.leadTurns, 1, 20),
    failureThreshold: clampInt(r.failureThreshold, DEFAULT_MODEL_ROUTING.failureThreshold, 1, 10),
    fallbackTurns: clampInt(r.fallbackTurns, DEFAULT_MODEL_ROUTING.fallbackTurns, 0, 10),
  };
}

/* -------------------------------------------------------------------------- */
/* Failure detection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Cụm từ user phàn nàn về kết quả (VI có/không dấu + EN) — so khớp trên bản
 * fold-dấu lowercase. Câu hỏi bình thường ("cái gì sai ở đây nhỉ?") không
 * khớp vì danh sách chỉ chứa cụm phán quyết rõ ràng.
 */
const FAILURE_FEEDBACK_PHRASES: readonly string[] = [
  // tiếng Việt (đã bỏ dấu)
  'sai roi',
  'van sai',
  'van con sai',
  'khong dung',
  'ko dung',
  'k dung',
  'chua dung',
  'lam lai',
  'lam sai',
  'sai huong',
  'van loi',
  'van bao loi',
  'van chua fix',
  'chua chinh xac',
  'khong chinh xac',
  'khong fix duoc',
  'van chua duoc',
  'chua xong ma',
  // tiếng Anh
  'wrong',
  'not right',
  'try again',
  'redo',
  'didnt work',
  "didn't work",
  'doesnt work',
  "doesn't work",
  'still failing',
  'still broken',
  'broken again',
  'not what i asked',
  'nope',
  'regenerate',
];

/** User có đang phàn nàn về kết quả lượt trước không (fold dấu, VI+EN). */
export function isUserFailureFeedback(text: string): boolean {
  if (!text) return false;
  const folded = foldText(text);
  // Phàn nàn thường nằm ở đầu/cuối tin nhắn ngắn; cắt bớt để không quét
  // toàn bộ file dài user có thể dán kèm.
  const head = folded.slice(0, 400);
  const tail = folded.slice(-200);
  return FAILURE_FEEDBACK_PHRASES.some((p) => head.includes(p) || tail.includes(p));
}

export interface RoutingToolInvocation {
  toolCallId?: unknown;
  toolName?: unknown;
  state?: unknown;
  result?: unknown;
}

/**
 * Tool invocation có phải là thất bại THẬT của agent không.
 * - `state !== 'result'` (call/stream) → chưa có kết quả, bỏ qua.
 * - result là JSON string (client tool) hoặc object (server tool): nhận diện
 *   qua isError/ok+error/error/exitCode≠0/applied:false.
 * - `approved: false` = user từ chối approval → KHÔNG phải failure.
 */
export function isToolFailure(inv: RoutingToolInvocation): boolean {
  if (inv.state !== undefined && inv.state !== 'result') return false;
  const r = inv.result;
  if (r === null || r === undefined) return false;

  let obj: unknown = r;
  if (typeof r === 'string') {
    const t = r.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return false; // text thuần = thành công
    try {
      obj = JSON.parse(t);
    } catch {
      return false; // JSON hỏng → coi như text, không phán đoán
    }
  }
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;

  if (o.approved === false) return false; // user chủ động từ chối
  if (o.isError === true) return true;
  // shell/build/test fail: lệnh chạy xong nhưng exit ≠ 0.
  const exit = o.exitCode ?? o.exit_code ?? o.code;
  if (typeof exit === 'number' && Number.isFinite(exit) && exit !== 0) return true;
  if (o.error !== undefined && o.error !== null && o.error !== '' && o.error !== false) return true;
  // Guard chủ động chặn flow sai (vd fs_edit khi chưa fs_read).
  if (o.applied === false && o.approved === undefined) return true;
  if (o.ok === false) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* State machine                                                              */
/* -------------------------------------------------------------------------- */

export interface RoutingMessageLike {
  role?: unknown;
  content?: unknown;
  toolInvocations?: readonly RoutingToolInvocation[];
}

export interface RoutingSnapshot {
  /** Vai trò model cho lượt SẮP GỬI; null khi routing không can thiệp. */
  role: RoutingRole | null;
  /** Model id gửi override; null = giữ model người dùng chọn như thường. */
  modelId: string | null;
  phase: RoutingPhase;
  /** Tổng số lượt user đã có trong history. */
  turnCount: number;
  /** Số failure liên tiếp đang đọng (chỉ có nghĩa khi phase = 'worker'). */
  consecutiveFailures: number;
  /** Số lượt lead còn lại nếu đang fallback. */
  fallbackRemaining: number;
  /** Giải thích ngắn (hiện trong notice/HUD + assert trong test). */
  reason: string;
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' &&
        typeof (p as { text?: unknown }).text === 'string'
          ? (p as { text: string }).text
          : '',
      )
      .join(' ');
  }
  return '';
}

interface TurnRecord {
  userText: string;
  toolFailures: number;
}

/** Gom messages thành các lượt user: 1 user message = 1 lượt, tool của các
 *  assistant message sau đó thuộc về lượt đó (resubmit tool không sinh lượt mới). */
function splitTurns(messages: readonly RoutingMessageLike[]): TurnRecord[] {
  const turns: TurnRecord[] = [];
  let cur: TurnRecord | null = null;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      cur = { userText: messageText(m.content), toolFailures: 0 };
      turns.push(cur);
    } else if (m.role === 'assistant' && cur) {
      for (const inv of m.toolInvocations ?? []) {
        if (isToolFailure(inv)) cur.toolFailures += 1;
      }
    }
  }
  return turns;
}

/**
 * Tính model cho lượt SẮP GỬI từ toàn bộ history + config.
 *
 * `nextUserText` (tin sắp gửi) cũng được xét phàn nàn: user gõ "làm lại đi"
 * là phán quyết về lượt TRƯỚC và phải có hiệu lực ngay trên model của lượt
 * này — fold từ history sau này cho ra cùng kết quả vì phàn nàn nằm trong
 * chính user message của lượt này và được bump TRƯỚC khi quyết role.
 */
export function computeRoutingSnapshot(
  messages: readonly RoutingMessageLike[],
  config: ModelRoutingConfig,
  nextUserText?: string,
): RoutingSnapshot {
  const cfg = normalizeModelRoutingConfig(config);
  const turns = splitTurns(messages);

  let phase: RoutingPhase = 'lead';
  let fallbackRemaining = 0;
  let consecutiveFailures = 0;
  let reason = 'chưa đủ dữ liệu';

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];

    // Bước 1 — phàn nàn của user ở ĐẦU lượt là phán quyết về lượt trước:
    // có thể đẩy worker vượt ngưỡng → fallback ngay cho chính lượt này.
    if (isUserFailureFeedback(t.userText) && phase === 'worker') {
      consecutiveFailures += 1;
      if (consecutiveFailures >= cfg.failureThreshold) {
        phase = 'fallback';
        fallbackRemaining = cfg.fallbackTurns;
        consecutiveFailures = 0;
      }
    }

    // Bước 2 — kết quả THẬT của lượt vừa chạy (tool đã có result trong history).
    const events = t.toolFailures;
    if (phase === 'lead') {
      if (events > 0) reason = 'lead thất bại nhưng vẫn lead (đã là model mạnh)';
      consecutiveFailures = 0;
      if (i + 1 >= cfg.leadTurns) phase = 'worker';
    } else if (phase === 'fallback') {
      fallbackRemaining -= 1;
      if (fallbackRemaining <= 0) {
        phase = 'worker';
        consecutiveFailures = 0;
      }
    } else {
      if (events === 0) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += events;
        if (consecutiveFailures >= cfg.failureThreshold) {
          phase = 'fallback';
          fallbackRemaining = cfg.fallbackTurns;
          consecutiveFailures = 0;
        }
      }
    }
  }

  // Tin SẮP GỬI: chỉ áp bước 1 (kết quả tool của nó chưa tồn tại).
  if (nextUserText && isUserFailureFeedback(nextUserText) && phase === 'worker') {
    consecutiveFailures += 1;
    if (consecutiveFailures >= cfg.failureThreshold) {
      phase = 'fallback';
      fallbackRemaining = cfg.fallbackTurns;
      consecutiveFailures = 0;
    }
  }

  if (!cfg.enabled) {
    return {
      role: null, modelId: null, phase, turnCount: turns.length,
      consecutiveFailures, fallbackRemaining, reason: 'routing tắt',
    };
  }

  let role: RoutingRole;
  if (phase === 'lead') {
    role = 'lead';
    reason = turns.length < cfg.leadTurns
      ? `lượt ${turns.length + 1}/${cfg.leadTurns} của phase lập kế hoạch`
      : 'lead phase';
  } else if (phase === 'fallback') {
    role = 'lead';
    reason = `fallback về lead (${fallbackRemaining} lượt còn lại)`;
  } else {
    role = 'worker';
    reason = 'thực thi — worker model';
  }

  const modelId = role === 'lead' ? cfg.leadModel : cfg.workerModel;
  if (!modelId) {
    // Chưa cấu hình model cho role này → không override, giữ model thường.
    return {
      role: null, modelId: null, phase, turnCount: turns.length,
      consecutiveFailures, fallbackRemaining, reason: `${reason} — nhưng ${role}Model rỗng nên giữ model hiện tại`,
    };
  }

  return {
    role, modelId, phase, turnCount: turns.length,
    consecutiveFailures, fallbackRemaining, reason,
  };
}
