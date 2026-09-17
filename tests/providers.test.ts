import { describe, expect, it } from 'vitest';
import {
  validateProviderBaseUrl,
  normalizeProviderModels,
  providerNeedsApiKey,
} from '@/lib/providers';

describe('providers — provider presets', () => {
  it('chấp nhận https hợp lệ và strip slash cuối', () => {
    const r = validateProviderBaseUrl('https://api.openai.com/v1/');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://api.openai.com/v1');
  });

  it('từ chối http trừ localhost (dev)', () => {
    expect(validateProviderBaseUrl('http://api.example.com/v1').ok).toBe(false);
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
        { id: '  gpt-4o  ' },
        { id: '' },
        'rác',
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('gpt-4o'); // sort theo id
    expect(out[1].contextLength).toBe(131072);
    expect(normalizeProviderModels({ data: 'không phải mảng' })).toEqual([]);
  });
});

/**
 * Tầng gateway free (không cần key) đã gỡ hẳn — providerNeedsApiKey giờ luôn
 * trả true: mọi provider BYOK đều cần key, ô nhập key luôn hiện.
 */
describe('providerNeedsApiKey — BYOK-only', () => {
  it('mọi URL đều cần key', () => {
    expect(providerNeedsApiKey('https://api.openai.com/v1')).toBe(true);
    expect(providerNeedsApiKey('https://openrouter.ai/api/v1')).toBe(true);
    expect(providerNeedsApiKey('https://my-proxy.example.com/v1')).toBe(true);
  });

  it('rỗng / URL lỗi → mặc định an toàn là cần key', () => {
    expect(providerNeedsApiKey('')).toBe(true);
    expect(providerNeedsApiKey(null)).toBe(true);
    expect(providerNeedsApiKey(undefined)).toBe(true);
    expect(providerNeedsApiKey('không-phải-url')).toBe(true);
  });
});
