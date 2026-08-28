/**
 * Phát hiện "lỗi trá hình dưới HTTP 200" của gateway.
 *
 * Một số gateway (đo trực tiếp trên crax) KHÔNG trả mã lỗi khi backend cạn
 * quota — chúng trả HTTP 200, SSE hợp lệ, `finish_reason: "stop"`, nhưng nội
 * dung lại là thông báo lỗi tiếng Anh trong ngoặc vuông:
 *
 *   data: {"id":"err", ... "delta":{"content":"\n\n[Notion is currently
 *   unavailable — tried 22 accounts over 0s, every account tried is over its
 *   usage cap for this model right now...]"}}
 *   data: {"id":"err", ... "finish_reason":"stop"}
 *
 * Không phát hiện thì app coi đó là câu trả lời thật: lưu vào IndexedDB, tính
 * vào ngân sách context, và người dùng thấy một "câu trả lời" vô nghĩa thay
 * vì được tự động chuyển sang model/key khác.
 *
 * Module thuần (không import gì) để test được và dùng ở cả route lẫn client.
 */

/**
 * Mẫu nội dung cho thấy đây là thông báo lỗi hạ tầng, KHÔNG phải câu trả lời.
 * Cố ý hẹp: chỉ khớp câu lỗi đặc trưng của gateway, tránh chặn nhầm khi người
 * dùng hỏi CHÍNH VỀ các chủ đề này (vd "giải thích lỗi rate limit là gì").
 * Vì vậy mọi mẫu đều gắn với ngữ cảnh vận hành cụ thể của gateway.
 */
const PSEUDO_ERROR_PATTERNS: readonly RegExp[] = Object.freeze([
  // crax/Notion: "[Notion is currently unavailable — tried N accounts...]"
  /\[\s*notion is (currently )?unavailable/i,
  /every account tried is over its usage cap/i,
  /tried \d+ accounts over \d+s/i,
  // Biến thể chung của các gateway gộp tài khoản.
  /\[\s*(all|every) (upstream|backend|provider) accounts? (are )?(over|exhausted)/i,
  /account pool refreshes/i,
]);

/** Id mà gateway dùng để tự đánh dấu chunk lỗi (crax: "err"). */
const ERROR_IDS: readonly string[] = Object.freeze(['err', 'error']);

/**
 * true khi `id` của SSE chunk cho thấy đây là payload lỗi.
 * Tín hiệu rẻ và chắc chắn nhất — kiểm tra trước khi soi nội dung.
 */
export function isErrorChunkId(id: unknown): boolean {
  return typeof id === 'string' && ERROR_IDS.includes(id.trim().toLowerCase());
}

/**
 * true khi đoạn text mang dấu hiệu thông báo lỗi hạ tầng của gateway.
 * Chỉ soi ~600 ký tự đầu: thông báo dạng này luôn nằm ngay đầu phản hồi, còn
 * quét cả câu trả lời dài vừa tốn kém vừa dễ dương tính giả.
 */
export function looksLikePseudoError(text: string | null | undefined): boolean {
  const head = (text ?? '').slice(0, 600);
  if (!head) return false;
  return PSEUDO_ERROR_PATTERNS.some((p) => p.test(head));
}

/**
 * Trích thông điệp gọn để ghi log / hiện cho người dùng.
 * Bỏ ngoặc vuông bao ngoài và nén khoảng trắng.
 */
export function extractPseudoErrorMessage(text: string): string {
  const m = /\[([^\]]{10,400})\]/.exec(text ?? '');
  const raw = (m?.[1] ?? text ?? '').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 300);
}
