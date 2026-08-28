import { describe, expect, it } from 'vitest';
import {
  validateProviderBaseUrl,
  normalizeProviderModels,
  providerNeedsApiKey,
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

/**
 * Gateway free xác thực bằng IP, không đọc Authorization (kiểm chứng bằng
 * request thật: key rác / không key vẫn 200, 429 áp theo IP kể cả khi mỗi
 * request dùng key khác nhau). Ô nhập key phải bị ẩn cho các host này.
 */
describe('providerNeedsApiKey — gateway free không dùng key', () => {
  /* crax ĐÃ RỜI nhóm này: bản cập nhật "User Accounts + API Keys" khiến mọi
     endpoint trả 401 auth_required cho cả request không key lẫn key rác
     (kiểm chứng bằng request thật tới /v1/models). Ô nhập key phải HIỆN lại,
     nếu không người dùng không có chỗ dán key crk_live_… và sẽ kẹt ở 401. */
  it('crax: NAY cần key (gateway đã chuyển sang mô hình tài khoản)', () => {
    expect(providerNeedsApiKey('https://gpt.crax.lol/v1')).toBe(true);
    expect(providerNeedsApiKey('https://GPT.CRAX.LOL/v1/')).toBe(true);
    expect(providerNeedsApiKey('https://gpt.crax.lol')).toBe(true);
  });

  it('Kilgore: NAY cần key (chuyển sang kilgoreai.xyz + hỗ trợ Bearer)', () => {
    expect(providerNeedsApiKey('https://kilgoreai.xyz/v1')).toBe(true);
    expect(providerNeedsApiKey('https://kilgoreai.xyz')).toBe(true);
  });

  it('không phân biệt hoa thường và dung sai path/slash', () => {
    expect(providerNeedsApiKey('https://KILGOREAI.XYZ/v1/')).toBe(true);
  });

  it('gateway key cá nhân: vẫn cần key', () => {
    expect(providerNeedsApiKey('https://openrouter.ai/api/v1')).toBe(true);
    expect(providerNeedsApiKey('https://api.orcarouter.ai/v1')).toBe(true);
    expect(providerNeedsApiKey('https://tokenin.my.id/v1')).toBe(true);
  });

  it('khớp đúng hostname, không khớp chuỗi con — chống host giả mạo', () => {
    // Kẻ tấn công dựng host chứa tên gateway free để lừa ẩn ô key.
    expect(providerNeedsApiKey('https://gpt.crax.lol.evil.com/v1')).toBe(true);
    expect(providerNeedsApiKey('https://evil.com/gpt.crax.lol/v1')).toBe(true);
    expect(providerNeedsApiKey('https://notgpt.crax.lol/v1')).toBe(true);
  });

  it('rỗng / URL lỗi → mặc định an toàn là cần key', () => {
    expect(providerNeedsApiKey('')).toBe(true);
    expect(providerNeedsApiKey(null)).toBe(true);
    expect(providerNeedsApiKey(undefined)).toBe(true);
    expect(providerNeedsApiKey('không-phải-url')).toBe(true);
  });
});
