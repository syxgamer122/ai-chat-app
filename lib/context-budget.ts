/**
 * Ngân sách context cho hội thoại dài — nền của tính năng compaction.
 *
 * Vấn đề: route /api/chat cắt cứng `messages.slice(-50)` rồi gửi nguyên khối
 * lên upstream. Free gateway có context window nhỏ (thực đo metadata crax),
 * chat dài sẽ tràn — lỗi kiểu "prompt is too long" hoặc 500-validation tùy
 * gateway, người dùng chỉ thấy lỗi khó hiểu.
 *
 * Giải pháp (port pattern từ prime-agent, MIT): ước lượng token kiểu chars/4,
 * khi ước lượng vượt `window − reserve` thì nén phần cũ thành bản tóm tắt và
 * chỉ gửi "tóm tắt + tin mới" lên upstream. Kèm bộ regex nhận diện lỗi tràn
 * context theo từng provider (kể cả khi body lỗi không nói rõ) để client tự
 * phục hồi: nén xong thử lại đúng một lần.
 */

import { TOOL_RESULT_ESTIMATE_CHARS } from '@/lib/tool-limits';

/** Token giữ lại cho OUTPUT của model + sai số ước lượng. */
export const RESERVE_TOKENS = 6_000;

/**
 * SÀN theo SỐ LƯỢNG tin nhắn gần nhất được giữ nguyên văn.
 *
 * Đây từng là điều kiện giữ DUY NHẤT và đó là một cái bẫy với agent coding:
 * 8 tin cuối của một lượt fs_* có thể là 8 tool result đầy trần 24k ký tự
 * (~48k token) — nén xong vẫn tràn ngay. Giờ nó chỉ còn là sàn áp dụng cho
 * hội thoại NHẸ (để nút nén thủ công và hội thoại chat thường vẫn hoạt động
 * như trước); điều kiện thật là ngân sách token bên dưới.
 */
export const KEEP_RECENT_MESSAGES = 8;

/** Ít nhất bao nhiêu tin trong phần "older" thì mới đáng gọi LLM tóm tắt. */
export const MIN_MESSAGES_TO_COMPACT = 6;

/* ------------------------------------------------------------------ */
/* Ngân sách phần GIỮ LẠI (port keep_recent_tokens của evot)            */
/* ------------------------------------------------------------------ */

/**
 * Trần tuyệt đối cho phần giữ nguyên văn sau khi nén. Lấy ý từ mục tiêu
 * "post-compaction ≈ 40k" của evot, trừ phần dành cho chính bản tóm tắt.
 */
export const POST_COMPACTION_TARGET_TOKENS = 40_000;
export const SUMMARY_RESERVE_TOKENS = 8_000;
export const KEEP_RECENT_TOKENS = POST_COMPACTION_TARGET_TOKENS - SUMMARY_RESERVE_TOKENS;

/** Sàn cho window tí hon — dưới mức này thì nén cũng không cứu được gì. */
export const MIN_KEEP_RECENT_TOKENS = 2_000;

/**
 * Ngân sách token của phần giữ nguyên văn, suy ra từ context window.
 *
 * Ràng buộc quan trọng: phải nằm ĐỦ THẤP dưới ngưỡng kích hoạt nén, nếu không
 * sẽ thrash — nén xong vẫn còn sát ngưỡng nên lượt sau lại nén tiếp. Lấy một
 * NỬA ngưỡng là biên an toàn rẻ và dễ kiểm chứng:
 *   window 32k  → ngưỡng 26k  → giữ 13k
 *   window 128k → ngưỡng 122k → giữ 32k (chạm trần tuyệt đối)
 */
export function retainedTailBudget(
  windowTokens: number | undefined | null,
  reserveTokens: number = RESERVE_TOKENS,
): number {
  const window =
    typeof windowTokens === 'number' && windowTokens > 0
      ? windowTokens
      : FALLBACK_CONTEXT_WINDOW;
  const threshold = Math.max(0, window - reserveTokens);
  return Math.max(
    MIN_KEEP_RECENT_TOKENS,
    Math.min(KEEP_RECENT_TOKENS, Math.floor(threshold / 2)),
  );
}

/** Một ảnh đính kèm ≈ bao nhiêu token (heuristic prime-agent: ~1200). */
export const IMAGE_TOKEN_ESTIMATE = 1_200;

/** Khi không biết window của model/gateway, giả định an toàn thấp này. */
export const FALLBACK_CONTEXT_WINDOW = 32_000;

/** Trần ký tự mỗi tin nhắn khi đóng gói gửi đi tóm tắt (chống phình payload). */
export const COMPACT_MESSAGE_CHAR_CAP = 4_000;

export interface BudgetMessageLike {
  id?: string;
  role?: string;
  /** string hoặc mảng parts dạng [{ type: 'text', text }] của AI SDK. */
  content?: unknown;
  experimental_attachments?: Array<{ contentType?: string; url?: string }>;
  toolInvocations?: ReadonlyArray<{
    state?: string;
    args?: unknown;
    result?: unknown;
  }>;
}

function textLengthOf(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part && typeof part === 'object') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') total += text.length;
    }
  }
  return total;
}

/**
 * Trần ký tự mỗi tool result khi ước lượng — chống quét payload quá lớn.
 * Bằng đúng trần thật (lib/tool-limits.ts) để ContextMeter không báo thấp hơn
 * lượng thực sự gửi lên upstream.
 *
 * Re-export lại để caller cũ import từ module này vẫn chạy.
 */
export { TOOL_RESULT_ESTIMATE_CHARS };

function jsonLengthOf(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function toolInvocationChars(message: BudgetMessageLike): number {
  let chars = 0;
  for (const invocation of message.toolInvocations ?? []) {
    if (invocation?.state === 'partial-call') continue;
    chars += Math.min(jsonLengthOf(invocation?.args), TOOL_RESULT_ESTIMATE_CHARS);
    if (invocation?.state === 'result') {
      chars += Math.min(jsonLengthOf(invocation?.result), TOOL_RESULT_ESTIMATE_CHARS);
    }
  }
  return chars;
}

/**
 * Ước lượng token kiểu chars/4 — cố tình THẮT (thiên về over-estimate) để
 * kích hoạt nén sớm hơn một chút thay vì để tràn thật. Ảnh tính hằng số vì
 * base64 không phản ánh token ảnh thật.
 */
export function estimateContextTokens(messages: readonly BudgetMessageLike[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += Math.ceil(textLengthOf(message.content) / 4);
    tokens += Math.ceil(toolInvocationChars(message) / 4);
    for (const att of message.experimental_attachments ?? []) {
      if ((att.contentType ?? '').startsWith('image/')) {
        tokens += IMAGE_TOKEN_ESTIMATE;
      } else if (att.url) {
        // attachment phi-ảnh: trần thô theo chiều dài data-URL.
        tokens += Math.ceil((att.url.length ?? 0) / 4);
      }
    }
  }
  return tokens;
}

/**
 * Ước lượng toàn bộ prompt gửi model: lịch sử hội thoại cộng các khối system
 * động (persona, summary, skills, web/PDF...). Các khối này từng bị bỏ sót,
 * khiến UI báo còn budget dù request thật đã gần tràn context window.
 */
export function estimatePromptTokens(
  messages: readonly BudgetMessageLike[],
  promptBlocks: readonly (string | null | undefined)[] = [],
): number {
  return (
    estimateContextTokens(messages) +
    promptBlocks.reduce((tokens, block) => tokens + Math.ceil((block?.length ?? 0) / 4), 0)
  );
}

/** true khi ước lượng đã chạm ngưỡng nên nén (theo công thức prime-agent). */
export function shouldCompact(
  estimatedTokens: number,
  windowTokens: number | undefined | null,
  reserveTokens: number = RESERVE_TOKENS,
): boolean {
  const window =
    typeof windowTokens === 'number' && windowTokens > 0
      ? windowTokens
      : FALLBACK_CONTEXT_WINDOW;
  return estimatedTokens > window - reserveTokens;
}

/* ------------------------------------------------------------------ */
/* Trigger theo USAGE THẬT từ upstream (port evot trigger.rs)           */
/* ------------------------------------------------------------------ */

export interface UsageTriggerInput {
  /** promptTokens thật từ upstream (usage.promptTokens trong onFinish). */
  promptTokens: number;
  /** completionTokens thật — dùng để phát hiện silent length-stop. */
  completionTokens: number;
  /** finishReason từ onFinish ('stop', 'length', 'error', ...). */
  finishReason?: string;
  /** Context window của model đang dùng. 0/undefined = không biết. */
  windowTokens?: number | null;
  /** Reserve tokens cho output + system. */
  reserveTokens?: number;
}

export type UsageTriggerDecision =
  | { kind: 'threshold'; promptTokens: number }
  | { kind: 'silent_overflow'; promptTokens: number }
  | { kind: 'length_stop_zero_output'; promptTokens: number }
  | { kind: 'skip' };

/**
 * Quyết định nén dựa trên USAGE THẬT từ upstream — bổ sung cho `shouldCompact`
 * vốn chỉ dùng ước lượng chars/4.
 *
 * Port từ `compaction/trigger.rs` của evot (Apache-2.0), giản lược cho AI SDK v4:
 *
 *  1. **Threshold**: promptTokens vượt `window − reserve` → nén.
 *  2. **Silent overflow**: gateway nuốt im lặng, trả `stop_reason=stop` nhưng
 *     `promptTokens > window`. Trước đây Vyen KHÔNG phát hiện ca này (comment
 *     ở isContextOverflowError ghi rõ "chưa phủ tràn ngầm").
 *  3. **Length-stop zero-output**: `finish_reason=length` + `completionTokens=0`
 *     + `promptTokens ≥ 99% window` → gateway cắt input im lặng, model không
 *     sinh được token nào.
 *
 * GATE QUAN TRỌNG: mọi tín hiệu tương đối-window đều bị gate sau `window > 0`.
 * Khi không biết window (model lạ, proxy không khai báo), CHỈ lỗi tường minh
 * (`isContextOverflowError`) mới kích hoạt — nếu không, mọi lượt thành công sẽ
 * bị đọc nhầm thành silent overflow vì `promptTokens > 0 > undefined`.
 *
 * Trả `'skip'` khi usage không đủ tin cậy hoặc chưa chạm ngưỡng.
 */
export function evaluateUsageTrigger(input: UsageTriggerInput): UsageTriggerDecision {
  const { promptTokens, completionTokens, finishReason, reserveTokens = RESERVE_TOKENS } = input;
  const window =
    typeof input.windowTokens === 'number' && input.windowTokens > 0
      ? input.windowTokens
      : 0;

  if (promptTokens <= 0) return { kind: 'skip' };

  /* Gate: không biết window thì không thể đánh giá threshold/silent overflow.
     Chỉ lỗi tường minh (isContextOverflowError) mới đáng tin trong ca đó. */
  if (window <= 0) return { kind: 'skip' };

  /* Thứ tự kiểm tra: tín hiệu CỤ THỂ trước, tín hiệu CHUNG sau.
     Silent overflow và length-stop là tín hiệu đặc thù hơn threshold — nếu
     promptTokens > window + finishReason='stop', đó là silent overflow chứ
     không phải threshold thông thường, dù cả hai đều đúng về mặt toán học. */

  /* Ca 1: Silent overflow — gateway trả stop bình thường nhưng input đã vượt
     window. Đây là ca Vyen từng bỏ sót hoàn toàn. */
  if (finishReason === 'stop' && promptTokens > window) {
    return { kind: 'silent_overflow', promptTokens };
  }

  /* Ca 2: Length-stop zero-output — gateway cắt input, model không sinh gì.
     Chỉ coi là overflow khi input ≥ 99% window; dưới mức đó có thể là giới
     hạn maxOutputTokens chứ không phải tràn context. */
  if (finishReason === 'length' && completionTokens === 0 && promptTokens >= window * 0.99) {
    return { kind: 'length_stop_zero_output', promptTokens };
  }

  /* Ca 3: Threshold — promptTokens vượt ngưỡng an toàn. */
  if (promptTokens > window - reserveTokens) {
    return { kind: 'threshold', promptTokens };
  }

  return { kind: 'skip' };
}

/**
 * Kết quả hoạch định nén — khai báo, caller tự quyết cách áp dụng.
 * (Port `CompactionPlan` của evot về mô hình message của AI SDK v4.)
 */
export interface CompactionSplit {
  older: BudgetMessageLike[];
  keep: BudgetMessageLike[];
  /** Chỉ số tin đầu tiên được GIỮ nguyên văn (ranh giới nén). */
  firstKept: number;
  /** Token ước lượng của phần giữ lại — để kiểm chứng ngân sách. */
  keptTokens: number;
  /**
   * Điểm cắt rơi GIỮA một lượt (tin đầu tiên giữ lại không phải của user):
   * chỉ số tin user mở đầu lượt đó. `older` vốn đã chứa prefix này nên tóm
   * tắt không mất gì; thông tin này để tầng tóm tắt biết mà nêu rõ ngữ cảnh
   * "lượt đang dở" thay vì coi như một lượt đã xong.
   */
  splitTurnStart?: number;
}

function roleOf(message: BudgetMessageLike): string {
  return typeof message.role === 'string' ? message.role : '';
}

/**
 * Chia projection thành [phần cần nén | phần giữ nguyên văn].
 *
 * HAI điều kiện giữ, lấy cái nào EVICT NHIỀU HƠN:
 *  1. Trần SỐ LƯỢNG (KEEP_RECENT_MESSAGES) — giữ hành vi cũ cho chat thường.
 *  2. Trần TOKEN (retainedTailBudget) — điều kiện thật với agent coding, nơi
 *     8 tin cuối có thể là 8 tool result 24k ký tự. Đi ngược từ cuối, tích
 *     token tới khi chạm ngân sách.
 *
 * Luôn giữ ít nhất MỘT tin: nếu riêng tin cuối đã vượt ngân sách thì không có
 * cách nén nào cứu được, cắt thêm chỉ làm mất tin mới nhất.
 *
 * Trả null khi phần cũ chưa đủ MIN_MESSAGES_TO_COMPACT — không đáng gọi LLM.
 */
export function splitForCompaction(
  messages: readonly BudgetMessageLike[],
  windowTokens?: number | null,
  reserveTokens: number = RESERVE_TOKENS,
): CompactionSplit | null {
  if (messages.length === 0) return null;

  /* Điều kiện 1 — trần số lượng (hành vi cũ). */
  const countCut = messages.length - KEEP_RECENT_MESSAGES;

  /* Điều kiện 2 — trần token: đi ngược, dừng khi phần giữ lại chạm ngân sách. */
  const budget = retainedTailBudget(windowTokens, reserveTokens);
  let accumulated = 0;
  let tokenCut = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    accumulated += estimateContextTokens([messages[i]]);
    if (accumulated > budget) {
      // Tin thứ i đã làm vượt trần → nó thuộc phần bị nén, giữ từ i+1.
      tokenCut = i + 1;
      break;
    }
  }

  /* Lấy điểm cắt MUỘN hơn = evict nhiều hơn = thoả cả hai trần. Kẹp lại để
     luôn còn ít nhất một tin nguyên văn. */
  const firstKept = Math.min(Math.max(countCut, tokenCut), messages.length - 1);
  if (firstKept < MIN_MESSAGES_TO_COMPACT) return null;

  const older = messages.slice(0, firstKept);
  const keep = messages.slice(firstKept);

  /* Split-turn: tin đầu tiên giữ lại không phải của user → điểm cắt nằm giữa
     một lượt đang dở. Tìm tin user mở đầu lượt đó trong phần bị nén. */
  let splitTurnStart: number | undefined;
  if (roleOf(messages[firstKept]) !== 'user') {
    for (let i = firstKept - 1; i >= 0; i -= 1) {
      if (roleOf(messages[i]) === 'user') {
        splitTurnStart = i;
        break;
      }
    }
  }

  return {
    older,
    keep,
    firstKept,
    keptTokens: estimateContextTokens(keep),
    ...(splitTurnStart !== undefined ? { splitTurnStart } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Nhận diện lỗi TRÀN CONTEXT từ upstream                              */
/* ------------------------------------------------------------------ */

/**
 * Regex nhận diện lỗi tràn context theo provider — port trực tiếp từ
 * prime-agent `packages/ai/src/utils/overflow.ts` (MIT), lược bớt các mẫu
 * đặc thù SDK server-side mà Vyen không gặp qua gateway OpenAI-compatible.
 *
 * Mẫu tiêu biểu:
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - OpenRouter: "This endpoint's maximum context length is X tokens..."
 * - Groq: "Please reduce the length of the messages or completion"
 * - Kimi: "Your request exceeded model token limit: X (requested: Y)"
 */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /request_too_large/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
] as const;

/**
 * Lỗi KHÔNG phải tràn dù trông giống (Bedrock format throttle thành
 * "Too many tokens"; rate-limit chuẩn 429 cũng nhắc "tokens").
 */
const NON_OVERFLOW_PATTERNS = [/rate limit/i, /too many requests/i] as const;

/**
 * Nhận diện lỗi tràn từ status + nội dung body lỗi của upstream.
 * Thuần function để test được và dùng được cả ở server route lẫn client.
 *
 * Lưu ý: KHÔNG phủ trường hợp "tràn ngầm" (gateway nuốt im lặng rồi trả
 * usage.input > window) — cần usage đầy đủ từ stream finish, chưa có đường
 * tin cậy trên mọi gateway free; nếu gặp thực tế sẽ bổ sung sau.
 */
export function isContextOverflowError(status: number | undefined, errorText: string): boolean {
  // 429 là rate-limit theo định nghĩa — dù body có nhắc "tokens" cũng không
  // phải tràn context (Bedrock format throttle thành "Too many tokens...").
  if (status === 429) return false;
  const text = errorText ?? '';
  if (!text) return false;
  if (NON_OVERFLOW_PATTERNS.some((p) => p.test(text))) return false;
  return OVERFLOW_PATTERNS.some((p) => p.test(text));
}
