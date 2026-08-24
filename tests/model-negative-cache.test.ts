import { describe, expect, it, beforeEach } from 'vitest';
import {
  markModelUnsupported,
  isModelUnsupported,
  filterSupportedModels,
  modelCacheKey,
  resetModelNegativeCache,
} from '@/lib/model-negative-cache';

describe('model-negative-cache', () => {
  beforeEach(() => resetModelNegativeCache());

  it('mark rồi check trong TTL -> true, khác model/gateway -> false', () => {
    markModelUnsupported('https://gpt.crax.lol/v1', 'gpt-5.6-sol');
    expect(isModelUnsupported('https://gpt.crax.lol/v1', 'gpt-5.6-sol')).toBe(true);
    // Tên khác hoặc gateway khác không bị dính
    expect(isModelUnsupported('https://gpt.crax.lol/v1', 'gpt-5-6-sol')).toBe(false);
    expect(isModelUnsupported('https://openrouter.ai/api/v1', 'gpt-5.6-sol')).toBe(false);
  });

  it('hết TTL -> tự hết và xoá khỏi map', () => {
    const now = 1_000_000;
    markModelUnsupported('https://gpt.crax.lol/v1', 'm1', 5_000, now);
    expect(isModelUnsupported('https://gpt.crax.lol/v1', 'm1', now + 4_999)).toBe(true);
    expect(isModelUnsupported('https://gpt.crax.lol/v1', 'm1', now + 5_001)).toBe(false);
  });

  it('modelCacheKey chuẩn hoá host và tên model', () => {
    expect(modelCacheKey('https://GPT.Crax.lol/v1', 'GPT-5')).toBe('gpt.crax.lol::gpt-5');
    expect(modelCacheKey('not-a-url', 'M')).toBe('not-a-url::m');
  });

  it('filterSupportedModels bỏ tên chết, giữ thứ tự', () => {
    markModelUnsupported('https://gpt.crax.lol/v1', 'a');
    const chain = filterSupportedModels('https://gpt.crax.lol/v1', ['a', 'b', 'c']);
    expect(chain).toEqual(['b', 'c']);
  });

  it('lọc sạch chuỗi -> trả nguyên chuỗi gốc (cho cơ hội phục hồi)', () => {
    markModelUnsupported('https://gpt.crax.lol/v1', 'a');
    markModelUnsupported('https://gpt.crax.lol/v1', 'b');
    const chain = filterSupportedModels('https://gpt.crax.lol/v1', ['a', 'b']);
    expect(chain).toEqual(['a', 'b']);
  });

  it('chuỗi 1 phần tử không cần lọc', () => {
    markModelUnsupported('https://gpt.crax.lol/v1', 'a');
    expect(filterSupportedModels('https://gpt.crax.lol/v1', ['a'])).toEqual(['a']);
    expect(filterSupportedModels('', ['a'])).toEqual(['a']);
  });

  it('mark lại khi còn hạn -> gia hạn TTL mới', () => {
    const now = 1_000_000;
    markModelUnsupported('https://x/v1', 'm', 1_000, now);
    markModelUnsupported('https://x/v1', 'm', 10_000, now + 500);
    expect(isModelUnsupported('https://x/v1', 'm', now + 5_000)).toBe(true);
  });
});
