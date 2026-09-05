import { describe, expect, it } from 'vitest';
import { fmt, computeMeter } from '@/components/context-meter';

describe('ContextMeter — fmt token', () => {
  it('dưới 1k giữ nguyên số', () => {
    expect(fmt(0)).toBe('0');
    expect(fmt(999)).toBe('999');
  });

  it('1k..100k hiển thị "12.3k", bỏ ".0" cho số chẵn', () => {
    expect(fmt(1000)).toBe('1k');
    expect(fmt(12345)).toBe('12.3k');
    expect(fmt(200000)).toBe('200k');
  });

  it('từ 100k làm tròn cho gọn', () => {
    expect(fmt(100000)).toBe('100k');
    expect(fmt(123456)).toBe('123k');
  });

  it('từ 1M sang đơn vị M, số chẵn bỏ thập phân', () => {
    expect(fmt(1_000_000)).toBe('1M');
    expect(fmt(1_500_000)).toBe('1.5M');
    expect(fmt(2_000_000)).toBe('2M');
  });
});

describe('ContextMeter — computeMeter (clamp & tone)', () => {
  it('bình thường: percent đúng, tone ok, fill = ratio', () => {
    const m = computeMeter(12345, 200000);
    expect(m.percent).toBe(6);
    expect(m.fillRatio).toBeCloseTo(0.061725, 5);
    expect(m.tone).toBe('ok');
    expect(m.safeMax).toBe(200000);
  });

  it('used = 0: thanh rỗng, tone ok', () => {
    const m = computeMeter(0, 200000);
    expect(m.percent).toBe(0);
    expect(m.fillRatio).toBe(0);
    expect(m.tone).toBe('ok');
  });

  it('warning khi ≥75%, error khi ≥90%', () => {
    expect(computeMeter(150000, 200000).tone).toBe('warning'); // 75%
    expect(computeMeter(180000, 200000).tone).toBe('error'); // 90%
    expect(computeMeter(199999, 200000).tone).toBe('error');
  });

  it('used > max: percent KHÔNG clamp (user thấy vượt trần), thanh clamp 100%', () => {
    const m = computeMeter(250000, 200000);
    expect(m.percent).toBe(125);
    expect(m.fillRatio).toBe(1);
    expect(m.tone).toBe('error');
  });

  it('max = 0: safeMax = 1, không chia cho 0, không NaN', () => {
    const m = computeMeter(500, 0);
    expect(m.safeMax).toBe(1);
    expect(Number.isFinite(m.ratio)).toBe(true);
    expect(m.fillRatio).toBe(1);
    expect(m.tone).toBe('error');
  });

  it('used âm bị clamp về 0', () => {
    const m = computeMeter(-50, 200000);
    expect(m.percent).toBe(0);
    expect(m.fillRatio).toBe(0);
  });
});
