import { describe, expect, it } from 'vitest';
import {
  detectMediaKind,
  isSameFamilyAsMedia,
  modelFamily,
  pickMediaModels,
} from '@/lib/media-models';

describe('detectMediaKind', () => {
  it('nhận diện model tạo ảnh', () => {
    expect(detectMediaKind('qwen-image-3.0-pro')).toBe('image');
    expect(detectMediaKind('flux-schnell')).toBe('image');
    expect(detectMediaKind('dall-e-3')).toBe('image');
    expect(detectMediaKind('stable-diffusion-xl')).toBe('image');
    expect(detectMediaKind('seedream-4')).toBe('image');
  });

  it('nhận diện model tạo video, ưu tiên hơn từ khoá ảnh', () => {
    expect(detectMediaKind('qwen-video')).toBe('video');
    expect(detectMediaKind('kling-v2')).toBe('video');
    expect(detectMediaKind('grok-imagine-image-to-video')).toBe('video');
    expect(detectMediaKind('wan2.5-t2v')).toBe('video');
  });

  it('không coi model chat / vision là model sinh media', () => {
    expect(detectMediaKind('gpt-5.6-sol')).toBeUndefined();
    expect(detectMediaKind('claude-opus-5')).toBeUndefined();
    expect(detectMediaKind('qwen3-vl-plus')).toBeUndefined();
    expect(detectMediaKind('gemini-3-1-pro')).toBeUndefined();
  });

  it('dùng được cả nhãn khi id không nói gì', () => {
    expect(detectMediaKind('mdl-7712', 'Tạo ảnh nhanh · flux')).toBe('image');
  });
});

describe('pickMediaModels', () => {
  const catalog = [
    { id: 'gpt-5.6-sol', label: 'ChatGPT-5.6 Sol' },
    { id: 'qwen-image-2.0-pro', label: 'Qwen Image 2.0 Pro' },
    { id: 'qwen-image-3.0-pro', label: 'Qwen Image 3.0 Pro' },
    { id: 'qwen-video', label: 'Qwen Video' },
  ];

  it('chọn model ảnh phiên bản cao nhất và model video', () => {
    const picked = pickMediaModels(catalog);
    expect(picked.image?.id).toBe('qwen-image-3.0-pro');
    expect(picked.video?.id).toBe('qwen-video');
  });

  it('trả về rỗng khi nhà cung cấp không có model media', () => {
    expect(pickMediaModels([{ id: 'gpt-4o', label: 'GPT-4o' }])).toEqual({});
  });

  it('chỉ có ảnh thì không dựng nút video', () => {
    const picked = pickMediaModels([{ id: 'flux-pro', label: 'FLUX Pro' }]);
    expect(picked.image?.id).toBe('flux-pro');
    expect(picked.video).toBeUndefined();
  });
});

describe('modelFamily', () => {
  it('bỏ số phiên bản và tiền tố vendor', () => {
    expect(modelFamily('qwen3.8-max')).toBe('qwen');
    expect(modelFamily('qwen-image-3.0-pro')).toBe('qwen');
    expect(modelFamily('qwen/qwen3-max')).toBe('qwen');
    expect(modelFamily('gpt-5.6-sol')).toBe('gpt');
    expect(modelFamily('claude-opus-5')).toBe('claude');
    expect(modelFamily(undefined)).toBe('');
  });
});

describe('isSameFamilyAsMedia', () => {
  const picked = pickMediaModels([
    { id: 'qwen-image-3.0-pro', label: 'Qwen Image 3.0 Pro' },
    { id: 'qwen-video', label: 'Qwen Video' },
  ]);

  it('hiện nút media khi đang chọn model Qwen', () => {
    expect(isSameFamilyAsMedia('qwen3.8-max', picked)).toBe(true);
    expect(isSameFamilyAsMedia('qwen3.7-max', picked)).toBe(true);
    expect(isSameFamilyAsMedia('qwen3.5-plus', picked)).toBe(true);
  });

  it('ẩn nút media với model hãng khác', () => {
    expect(isSameFamilyAsMedia('gpt-5.6-sol', picked)).toBe(false);
    expect(isSameFamilyAsMedia('claude-opus-5', picked)).toBe(false);
    expect(isSameFamilyAsMedia('', picked)).toBe(false);
  });

  it('model media đang chọn cũng được hiện nút', () => {
    expect(isSameFamilyAsMedia('qwen-video', picked)).toBe(true);
    expect(isSameFamilyAsMedia('flux-pro', picked)).toBe(true);
  });
});
