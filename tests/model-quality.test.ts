import { beforeEach, describe, expect, it } from 'vitest';
import {
  getModelQualityScore,
  NEUTRAL,
  recordModelOutcome,
  reorderModelsByQuality,
  resetModelQuality,
} from '@/lib/model-quality';

const BASE = 'https://gw.example.com/v1';

describe('model quality EWMA', () => {
  beforeEach(() => resetModelQuality());

  it('chưa quan sát → điểm trung tính (không ghi map)', () => {
    expect(getModelQualityScore(BASE, 'gpt-x')).toBe(NEUTRAL);
  });

  it('EWMA kéo điểm về phía kết quả gần nhất', () => {
    recordModelOutcome(BASE, 'm', true);
    expect(getModelQualityScore(BASE, 'm')).toBeCloseTo(0.5 + 0.2 * 0.5); // 0.6
    for (let i = 0; i < 20; i++) recordModelOutcome(BASE, 'm', false);
    // Sau chuỗi fail dài, điểm phải tụt sâu dưới trung tính.
    expect(getModelQualityScore(BASE, 'm')).toBeLessThan(0.1);
  });

  it('trạng thái MỚI thắng trạng thái cũ (đặc tính EWMA)', () => {
    for (let i = 0; i < 10; i++) recordModelOutcome(BASE, 'm', false);
    for (let i = 0; i < 10; i++) recordModelOutcome(BASE, 'm', true);
    expect(getModelQualityScore(BASE, 'm')).toBeGreaterThan(NEUTRAL);
  });

  describe('reorderModelsByQuality — soft preference có dead-zone', () => {
    const chain = ['primary', 'secondary', 'tertiary'];

    it('chưa có dữ liệu → giữ nguyên thứ tự khai báo', () => {
      expect(reorderModelsByQuality(BASE, chain)).toEqual(chain);
    });

    it('chênh lệch trong dead-zone → KHÔNG đổi thứ tự', () => {
      recordModelOutcome(BASE, 'secondary', true); // secondary ≈ 0.6
      // primary vẫn 0.5 — chênh 0.1 < 0.15: không nhảy.
      expect(reorderModelsByQuality(BASE, chain)).toEqual(chain);
    });

    it('model phụ TIN CẬY RÕ RỆT hơn mới được lên trước', () => {
      for (let i = 0; i < 8; i++) recordModelOutcome(BASE, 'secondary', true); // ≈ 0.83+
      expect(reorderModelsByQuality(BASE, chain)[0]).toBe('secondary');
      // primary tụt xuống nhưng vẫn đứng trước tertiary (ngang điểm → ổn định).
      expect(reorderModelsByQuality(BASE, chain)).toEqual(['secondary', 'primary', 'tertiary']);
    });

    it('model chính khỏe lại lấy lại chỗ', () => {
      for (let i = 0; i < 8; i++) recordModelOutcome(BASE, 'secondary', true);
      for (let i = 0; i < 15; i++) recordModelOutcome(BASE, 'primary', true);
      expect(reorderModelsByQuality(BASE, chain)[0]).toBe('primary');
    });

    it('tách bạch theo gateway', () => {
      for (let i = 0; i < 10; i++) recordModelOutcome(BASE, 'x', true);
      expect(reorderModelsByQuality('https://other.example.com', ['x', 'y'])).toEqual(['x', 'y']);
    });

    it('dải theo mốc neo nhất quán — model dải tốt luôn trước dải kém ở MỌI hoán vị đầu vào', () => {
      // Chuỗi điểm m-high ≈ 0.68, m-mid ≈ 0.48, m-low = 0.5 (NEUTRAL):
      // anchor 0.68 → m-high dải 0; m-mid & m-low (chênh 0.2/0.18) dải 1.
      // Comparator theo từng cặp không bắc cầu (0.48≈0.5≈0.68 từng cặp trong
      // một số ngưỡng) có thể cho dải "lộn" theo thứ tự đầu vào; dải neo thì không.
      for (let i = 0; i < 2; i++) recordModelOutcome(BASE, 'm-high', true);
      recordModelOutcome(BASE, 'm-mid', true);
      recordModelOutcome(BASE, 'm-mid', false);

      const perms = [
        ['m-low', 'm-mid', 'm-high'],
        ['m-high', 'm-mid', 'm-low'],
        ['m-mid', 'm-high', 'm-low'],
        ['m-mid', 'm-low', 'm-high'],
      ];
      for (const perm of perms) {
        const out = reorderModelsByQuality(BASE, perm);
        // m-high (dải 0) phải đứng trước cả m-mid lẫn m-low (dải 1).
        expect(out.indexOf('m-high')).toBeLessThan(out.indexOf('m-mid'));
        expect(out.indexOf('m-high')).toBeLessThan(out.indexOf('m-low'));
      }
    });

    it('trong cùng dải giữ NGUYÊN thứ tự khai báo (stable)', () => {
      // Cả ba chưa quan sát → cùng điểm NEUTRAL → cùng dải 0 → thứ tự gốc.
      const many = ['zeta', 'alpha', 'middle', 'beta'];
      expect(reorderModelsByQuality(BASE, many)).toEqual(many);
    });
  });
});
