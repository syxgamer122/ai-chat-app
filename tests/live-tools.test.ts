import { describe, expect, it } from 'vitest';
import {
  detectLiveIntent,
  describeWeatherCode,
  parseRates,
  formatRatesBlock,
} from '@/lib/live-tools';

describe('detectLiveIntent', () => {
  it('nhận câu hỏi thời tiết kèm địa điểm', () => {
    const intent = detectLiveIntent('Thời tiết Hà Nội hôm nay thế nào?');
    expect(intent.weather).toBe(true);
    // "Hà Nội" đứng TRƯỚC từ khóa nên regex "ở X" không bắt — vẫn là weather
    expect(intent.rates).toBe(false);
  });

  it('trích địa điểm sau giới từ ở/tại', () => {
    expect(detectLiveIntent('ở Đà Lạt có mưa không').weatherLocation).toBe('Đà Lạt');
    expect(detectLiveIntent('thời tiết tại Tokyo ngày mai').weatherLocation).toBe('Tokyo');
    expect(detectLiveIntent('nhiệt độ ở Sài Gòn bây giờ').weatherLocation).toBe('Sài Gòn');
  });

  it('thời tiết không nhắc nơi → location null (dùng mặc định)', () => {
    const intent = detectLiveIntent('mai có mưa không?');
    expect(intent.weather).toBe(true);
    expect(intent.weatherLocation).toBeNull();
  });

  it('nhận ý định tỷ giá, kể cả lẫn trong câu dài', () => {
    expect(detectLiveIntent('tỷ giá USD hôm nay').rates).toBe(true);
    expect(detectLiveIntent('cho tôi giá EUR với').rates).toBe(true);
    expect(detectLiveIntent('1 đô đổi được bao nhiêu tiền').rates).toBe(false); // không khớp từ khóa
  });

  it('câu thường không dính intent nào', () => {
    const intent = detectLiveIntent('Viết giúp mình đoạn code Python đọc file');
    expect(intent.weather).toBe(false);
    expect(intent.rates).toBe(false);
  });
});

describe('describeWeatherCode', () => {
  it('map WMO code sang tiếng Việt', () => {
    expect(describeWeatherCode(0)).toBe('trời quang');
    expect(describeWeatherCode(61)).toBe('mưa nhẹ');
    expect(describeWeatherCode(95)).toBe('dông');
    expect(describeWeatherCode(1234)).toBe('không xác định');
  });
});

describe('parseRates + formatRatesBlock', () => {
  const sample = {
    time_last_update_utc: 'Fri, 21 Aug 2026 00:00:00 +0000',
    rates: { VND: 26500.5, EUR: 0.85, JPY: 145.2, XYZ: 1 },
  };

  it('parse giữ đồng trong danh sách theo dõi, bỏ lạ/không hợp lệ', () => {
    const r = parseRates(sample);
    expect(r.usdRates.VND).toBeCloseTo(26500.5);
    expect(r.usdRates.EUR).toBeCloseTo(0.85);
    expect((r.usdRates as Record<string, number | undefined>).XYZ).toBeUndefined();    expect(parseRates(null).usdRates.VND as unknown).toBeUndefined();
    expect(parseRates({ rates: 'x' }).updatedAt).toBeNull();
  });

  it('format khối có tỷ giá VND + quy đổi ngược từ EUR', () => {
    const block = formatRatesBlock(parseRates(sample));
    expect(block).toContain('[TỶ GIÁ HÔM NAY');
    // Node ICU có thể dùng dấu chấm/phẩy/ngăn cách khác nhau — so bằng regex
    expect(block!.match(/1 USD ≈ 26[\d.,\u00a0\u202f\s]*VNĐ/)).toBeTruthy();
    expect(block!.match(/1 EUR \(Euro\) ≈ [\d.,\u00a0\u202f\s]+ VNĐ/)).toBeTruthy();
  });

  it('không có VND → null (không dựng khối rỗng)', () => {
    expect(formatRatesBlock(parseRates({ rates: { EUR: 1 } }))).toBeNull();
  });
});
