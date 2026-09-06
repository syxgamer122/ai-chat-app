/**
 * RED TEAM - fmtCtx (lib/model-meta.ts) ở biên từng mốc.
 *
 * Chuẩn phòng thủ theo docstring: rác (âm/NaN/vô hạn) trả ''; mốc triệu
 * in 'M' một chữ số thập phân; dưới 1M in 'k'; dưới 1000 in số nguyên
 * KHÔNG kèm đơn vị. Giá trị 999_999 đã làm tròn lên 1000k nên hiển thị
 * đúng chuẩn phải là '1M', không phải '1000k'.
 */
import { describe, expect, it } from 'vitest';
import { fmtCtx } from '@/lib/model-meta';

describe('RED TEAM fmtCtx - giá trị rác và zero', () => {
  it('0, -5, NaN, Infinity, -0 trả chuỗi rỗng', () => {
    expect(fmtCtx(0)).toBe('');
    expect(fmtCtx(-5)).toBe('');
    expect(fmtCtx(Number.NaN)).toBe('');
    expect(fmtCtx(Number.POSITIVE_INFINITY)).toBe('');
    expect(fmtCtx(Number.NEGATIVE_INFINITY)).toBe('');
    expect(fmtCtx(-0)).toBe('');
  });
});

describe('RED TEAM fmtCtx - dưới 1000 không kèm đơn vị', () => {
  it('0.5 và 999.49 làm tròn nguyên, không có hậu tố', () => {
    expect(fmtCtx(0.5)).toMatch(/^\d+$/);
    expect(fmtCtx(0.5)).toBe('1');
    expect(fmtCtx(999.49)).toBe('999');
  });

  it('999.99 vẫn phải là số trần không hậu tố (tuy có làm tròn thành 1000)', () => {
    expect(fmtCtx(999.99)).toMatch(/^\d+$/);
  });
});

describe('RED TEAM fmtCtx - biên mốc k', () => {
  it('999_999 làm tròn thành 1000k nên phải hiển thị dạng M', () => {
    expect(fmtCtx(999_999)).toBe('1M');
  });

  it('1_000_000 đúng mốc M', () => {
    expect(fmtCtx(1_000_000)).toBe('1M');
  });
});

describe('RED TEAM fmtCtx - làm tròn M một chữ số thập phân', () => {
  it('1_050_000 → 1.1M; 1_950_000 → 2M', () => {
    expect(fmtCtx(1_050_000)).toBe('1.1M');
    expect(fmtCtx(1_950_000)).toBe('2M');
  });

  it('số khổng lồ (1e15, MAX_SAFE_INTEGER) không throw, ra dạng M hữu hạn', () => {
    expect(fmtCtx(1e15)).toMatch(/^[\d.]+M$/);
    expect(fmtCtx(Number.MAX_SAFE_INTEGER)).toMatch(/^[\d.]+M$/);
    expect(Number.isFinite(Number.NaN)).toBe(false);
  });
});
