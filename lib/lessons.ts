/**
 * Self-Improvement Lessons — agent rút bài học sau mỗi fix/success/failure,
 * lưu persistent và inject vào system prompt cho các phiên sau.
 *
 * Port mô hình Claude Code /reflect + AGENTS.md (Addy Osmani) + Qwen-mem về
 * mô hình Vyen: dùng bảng memories sẵn có trong Dexie, thêm category prefix
 * để phân biệt lesson với fact thông thường.
 *
 * Thuần function, không Dexie/React — test được trong node.
 */

export type LessonCategory = 'rule' | 'pattern' | 'gotcha';

export const LESSON_CATEGORIES: readonly LessonCategory[] = ['rule', 'pattern', 'gotcha'] as const;

/** Prefix để phân biệt lesson với fact thường trong bảng memories. */
export const LESSON_PREFIX = '[LESSON:';

export interface Lesson {
  category: LessonCategory;
  text: string;
}

/** Serialize lesson thành string để lưu vào memories table. */
export function serializeLesson(lesson: Lesson): string {
  return `${LESSON_PREFIX}${lesson.category}] ${lesson.text}`;
}

/** Parse lesson từ memory text. Trả null nếu không phải lesson. */
export function parseLesson(text: string): Lesson | null {
  if (!text.startsWith(LESSON_PREFIX)) return null;
  const closeBracket = text.indexOf(']');
  if (closeBracket === -1) return null;
  const catRaw = text.slice(LESSON_PREFIX.length, closeBracket).trim().toLowerCase();
  const validCats: LessonCategory[] = ['rule', 'pattern', 'gotcha'];
  if (!validCats.includes(catRaw as LessonCategory)) return null;
  const body = text.slice(closeBracket + 1).trim();
  if (!body) return null;
  return { category: catRaw as LessonCategory, text: body };
}

/** Lọc lessons từ danh sách memories. */
export function extractLessons(memories: Array<{ text: string }>): Lesson[] {
  const out: Lesson[] = [];
  for (const m of memories) {
    const lesson = parseLesson(m.text);
    if (lesson) out.push(lesson);
  }
  return out;
}

/**
 * Format lessons thành block chèn vào system prompt.
 * Group theo category, giới hạn tổng ký tự để không phình context.
 */
export function formatLessonsBlock(
  lessons: Lesson[],
  maxChars: number = 3_000,
): string {
  if (!lessons.length) return '';

  const icons: Record<LessonCategory, string> = {
    rule: '📏',
    pattern: '🔧',
    gotcha: '⚠️',
  };
  const labels: Record<LessonCategory, string> = {
    rule: 'QUY TẮC (luôn tuân theo)',
    pattern: 'PATTERN (cách làm hiệu quả)',
    gotcha: 'GOTCHA (lỗi cần tránh)',
  };

  const sections: string[] = [];
  let chars = 0;

  for (const cat of LESSON_CATEGORIES) {
    const items = lessons.filter((l) => l.category === cat);
    if (!items.length) continue;
    const lines = items.map((l) => `${icons[cat]} ${l.text}`);
    const section = `[${labels[cat]}]\n${lines.join('\n')}`;
    if (chars + section.length > maxChars) break;
    sections.push(section);
    chars += section.length;
  }

  if (!sections.length) return '';
  return `[BÀI HỌC TỪ CÁC PHIÊN TRƯỚC]\n${sections.join('\n\n')}`;
}

/**
 * Validate lesson text: không quá dài, không rỗng, không chứa injection.
 */
export function validateLessonText(text: string, maxChars: number = 400): string | null {
  const trimmed = text.trim().slice(0, maxChars);
  if (trimmed.length < 5) return null;
  return trimmed;
}

/**
 * Suggest lesson extraction từ kết quả shell_run: khi lệnh fail rồi succeed
 * trong cùng debug session → gợi ý model lưu lesson.
 */
export function suggestLessonFromDebug(
  command: string,
  attempts: number,
): string | null {
  if (attempts <= 1) return null; // Thành công ngay lần đầu → không có gì để học
  return (
    `[LESSON OPPORTUNITY] Lệnh "${command}" đã thất bại ${attempts - 1} lần trước khi thành công. ` +
    'Hãy rút ra bài học từ lỗi này và gọi lesson_save để lưu lại cho các phiên sau. ' +
    'Ví dụ: "Khi sửa TypeScript error, luôn chạy tsc --noEmit trước khi commit".'
  );
}
