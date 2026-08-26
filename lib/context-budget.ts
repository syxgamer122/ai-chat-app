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

/** Token giữ lại cho OUTPUT của model + sai số ước lượng. */
export const RESERVE_TOKENS = 6_000;

/** Số tin nhắn gần nhất LUÔN được giữ nguyên văn sau khi nén. */
export const KEEP_RECENT_MESSAGES = 8;

/** Ít nhất bao nhiêu tin trong phần "older" thì mới đáng gọi LLM tóm tắt. */
export const MIN_MESSAGES_TO_COMPACT = 6;

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

/** Trần ký tự mỗi tool result khi ước lượng — chống quét payload quá lớn. */
export const TOOL_RESULT_ESTIMATE_CHARS = 24_000;

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

/**
 * Chia projection thành [phần cần nén | phần giữ nguyên văn].
 * Trả null khi hội thoại còn ngắn — không có gì đáng nén.
 */
export function splitForCompaction(
  messages: readonly BudgetMessageLike[],
): { older: BudgetMessageLike[]; keep: typeof messages } | null {
  const olderCount = messages.length - KEEP_RECENT_MESSAGES;
  if (olderCount < MIN_MESSAGES_TO_COMPACT) return null;
  return {
    older: messages.slice(0, olderCount),
    keep: messages.slice(olderCount),
  };
}

/* ------------------------------------------------------------------ */
/* Nhận diện lỗi TRÀN CONTEXT từ upstream                              */
/* ------------------------------------------------------------------ */

/**
 * Regex nhận diện lỗi tràn context theo provider — port trực tiếp từ
 * prime-agent `packages/ai/src/utils/overflow.ts` (MIT), lược bớt các mẫu
 * đặc thù SDK server-side mà KODA không gặp qua gateway OpenAI-compatible.
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
