/**
 * Tests cho con trỏ key mã hoá provider (giai đoạn 2 — desktop tự chủ).
 *
 * Module thuần, lookup vault TIÊM được nên chạy node thuần không cần Electron.
 * Trường hợp "không truyền lookup" mô phỏng web (desktopSecureStore() = null
 * vì window không tồn tại trong môi trường test node).
 */
import { describe, it, expect } from 'vitest';
import {
  SECURE_KEY_MARKER,
  isSecureKeyPointer,
  secureKeyOf,
  resolveProviderApiKey,
} from '@/lib/provider-secure-key';

describe('isSecureKeyPointer', () => {
  it('nhận con trỏ "@secure:"', () => {
    expect(isSecureKeyPointer(SECURE_KEY_MARKER)).toBe(true);
    expect(isSecureKeyPointer('@secure:')).toBe(true);
  });

  it('key thường / rỗng / undefined KHÔNG phải con trỏ', () => {
    expect(isSecureKeyPointer('sk-live-123')).toBe(false);
    expect(isSecureKeyPointer('')).toBe(false);
    expect(isSecureKeyPointer(undefined)).toBe(false);
    expect(isSecureKeyPointer(null)).toBe(false);
  });

  it('key người dùng bắt đầu "@secure:" là tài liệu của chính họ — vẫn coi là con trỏ (đánh đổi chấp nhận: marker dành riêng cho vault)', () => {
    // Ghi rõ chủ đích: prefix này do app sở hữu; xác suất key thật trùng là bỏ qua.
    expect(isSecureKeyPointer('@secure:khong-ton-tai')).toBe(true);
  });
});

describe('secureKeyOf', () => {
  it('namespaced "provider:" + id', () => {
    expect(secureKeyOf('abc-123')).toBe('provider:abc-123');
  });
});

describe('resolveProviderApiKey', () => {
  it('key thường → trả nguyên vẹn (không đụng vault)', async () => {
    const lookup = { get: async () => { throw new Error('không được gọi'); } };
    await expect(
      resolveProviderApiKey('sk-live-123', 'p1', lookup),
    ).resolves.toBe('sk-live-123');
  });

  it('key rỗng / undefined → ""', async () => {
    await expect(resolveProviderApiKey('', 'p1', null)).resolves.toBe('');
    await expect(resolveProviderApiKey(undefined, 'p1', null)).resolves.toBe('');
  });

  it('con trỏ + vault có key → trả key thật', async () => {
    const lookup = { get: async (k: string) => ({ value: k === 'provider:p1' ? 'sk-real' : null }) };
    await expect(resolveProviderApiKey(SECURE_KEY_MARKER, 'p1', lookup)).resolves.toBe('sk-real');
  });

  it('con trỏ + vault KHÔNG có entry → "" (không ném)', async () => {
    const lookup = { get: async () => ({ value: null }) };
    await expect(resolveProviderApiKey(SECURE_KEY_MARKER, 'p1', lookup)).resolves.toBe('');
  });

  it('con trỏ + vault ném lỗi → "" — lỗi vault không được làm hỏng snapshot', async () => {
    const lookup = { get: async () => { throw new Error('boom'); } };
    await expect(resolveProviderApiKey(SECURE_KEY_MARKER, 'p1', lookup)).resolves.toBe('');
  });

  it('con trỏ + KHÔNG có vault (web / shell cũ) → "" — key mã hoá chỉ dùng trên máy đã lưu', async () => {
    await expect(resolveProviderApiKey(SECURE_KEY_MARKER, 'p1', null)).resolves.toBe('');
  });

  it('mặc định không truyền lookup trong môi trường node (window undefined) → "" cho con trỏ', async () => {
    // desktopSecureStore() đọc window — trong vitest node không có window.
    await expect(resolveProviderApiKey(SECURE_KEY_MARKER, 'p1')).resolves.toBe('');
  });
});
