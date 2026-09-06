import { describe, expect, it } from 'vitest';
import { extractMessageUsage, formatMessageUsage } from '@/lib/message-usage';

/*
 * Mỗi test ghi chú mutation nó bắt được (đảo điều kiện nào thì đỏ).
 * Bảng giá thật từ lib/pricing: gpt-4o = 2.5 in / 10.0 out mỗi 1M token.
 */

describe('extractMessageUsage', () => {
  it('usage thật đầy đủ: giữ đủ số, est false, có chi phí theo bảng giá', () => {
    const s = extractMessageUsage([
      { usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 }, model: 'gpt-4o' },
    ])!;
    expect(s.promptTokens).toBe(1_000_000);
    expect(s.completionTokens).toBe(1_000_000);
    expect(s.estimated).toBe(false);
    // 1M * 2.5 + 1M * 10.0 = 12.5 USD
    expect(s.costUsd).toBeCloseTo(12.5, 6);
  });

  it('est: true (gateway không báo usage) → không dám tính chi phí', () => {
    const s = extractMessageUsage([
      { usage: { promptTokens: 0, completionTokens: 480 }, model: 'qwen3.5-flash', est: true },
    ])!;
    expect(s.estimated).toBe(true);
    expect(s.costUsd).toBeNull();
  });

  it('model lạ không có bảng giá → costUsd null, không bịa tiền', () => {
    const s = extractMessageUsage([
      { usage: { promptTokens: 100, completionTokens: 50 }, model: 'model-tu-che-abc' },
    ])!;
    expect(s.costUsd).toBeNull();
  });

  it('lấy annotation usage CUỐI CÙNG khi có nhiều bản ghi qua các bước tool', () => {
    const s = extractMessageUsage([
      { usage: { promptTokens: 10, completionTokens: 5 }, model: 'gpt-4o' },
      { usage: { promptTokens: 999, completionTokens: 42 }, model: 'gpt-4o', durationMs: 4500 },
    ])!;
    expect(s.promptTokens).toBe(999);
    expect(s.durationMs).toBe(4500);
  });

  it('durationMs rác (chuỗi, âm, NaN) → null; hợp lệ → giữ nguyên', () => {
    const bad = extractMessageUsage([
      { usage: { promptTokens: 5, completionTokens: 5 }, model: 'gpt-4o', durationMs: '4500' as unknown },
    ])!;
    expect(bad.durationMs).toBeNull();
    const neg = extractMessageUsage([
      { usage: { promptTokens: 5, completionTokens: 5 }, model: 'gpt-4o', durationMs: -1 },
    ])!;
    expect(neg.durationMs).toBeNull();
  });

  it('không có usage hoặc cả hai số 0 → null (không render dòng chết)', () => {
    expect(extractMessageUsage(undefined)).toBeNull();
    expect(extractMessageUsage('rác' as unknown)).toBeNull();
    expect(extractMessageUsage([{ khac: 1 }])).toBeNull();
    expect(
      extractMessageUsage([{ usage: { promptTokens: 0, completionTokens: 0 }, model: 'gpt-4o' }]),
    ).toBeNull();
  });
});

describe('formatMessageUsage', () => {
  it('đủ các phần, nối bằng " · ", ≈ chỉ đứng trước ↓ khi ước lượng', () => {
    const real = formatMessageUsage({
      promptTokens: 1200,
      completionTokens: 300,
      estimated: false,
      model: 'gpt-4o',
      durationMs: 4250,
      costUsd: 0.006,
    });
    expect(real).toBe('↑1200 · ↓300 · 4.3s · $0.0060');

    const est = formatMessageUsage({
      promptTokens: 0,
      completionTokens: 480,
      estimated: true,
      model: null,
      durationMs: 820,
      costUsd: null,
    });
    expect(est).toBe('≈↓480 · 0.8s');
  });

  it('chi phí nhỏ hơn 1 cent giữ 4 số lẻ để còn đọc được', () => {
    const s = formatMessageUsage({
      promptTokens: 1000,
      completionTokens: 100,
      estimated: false,
      model: 'gpt-4o',
      durationMs: null,
      costUsd: 0.0035,
    });
    expect(s).toBe('↑1000 · ↓100 · $0.0035');
  });

  it('promptTokens 0 bị bỏ hẳn (gateway null thường chỉ có output)', () => {
    const s = formatMessageUsage({
      promptTokens: 0,
      completionTokens: 42,
      estimated: false,
      model: 'gpt-4o',
      durationMs: 1000,
      costUsd: null,
    });
    expect(s.startsWith('↑')).toBe(false);
    expect(s).toBe('↓42 · 1.0s');
  });
});
