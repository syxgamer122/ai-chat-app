/**
 * Model KHÔNG có trong catalog + provider override.
 *
 * Lỗi thật đã gặp: gửi ảnh cho `gemma-3-12b` (crax có, catalog app chưa khai
 * báo) thì model trả "this model does not support image input". Nguyên nhân:
 * getModelConfig() rơi về model mặc định, mà mặc định có supportsImages=true,
 * nên vision-bridge không kích hoạt và ảnh đi thẳng lên model chữ thuần.
 *
 * Cách sửa: model lạ trên provider override → coi như KHÔNG xem được ảnh.
 * Sai hướng này chỉ làm ảnh bị mô tả bằng chữ (vẫn dùng được); sai hướng kia
 * làm hỏng hẳn lượt chat.
 */

import { describe, expect, it } from 'vitest';
import { findModelConfig, getModelConfig } from '@/lib/models';
import { shouldBridgeImages } from '@/lib/vision-bridge';

/** Phản chiếu logic trong app/api/chat/route.ts. */
function resolveConfig(selectedModelId: string, providerBase?: string) {
  const baseConfig = getModelConfig(selectedModelId);
  const isUnknownOverride =
    Boolean(providerBase) && findModelConfig(selectedModelId) === undefined;
  return providerBase
    ? {
        ...baseConfig,
        providerModel: selectedModelId,
        ...(isUnknownOverride ? { supportsImages: false, supportsPdf: false } : {}),
      }
    : baseConfig;
}

const OVERRIDE = 'https://gpt.crax.lol/v1';

describe('model lạ trên provider override', () => {
  it.each(['qwen3.6-plus', 'gemma-3-12b', 'model-tu-che-abc'])(
    'coi như không xem được ảnh: %s',
    (id) => {
      const c = resolveConfig(id, OVERRIDE);
      expect(c.supportsImages).toBe(false);
      expect(c.supportsPdf).toBe(false);
      // Bridge bật ⇒ ảnh sẽ được mô tả bằng chữ thay vì gửi thô.
      expect(shouldBridgeImages(c)).toBe(true);
    },
  );

  it('vẫn gửi ĐÚNG tên model lạ lên gateway (không thay bằng model mặc định)', () => {
    expect(resolveConfig('gemma-3-12b', OVERRIDE).providerModel).toBe('gemma-3-12b');
  });
});

describe('model CÓ trong catalog — capability giữ nguyên', () => {
  it('model vision vẫn nhận ảnh', () => {
    const c = resolveConfig('gpt-5-6-sol', OVERRIDE);
    expect(c.supportsImages).toBe(true);
    expect(shouldBridgeImages(c)).toBe(false);
  });

  it('model chữ thuần vẫn bật bridge', () => {
    const c = resolveConfig('deepseek-v4-flash', OVERRIDE);
    expect(c.supportsImages).toBe(false);
    expect(shouldBridgeImages(c)).toBe(true);
  });
});

describe('KHÔNG dùng override — hành vi cũ không đổi', () => {
  it('model lạ vẫn fallback về mặc định như trước', () => {
    const c = resolveConfig('model-tu-che-abc');
    expect(c.supportsImages).toBe(true);
  });
});
