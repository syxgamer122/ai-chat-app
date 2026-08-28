import { describe, expect, it } from 'vitest';
import {
  serializeLesson,
  parseLesson,
  extractLessons,
  formatLessonsBlock,
  validateLessonText,
  suggestLessonFromDebug,
} from '@/lib/lessons';

describe('serializeLesson / parseLesson', () => {
  it('round-trip rule', () => {
    const s = serializeLesson({ category: 'rule', text: 'Luôn chạy test trước khi commit' });
    expect(s).toBe('[LESSON:rule] Luôn chạy test trước khi commit');
    const parsed = parseLesson(s);
    expect(parsed).toEqual({ category: 'rule', text: 'Luôn chạy test trước khi commit' });
  });

  it('round-trip pattern', () => {
    const s = serializeLesson({ category: 'pattern', text: 'Dùng zod cho validation API input' });
    expect(parseLesson(s)?.category).toBe('pattern');
  });

  it('round-trip gotcha', () => {
    const s = serializeLesson({ category: 'gotcha', text: 'Đừng dùng any trong TypeScript' });
    expect(parseLesson(s)?.category).toBe('gotcha');
  });

  it('parseLesson trả null cho non-lesson', () => {
    expect(parseLesson('fact bình thường')).toBeNull();
    expect(parseLesson('')).toBeNull();
    expect(parseLesson('[LESSON:invalid] text')).toBeNull();
    expect(parseLesson('[LESSON:rule] ')).toBeNull(); // empty body
  });
});

describe('extractLessons', () => {
  it('lọc lessons từ mixed memories', () => {
    const memories = [
      { text: 'User thích dark mode' },
      { text: '[LESSON:rule] Luôn validate input' },
      { text: '[LESSON:gotcha] Tránh mutable state trong React' },
      { text: 'API key đã cấu hình' },
    ];
    const lessons = extractLessons(memories);
    expect(lessons).toHaveLength(2);
    expect(lessons[0].category).toBe('rule');
    expect(lessons[1].category).toBe('gotcha');
  });
});

describe('formatLessonsBlock', () => {
  it('format đúng structure với categories', () => {
    const lessons = [
      { category: 'rule' as const, text: 'Rule 1' },
      { category: 'gotcha' as const, text: 'Gotcha 1' },
    ];
    const block = formatLessonsBlock(lessons);
    expect(block).toContain('[BÀI HỌC TỪ CÁC PHIÊN TRƯỚC]');
    expect(block).toContain('📏 Rule 1');
    expect(block).toContain('⚠️ Gotcha 1');
  });

  it('trả rỗng khi không có lessons', () => {
    expect(formatLessonsBlock([])).toBe('');
  });

  it('cắt khi vượt maxChars', () => {
    const lessons = Array.from({ length: 50 }, (_, i) => ({
      category: 'rule' as const,
      text: `Rule ${i} with a very long description that takes up space`,
    }));
    const block = formatLessonsBlock(lessons, 500);
    expect(block.length).toBeLessThanOrEqual(600); // some margin for headers
  });
});

describe('validateLessonText', () => {
  it('chấp nhận text hợp lệ', () => {
    expect(validateLessonText('Luôn chạy test')).toBe('Luôn chạy test');
  });

  it('từ chối text quá ngắn', () => {
    expect(validateLessonText('ab')).toBeNull();
    expect(validateLessonText('   ')).toBeNull();
  });

  it('cắt text quá dài', () => {
    const long = 'x'.repeat(500);
    expect(validateLessonText(long, 400)!.length).toBe(400);
  });
});

describe('suggestLessonFromDebug', () => {
  it('gợi ý khi attempts > 1', () => {
    const suggestion = suggestLessonFromDebug('npm test', 3);
    expect(suggestion).toContain('[LESSON OPPORTUNITY]');
    expect(suggestion).toContain('npm test');
    expect(suggestion).toContain('2 lần');
  });

  it('không gợi ý khi thành công ngay lần đầu', () => {
    expect(suggestLessonFromDebug('npm test', 1)).toBeNull();
  });
});
