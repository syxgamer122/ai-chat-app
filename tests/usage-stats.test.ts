import { describe, expect, it } from 'vitest';
import {
  aggregateUsage,
  extractUsage,
  formatTokens,
  type UsageRow,
} from '@/lib/usage-stats';

const DAY = 86_400_000;

describe('usage-stats — thống kê token', () => {
  it('extractUsage chỉ nhận message assistant có annotation usage', () => {
    const assistant = {
      role: 'assistant',
      createdAt: 1000,
      annotations: [
        { requestId: 'r1', model: 'qwen3.8-max' },
        { usage: { promptTokens: 120, completionTokens: 80 }, model: 'qwen3.8-max' },
      ],
    };
    expect(extractUsage(assistant)).toEqual({
      model: 'qwen3.8-max',
      promptTokens: 120,
      completionTokens: 80,
      ts: 1000,
    });
    expect(extractUsage({ role: 'user', annotations: [{ usage: { promptTokens: 1, completionTokens: 1 } }] })).toBeNull();
    expect(extractUsage({ role: 'assistant', annotations: [] })).toBeNull();
    expect(extractUsage({ role: 'assistant', annotations: [{ usage: { promptTokens: 0, completionTokens: 0 } }] })).toBeNull();
  });

  it('extractUsage lấy model từ annotation liền trước nếu usage không kèm model', () => {
    const row = extractUsage({
      role: 'assistant',
      createdAt: 5,
      annotations: [{ model: 'claude-sonnet-5' }, { usage: { promptTokens: 10, completionTokens: 5 } }],
    });
    expect(row?.model).toBe('claude-sonnet-5');
  });

  it('aggregateUsage gộp theo model + lọc theo ngày', () => {
    const now = Date.now();
    const rows: UsageRow[] = [
      { model: 'a', promptTokens: 100, completionTokens: 50, ts: now - DAY },
      { model: 'a', promptTokens: 10, completionTokens: 5, ts: now - 10 * DAY },
      { model: 'b', promptTokens: 1, completionTokens: 1, ts: now - 10 * DAY },
    ];
    const all = aggregateUsage(rows, 0);
    expect(all.messages).toBe(3);
    expect(all.promptTokens).toBe(111);
    expect(all.byModel[0].model).toBe('a'); // tổng lớn hơn đứng đầu

    const week = aggregateUsage(rows, 7);
    expect(week.messages).toBe(1);
    expect(week.byModel).toHaveLength(1);
    expect(week.byDay).toHaveLength(1);
  });

  it('byDay nhóm theo ngày địa phương và sort tăng dần', () => {
    const rows: UsageRow[] = [
      { model: 'a', promptTokens: 1, completionTokens: 0, ts: Date.now() - 2 * DAY },
      { model: 'a', promptTokens: 2, completionTokens: 0, ts: Date.now() },
    ];
    const s = aggregateUsage(rows, 0);
    expect(s.byDay.length).toBe(2);
    expect(s.byDay[0].day < s.byDay[1].day).toBe(true);
  });

  it('formatTokens rút gọn đẹp', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1200)).toBe('1.2k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});
