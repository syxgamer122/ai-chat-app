/**
 * Bảo vệ các thay đổi theo bản cập nhật lớn của crax ("User Accounts + API
 * Keys"). Điểm phá vỡ chính: gateway TỪNG bỏ qua Authorization hoàn toàn, nay
 * trả 401 auth_required cho cả request không key lẫn key rác.
 */

import { describe, expect, it } from 'vitest';
import { providerNeedsApiKey, supportsThinkingLevel, supportsMediaGeneration } from '@/lib/provider-url';
import { findModelPrice } from '@/lib/pricing';
import { detectMediaKind } from '@/lib/media-models';
import {
  AVAILABLE_MODELS,
  ALLOWED_MODEL_IDS,
  DEFAULT_MODEL_ID,
  MEDIA_MODELS,
  mediaKindOf,
  getModelConfig,
} from '@/lib/models';
import { sharedFreeBudget } from '@/lib/upstream-queue';

describe('crax chuyển sang mô hình tài khoản', () => {
  it('crax nay CẦN key — ô nhập key phải hiện lại trong Settings', () => {
    expect(providerNeedsApiKey('https://gpt.crax.lol/v1')).toBe(true);
  });

  it('vẫn nhận diện crax cho mức suy luận và media (regex host riêng, không bị ảnh hưởng)', () => {
    expect(supportsThinkingLevel('https://gpt.crax.lol/v1')).toBe(true);
    expect(supportsMediaGeneration('https://gpt.crax.lol/v1')).toBe(true);
  });

  it('ngân sách rate-limit dùng chung vẫn áp cho crax', () => {
    const budget = sharedFreeBudget('https://gpt.crax.lol/v1');
    expect(budget).not.toBeNull();
    // Không vượt mức công bố 5/10s và 20/60s.
    expect(budget!.per10).toBeLessThanOrEqual(5);
    expect(budget!.per60).toBeLessThanOrEqual(20);
  });
});

describe('danh mục model sau cập nhật', () => {
  it('gpt-image-2 có mặt và là model ảnh', () => {
    expect(ALLOWED_MODEL_IDS.has('gpt-image-2')).toBe(true);
    expect(mediaKindOf('gpt-image-2')).toBe('image');
  });

  it('grok-imagine-2 có mặt và là model ảnh', () => {
    expect(ALLOWED_MODEL_IDS.has('grok-imagine-2')).toBe(true);
    expect(mediaKindOf('grok-imagine-2')).toBe('image');
  });

  it('model media mới nằm trong MEDIA_MODELS', () => {
    const ids = MEDIA_MODELS.map((m) => m.id);
    expect(ids).toContain('gpt-image-2');
    expect(ids).toContain('grok-imagine-2');
  });

  it('KHÔNG còn model đã bị crax gỡ (GLM/Mercury/Seedance/Seedream)', () => {
    const removed = /glm|chatglm|mercury|seedance|seedream/i;
    for (const m of AVAILABLE_MODELS) {
      expect(m.id).not.toMatch(removed);
      expect(m.providerModel).not.toMatch(removed);
      for (const fb of m.providerModelFallbacks) expect(fb).not.toMatch(removed);
    }
  });

  /* crax dùng GẠCH NGANG cho số phiên bản. Catalog trước đây dùng dấu chấm
     nên mỗi lượt chat tốn một lần thử hỏng trước khi chain tự đổi sang bản
     gạch. Id chính phải là tên thật; bản chấm chỉ còn trong fallback. */
  it('model GPT dùng đúng tên gạch ngang của crax', () => {
    for (const id of ['gpt-5-6-sol', 'gpt-5-6-luna', 'gpt-5-6-terra', 'gpt-5-5']) {
      expect(ALLOWED_MODEL_IDS.has(id)).toBe(true);
      expect(getModelConfig(id).providerModel).toBe(id);
    }
  });

  it('id dấu chấm cũ vẫn resolve được (preset/localStorage cũ không vỡ)', () => {
    expect(getModelConfig('gpt-5.6-sol').id).toBe('gpt-5-6-sol');
    expect(getModelConfig('gpt-5.5').id).toBe('gpt-5-5');
  });

  it('DEFAULT_MODEL_ID trỏ tới model CÓ THẬT trong catalog', () => {
    // Sai điều này thì getModelConfig() throw ngay khi khởi động.
    expect(ALLOWED_MODEL_IDS.has(DEFAULT_MODEL_ID)).toBe(true);
    expect(getModelConfig(DEFAULT_MODEL_ID).id).toBe(DEFAULT_MODEL_ID);
  });

  it('deepseek-v4-flash (model gây log lỗi ban đầu) đã có trong catalog', () => {
    expect(ALLOWED_MODEL_IDS.has('deepseek-v4-flash')).toBe(true);
  });

  it('model ảnh mới không tự nhận là model chat (không bật vision/pdf nhầm)', () => {
    for (const id of ['gpt-image-2', 'grok-imagine-2']) {
      const cfg = getModelConfig(id);
      expect(cfg.category).toBe('media');
      expect(cfg.supportsImages).toBe(false);
      expect(cfg.supportsPdf).toBe(false);
    }
  });

  it('detectMediaKind nhận đúng model ảnh mới', () => {
    expect(detectMediaKind('gpt-image-2')).toBe('image');
    expect(detectMediaKind('grok-imagine-2')).toBe('image');
  });

  it('không nhầm model vision (đọc ảnh) thành model tạo ảnh', () => {
    expect(detectMediaKind('qwen-vl-max')).toBeUndefined();
  });
});

describe('giá DeepSeek V4 Pro (backend Notion, giá đỉnh DeepSeek)', () => {
  it('V4 Pro dùng giá riêng, không rơi vào fragment deepseek chung', () => {
    const p = findModelPrice('deepseek-v4-pro');
    expect(p).toEqual({ in: 0.435, out: 0.87 });
  });

  it('các model DeepSeek khác giữ nguyên giá cũ', () => {
    expect(findModelPrice('deepseek-chat')).toEqual({ in: 0.14, out: 0.28 });
    expect(findModelPrice('deepseek-reasoner')).toEqual({ in: 0.55, out: 2.19 });
  });

  it('prefix vendor không cản trở match', () => {
    expect(findModelPrice('crax/deepseek-v4-pro')?.in).toBe(0.435);
  });
});
