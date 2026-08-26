import { describe, expect, it } from 'vitest';
import { lineDiff, renderUnifiedDiff, type DiffLine } from '@/lib/naive-diff';

describe('lineDiff — trim prefix/suffix chung', () => {
  it('sửa giữa file: same → del → add → same', () => {
    const d = lineDiff('a\nb\nc\nd', 'a\nb\nC\nd');
    expect(d).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'del', text: 'c' },
      { type: 'add', text: 'C' },
      { type: 'same', text: 'd' },
    ]);
  });

  it('tạo file mới: toàn add', () => {
    const d = lineDiff('', 'x\ny');
    expect(d.every((l) => l.type === 'add')).toBe(true);
    expect(d).toHaveLength(2);
  });

  it('xóa nội dung: toàn del', () => {
    const d = lineDiff('x\ny', '');
    expect(d.every((l) => l.type === 'del')).toBe(true);
  });

  it('giống hệt nhau → toàn same, không del/add', () => {
    const d = lineDiff('a\nb', 'a\nb');
    expect(d.some((l) => l.type !== 'same')).toBe(false);
  });
});

describe('renderUnifiedDiff — co cụm dòng không đổi', () => {
  it('cắt vùng same dài thành "…" với contextLines', () => {
    const lines: DiffLine[] = [
      ...Array.from({ length: 50 }, (_, i) => ({ type: 'same' as const, text: `s${i}` })),
      { type: 'add', text: 'NEW LINE' },
      ...Array.from({ length: 50 }, (_, i) => ({ type: 'same' as const, text: `e${i}` })),
    ];
    const r = renderUnifiedDiff(lines, { contextLines: 1 });
    expect(r.adds).toBe(1);
    expect(r.dels).toBe(0);
    expect(r.text).toContain('…');
    expect(r.text.split('\n').length).toBeLessThan(20);
  });

  it('đếm adds/dels đúng', () => {
    const d = lineDiff('keep\nold1\nold2\nkeep2', 'keep\nnew1\nnew2\nnew3\nkeep2');
    const r = renderUnifiedDiff(d, { contextLines: 0 });
    expect(r.dels).toBe(2);
    expect(r.adds).toBe(3);
  });

  it('trần maxChars cắt kèm chú thích', () => {
    const big = lineDiff('a\n'.repeat(2000), 'b\n'.repeat(2000));
    const r = renderUnifiedDiff(big, { contextLines: 0, maxChars: 500 });
    expect(r.text.length).toBeLessThanOrEqual(520);
    expect(r.text.endsWith('[đã cắt]')).toBe(true);
  });
});
