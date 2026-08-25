import { describe, expect, it } from 'vitest';
import {
  shouldCompressFile,
  targetDimensions,
  COMPRESS_THRESHOLD_BYTES,
} from '@/lib/image-compress';

describe('shouldCompressFile', () => {
  it('ảnh lớn hơn ngưỡng → nén', () => {
    expect(shouldCompressFile(COMPRESS_THRESHOLD_BYTES + 1, 'image/jpeg')).toBe(true);
    expect(shouldCompressFile(5 * 1024 * 1024, 'image/png')).toBe(true);
  });

  it('ảnh nhỏ hoặc file phi-ảnh → bỏ qua', () => {
    expect(shouldCompressFile(100, 'image/jpeg')).toBe(false);
    expect(shouldCompressFile(COMPRESS_THRESHOLD_BYTES, 'image/jpeg')).toBe(false); // đúng ngưỡng chưa vượt
    expect(shouldCompressFile(10 * 1024 * 1024, 'application/pdf')).toBe(false);
    expect(shouldCompressFile(10 * 1024 * 1024, 'text/plain')).toBe(false);
  });

  it('GIF không nén — canvas sẽ mất animation', () => {
    expect(shouldCompressFile(10 * 1024 * 1024, 'image/gif')).toBe(false);
  });
});

describe('targetDimensions', () => {
  it('đã vừa khung → null (không resize)', () => {
    expect(targetDimensions(1920, 1080)).toBeNull();
    expect(targetDimensions(2048, 2048)).toBeNull();
    expect(targetDimensions(100, 50)).toBeNull();
  });

  it('ảnh ngang dọc đều thu về cạnh dài ≤ max, giữ tỷ lệ', () => {
    const landscape = targetDimensions(4000, 3000)!;
    expect(landscape.width).toBe(2048);
    expect(Math.round((landscape.height / landscape.width) * 100)).toBe(
      Math.round((3000 / 4000) * 100),
    );

    const portrait = targetDimensions(3024, 4032)!;
    expect(portrait.height).toBe(2048);

    const square = targetDimensions(6000, 6000)!;
    expect(square.width).toBe(2048);
    expect(square.height).toBe(2048);
  });

  it('input rác trả null thay vì NaN', () => {
    expect(targetDimensions(0, 0)).toBeNull();
    expect(targetDimensions(-5, 100)).toBeNull();
    expect(targetDimensions(Number.NaN, 100)).toBeNull();
  });
});
