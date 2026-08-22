import { describe, expect, it } from 'vitest';
import { isBackupDue } from '@/lib/auto-backup';
import { filterPrompts } from '@/lib/prompt-library';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

describe('isBackupDue', () => {
  it('chưa backup lần nào → luôn đến hạn', () => {
    expect(isBackupDue(null, 7, NOW)).toBe(true);
  });

  it('trong chu kỳ → chưa đến hạn', () => {
    expect(isBackupDue(NOW - 3 * DAY, 7, NOW)).toBe(false);
  });

  it('vượt chu kỳ → đến hạn (đúng biên >= interval)', () => {
    expect(isBackupDue(NOW - 7 * DAY, 7, NOW)).toBe(true);
    expect(isBackupDue(NOW - 7 * DAY - 1, 7, NOW)).toBe(true);
  });

  it('timestamp rác (0, âm) coi như chưa backup', () => {
    expect(isBackupDue(0, 7, NOW)).toBe(true);
    expect(isBackupDue(-5, 7, NOW)).toBe(true);
  });
});

describe('filterPrompts — slash menu', () => {
  const prompts = [
    { id: '1', title: 'Dịch Trung - Việt', content: 'Bạn là dịch giả...' },
    { id: '2', title: 'Dịch Anh - Việt', content: 'Translate...' },
    { id: '3', title: 'Giải thích code', content: 'dịch thuật sang plain text' },
    { id: '4', title: 'Tóm tắt văn bản', content: 'Tóm tắt...' },
  ];

  it('query rỗng → trả mặc định (đầu danh sách, giới hạn limit)', () => {
    const all = filterPrompts(prompts, '');
    expect(all).toHaveLength(4);
    expect(filterPrompts([...prompts, ...prompts.map((p) => ({ ...p, id: p.id + 'x' }))], '', 8)).toHaveLength(8);
  });

  it('ưu tiên title startsWith > title includes > content includes', () => {
    const result = filterPrompts(prompts, 'dịch');
    expect(result.map((p) => p.id)).toEqual(['1', '2', '3']);
  });

  it('khớp không phân biệt hoa thường và bỏ khoảng trắng', () => {
    expect(filterPrompts(prompts, '  TOM TAT ')).toEqual([
      expect.objectContaining({ id: '4' }),
    ]);
  });

  it('không khớp → mảng rỗng (menu đóng)', () => {
    expect(filterPrompts(prompts, 'zzz')).toEqual([]);
  });
});
