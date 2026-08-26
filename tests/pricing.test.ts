import { describe, expect, it } from 'vitest';
import { estimateCallCostUsd, findModelPrice } from '@/lib/pricing';

describe('findModelPrice — match fragment dài nhất', () => {
  it('"gpt-4o-mini" phải khớp mini trước gpt-4o (giá rẻ hơn nhiều)', () => {
    const p = findModelPrice('gpt-4o-mini');
    expect(p).toEqual({ in: 0.15, out: 0.6 });
  });

  it('prefix vendor không cản trở match ("openai/gpt-4o", "crax/claude-sonnet-4")', () => {
    expect(findModelPrice('openai/gpt-4o')?.in).toBe(2.5);
    expect(findModelPrice('crax/claude-sonnet-4')?.out).toBe(15.0);
  });

  it('model local/free không nhận diện → null (không bịa tiền)', () => {
    expect(findModelPrice('llama3.2-local')).toBeNull();
    expect(findModelPrice('ollama/qwen3.8-max-preview')).toBeNull();
    expect(findModelPrice('')).toBeNull();
  });
});

describe('estimateCallCostUsd', () => {
  it('tính đúng công thức USD trên 1M token', () => {
    // deepseek-chat: in 0.14, out 0.28
    const usd = estimateCallCostUsd('deepseek-chat', 1_000_000, 500_000);
    expect(usd).toBeCloseTo(0.14 + 0.28 * 0.5, 6);
  });

  it('model không có giá → null thay vì 0$', () => {
    expect(estimateCallCostUsd('mystery-model', 1000, 2000)).toBeNull();
  });
});
