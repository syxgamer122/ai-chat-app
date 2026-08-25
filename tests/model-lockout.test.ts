import { beforeEach, describe, expect, it } from 'vitest';
import {
  decayModelFailure,
  filterLockedModels,
  isModelLockedOut,
  markModelFailure,
  resetModelLockout,
} from '@/lib/model-lockout';

const BASE = 'https://gw.example.com/v1';
const NOW = 1_700_000_000_000;

describe('model lockout per key×model', () => {
  beforeEach(() => resetModelLockout());

  it('mới fail 1 lần → khóa ngắn; fail liên tiếp → backoff mũ trần 10 phút', () => {
    markModelFailure(BASE, 'k1', 'gpt-x', NOW);
    expect(isModelLockedOut(BASE, 'k1', 'gpt-x', NOW + 30_000)).toBe(true);
    expect(isModelLockedOut(BASE, 'k1', 'gpt-x', NOW + 61_000)).toBe(false);

    for (let i = 0; i < 6; i++) markModelFailure(BASE, 'k1', 'gpt-x', NOW);
    // 2^(7-1)=64 phút → chạm trần 10 phút.
    const until = isModelLockedOut(BASE, 'k1', 'gpt-x', NOW + 9 * 60_000);
    expect(until).toBe(true);
    expect(isModelLockedOut(BASE, 'k1', 'gpt-x', NOW + 10 * 60_000 + 1)).toBe(false);
  });

  it('tách bạch theo KEY: model chết trên k1 không khóa trên k2', () => {
    markModelFailure(BASE, 'k1', 'gpt-x', NOW);
    expect(isModelLockedOut(BASE, 'k2', 'gpt-x', NOW)).toBe(false);
  });

  it('success-decay: chia đôi đếm, mở khóa ngay nhưng không quên lịch sử', () => {
    for (let i = 0; i < 4; i++) markModelFailure(BASE, 'k1', 'gpt-x', NOW); // failures=4
    decayModelFailure(BASE, 'k1', 'gpt-x'); // → 2
    // Mở khóa ngay (until=0)...
    expect(isModelLockedOut(BASE, 'k1', 'gpt-x', NOW)).toBe(false);
    // ...nhưng fail kế tiếp backoff từ mức 2 (2 phút) chứ không từ mức 1.
    markModelFailure(BASE, 'k1', 'gpt-x', NOW); // → 3
    expect(isModelLockedOut(BASE, 'k1', 'gpt-x', NOW + 90_000)).toBe(true);
  });

  it('decay đủ nhiều lần → xoá hẳn khỏi map', () => {
    markModelFailure(BASE, 'k1', 'gpt-x', NOW); // 1
    decayModelFailure(BASE, 'k1', 'gpt-x'); // floor(1/2)=0 → xoá
    markModelFailure(BASE, 'k1', 'gpt-x', NOW); // lại từ đầu = 1
    expect(isModelLockedOut(BASE, 'k1', 'gpt-x', NOW + 30_000)).toBe(true);
    expect(isModelLockedOut(BASE, 'k1', 'gpt-x', NOW + 61_000)).toBe(false);
  });

  it('filterLockedModels: lọc ô khóa của key đó, sạch thì trả nguyên chuỗi', () => {
    const chain = ['a', 'b', 'c'];
    markModelFailure(BASE, 'k1', 'B', NOW);
    expect(filterLockedModels(BASE, 'k1', chain.map((m) => m.toUpperCase()), NOW)).toEqual([
      'A',
      'C',
    ]);
    // Khóa hết → vẫn trả nguyên chuỗi để còn cơ hội thử thật.
    for (const m of ['a', 'b', 'c']) markModelFailure(BASE, 'k1', m.toUpperCase(), NOW);
    expect(filterLockedModels(BASE, 'k1', ['A', 'B', 'C'], NOW)).toEqual(['A', 'B', 'C']);
    // Chuỗi 1 phần tử — không cần lọc.
    expect(filterLockedModels(BASE, 'k1', ['only'], NOW)).toEqual(['only']);
  });
});
