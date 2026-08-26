/**
 * Skills 2 tầng cho prompt library — pattern SKILL.md của fx/Grok Build,
 * thu gọn về client-side:
 *
 * - Tầng 1 (catalog): KHÔNG đưa vào prompt — tiết kiệm token tuyệt đối.
 *   Việc "model biết skill tồn tại" được thay bằng matcher từ khóa phía
 *   client (fold dấu tiếng Việt tái dùng foldText) chạy lúc submitTurn.
 * - Tầng 2 (body): CHỈ khi match, body của tối đa 2 skill được inject vào
 *   system prompt ĐÚNG LƯỢT đó — gửi qua body.skills của /api/chat, giống
 *   đường ống webContext/liveContext/pdfContexts.
 *
 * Prompt mode 'insert' (mặc định) không đi qua đây — vẫn là hành vi chèn ô
 * nhập cũ của menu "/".
 */

import { foldText } from '@/lib/search-utils';

export const SKILL_LIMITS = {
  /** Số skill kích hoạt tối đa mỗi lượt gửi. */
  maxPerTurn: 2,
  nameChars: 80,
  descChars: 200,
  bodyChars: 4_000,
  /** Trần TỔNG ký tự khối kỹ năng chèn vào system. */
  totalChars: 6_000,
} as const;

export interface SkillLike {
  id: string;
  name: string;
  description?: string;
  body: string;
}

/* ------------------------------------------------------------------ */
/* Matcher (client)                                                    */
/* ------------------------------------------------------------------ */

/**
 * Từ phổ biến vi/en KHÔNG đủ làm tín hiệu kích hoạt — không lọc thì câu
 * "gửi CHO sếp" kích hoạt oan mọi skill có chữ "cho" trong mô tả.
 */
const STOPWORDS = new Set([
  'cho',
  'và',
  'va',
  'của',
  'cua',
  'là',
  'la',
  'các',
  'cac',
  'những',
  'nhung',
  'này',
  'nay',
  'khi',
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
]);

/** Từ khóa đáng tin từ tên + mô tả: bỏ từ ngắn/generic (<3 ký tự có dấu). */
function keywordsOf(skill: SkillLike): string[] {
  const source = foldText(`${skill.name} ${skill.description ?? ''}`).toLowerCase();
  return [
    ...new Set(
      source
        .split(/[^\p{L}\d]+/u)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  ];
}

/**
 * Chọn skill kích hoạt cho tin nhắn: mỗi từ khóa xuất hiện trong tin nhắn
 * (đã fold dấu) tính 1 điểm; tên skill khớp nguyên cụm được +2 điểm ưu tiên.
 * Trả tối đa maxPerTurn skill điểm cao nhất — không ai đạt điểm thì rỗng
 * (tức là lượt này không đốt token cho body nào).
 */
export function matchActiveSkills(
  skills: readonly SkillLike[],
  userText: string,
  max: number = SKILL_LIMITS.maxPerTurn,
): SkillLike[] {
  if (!skills.length || !userText.trim()) return [];
  const foldedText = foldText(userText).toLowerCase();

  const scored = skills.map((skill) => {
    let score = 0;
    for (const kw of keywordsOf(skill)) {
      if (foldedText.includes(kw)) score += 1;
    }
    // Tên skill xuất hiện nguyên vẹn trong tin nhắn → tín hiệu mạnh nhất.
    if (foldedText.includes(foldText(skill.name).toLowerCase().trim())) score += 2;
    return { skill, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, max)
    .map((s) => s.skill);
}

/* ------------------------------------------------------------------ */
/* Formatter (server)                                                  */
/* ------------------------------------------------------------------ */

export interface SkillBlockInput {
  name: string;
  description?: string;
  body: string;
}

/**
 * Format khối [KỸ NĂNG] chèn vào system prompt. Đặt SAU persona trong thứ tự
 * system: kỹ năng là chỉ thị điều chỉnh cách trả lời, cần đứng gần cuối để
 * giữ lực. Trần tổng áp ở đây — server không tin kích thước do client gửi.
 */
export function formatSkillsBlock(skills: readonly SkillBlockInput[]): string {
  if (!skills.length) return '';
  const parts: string[] = ['[KỸ NĂNG ĐANG KÍCH HOẠT cho lượt này]'];
  let budget = SKILL_LIMITS.totalChars;

  for (const s of skills) {
    const header = `## ${s.name.slice(0, SKILL_LIMITS.nameChars)}${s.description ? `\n(${s.description.slice(0, SKILL_LIMITS.descChars)})` : ''}`;
    const body = s.body.slice(0, Math.min(SKILL_LIMITS.bodyChars, budget));
    const block = `${header}\n${body}`;
    if (block.length > budget) break;
    budget -= block.length;
    parts.push(block);
  }

  parts.push(
    '[Cách dùng] Áp các chỉ dẫn trên cho câu trả lời LƯỢT NÀY. Nếu mâu thuẫn với yêu cầu ' +
      'người dùng thì ý người dùng thắng.',
  );
  return parts.join('\n\n');
}
