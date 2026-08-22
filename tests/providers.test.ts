import { describe, expect, it } from 'vitest';
import {
  validateProviderBaseUrl,
  normalizeProviderModels,
} from '@/lib/providers';

describe('providers — provider presets', () => {
  it('chấp nhận https hợp lệ và strip slash cuối', () => {
    const r = validateProviderBaseUrl('https://gpt.crax.lol/v1/');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://gpt.crax.lol/v1');
  });

  it('từ chối http trừ localhost (dev)', () => {
    expect(validateProviderBaseUrl('http://gpt.crax.lol/v1').ok).toBe(false);
    expect(validateProviderBaseUrl('http://localhost:3000/v1').ok).toBe(true);
  });

  it('từ chối địa chỉ nội bộ (SSRF)', () => {
    expect(validateProviderBaseUrl('https://127.0.0.1/v1').ok).toBe(false);
    expect(validateProviderBaseUrl('https://192.168.1.10/v1').ok).toBe(false);
    expect(validateProviderBaseUrl('https://10.0.0.5/v1').ok).toBe(false);
    expect(validateProviderBaseUrl('https://172.16.0.1/v1').ok).toBe(false);
    expect(validateProviderBaseUrl('https://db.local/v1').ok).toBe(false);
  });

  it('từ chối rác / URL lỗi', () => {
    expect(validateProviderBaseUrl('').ok).toBe(false);
    expect(validateProviderBaseUrl('không-phải-url').ok).toBe(false);
    expect(validateProviderBaseUrl('ftp://x.com/v1').ok).toBe(false);
  });

  it('normalizeProviderModels chấp nhận nhiều dạng /models', () => {
    const out = normalizeProviderModels({
      data: [
        { id: 'qwen3.8-max', name: 'Qwen 3.8 Max', context_length: 131072 },
        { id: 'qwen3.8-max' },
        { id: '  gpt-5-6-sol  ' },
        { id: '' },
        'rác',
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('gpt-5-6-sol'); // sort theo id
    expect(out[1].contextLength).toBe(131072);
    expect(normalizeProviderModels({ data: 'không phải mảng' })).toEqual([]);
  });
});
