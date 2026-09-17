import { describe, expect, it } from 'vitest';
import { detectMediaKind } from '@/lib/media-models';

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
