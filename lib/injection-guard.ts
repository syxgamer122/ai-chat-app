/**
 * Injection guard — chấm điểm tin nhắn user cuối theo mẫu prompt-injection
 * quen thuộc (port ý tưởng từ corpus iFixAi b12_prompt_injection, rút gọn).
 *
 * Triết lý: KHÔNG cản trở câu hỏi chính đáng. Người dùng hoàn toàn có quyền
 * hỏi "system prompt là gì" hay "đóng vai X" trong hội thoại bình thường —
 * chỉ chặn khi TỔNG HỢP nhiều tín hiệu rõ ràng cố vượt qua vai trò hệ thống
 * hoặc trích xuất chỉ thị/khóa để gửi ra ngoài.
 *
 * Chỉ xét message user CUỐI của mỗi lượt gửi — lịch sử cũ không chạy lại.
 */

interface Pattern {
  re: RegExp;
  /** Trọng số tín hiệu. */
  w: number;
}

const PATTERNS: Pattern[] = [
  // Vượt quyền hệ thống — tín hiệu mạnh nhất
  { re: /\bignore\s+(all\s+|any\s+|your\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules?)/i, w: 3 },
  { re: /\bdisregard\s+(all|any|your)\b/i, w: 3 },
  { re: /bỏ\s?qua\s?(tất\s?cả|hết|hết\s?thảy)?\s?(hướng\s?dẫn|chỉ\s?thị|quy\s?tắc)(\s(trên|trước|cũ))?/i, w: 3 },
  // Trích xuất chỉ thị hệ thống
  { re: /\b(reveal|print|repeat|output|show|leak|exfiltrate)\s+(me\s+)?(your\s+)?(full\s+|exact\s+|complete\s+)?(system\s+prompt|initial\s+instructions?|hidden\s+rules?)/i, w: 3 },
  { re: /(lộ|xuất|đưa|copy|in)\s?(ra|hết)?\s?(toàn\s?bộ\s?)?(system\s?prompt|hướng\s?dẫn\s?hệ\s?thống|chỉ\s?thị\s?ban\s?đầu)/i, w: 3 },
  // Jailbreak kinh điển
  { re: /\bDAN\s+mode\b|\bdeveloper\s+mode\b|\bjailbreak\b/i, w: 2 },
  { re: /\bdo\s+anything\s+now\b/i, w: 3 },
  { re: /\byou\s+are\s+now\s+(a|an|no\s+longer)\b|\bpretend\s+(that\s+)?you\s+(have\s+no|are\s+not)\b/i, w: 2 },
  { re: /\bhãy\s?(giả\s?vờ|đóng\s?vai)\s?(là\s?)?(một\s?)?(AI\s?)?(không\s?có|vô\s?điều\s?kiện|không\s?bị|ràng\s?buộc)/i, w: 2 },
  // Rò rỉ dữ liệu nhạy cảm ra ngoài — nặng nhất khi ghép với các mẫu trên
  { re: /\b(send|post|upload|forward|exfiltrate)\b.{0,60}\b(api[\s_-]?key|secret|token|password|credentials?|system\s+prompt)\b/i, w: 4 },
];

export const INJECTION_BLOCK_THRESHOLD = 6;

/** Điểm injection của một đoạn text — thuần, không side-effect. */
export function injectionScore(text: string): number {
  if (!text) return 0;
  let score = 0;
  for (const p of PATTERNS) {
    if (p.re.test(text)) score += p.w;
    if (score >= INJECTION_BLOCK_THRESHOLD) break;
  }
  return score;
}

export type InjectionVerdict = 'allow' | 'block';

/** Quyết định cuối: chỉ chặn khi tổng điểm vượt ngưỡng. */
export function judgeInjection(text: string): InjectionVerdict {
  return injectionScore(text) >= INJECTION_BLOCK_THRESHOLD ? 'block' : 'allow';
}
