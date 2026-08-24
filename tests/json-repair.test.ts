import { describe, expect, it } from 'vitest';
import { repairJson, parseLooseJson } from '@/lib/json-repair';

describe('repairJson — sửa JSON hỏng nhẹ từ gateway free', () => {
  it('JSON sạch đi qua nguyên văn', () => {
    const raw = '{"type":"image","url":"https://x/a.png"}';
    expect(repairJson(raw)).toBe(raw);
  });

  it('escape control character nằm trần trong string (newline, tab)', () => {
    // Runtime: dấu newline/tab THẬT nằm giữa chuỗi JSON — JSON.parse ném lỗi.
    const raw = '{"text":"dòng 1\ndòng 2\ttab"}';
    expect(() => JSON.parse(raw)).toThrow();
    expect(repairJson(raw)).toBe('{"text":"dòng 1\\ndòng 2\\ttab"}');
    expect(JSON.parse(repairJson(raw))).toEqual({ text: 'dòng 1\ndòng 2\ttab' });
  });

  it('nhân đôi backslash đứng trước ký tự không phải escape hợp lệ', () => {
    // Chọn chữ cái KHÔNG trùng escape hợp lệ (tránh b/f/n/r/t/u"/\) để cả
    // hai backslash đều bị coi là hỏng và được nhân đôi.
    const raw = '{"path":"C:\\abc\\def"}';
    expect(() => JSON.parse(raw)).toThrow();
    expect(JSON.parse(repairJson(raw))).toEqual({ path: 'C:\\abc\\def' });
  });

  it('backslash đứng CUỐI input (không có ký tự kế) được nhân đôi', () => {
    // Input kết thúc bằng 1 backslash trần (dòng SSE bị cắt giữa string).
    // Thuật toán chỉ nhân đôi escape — không tái tạo dấu quote bị mất, nên
    // assert trực tiếp đầu ra thay vì parse lại.
    const raw = '{"a":"x\\';
    expect(repairJson(raw)).toBe('{"a":"x\\\\');
  });

  it('không đụng escape hợp lệ và \\uXXXX', () => {
    const raw = '{"a":"x\\n\\u0041\\\\y"}';
    expect(repairJson(raw)).toBe(raw);
  });
});

describe('parseLooseJson — parse lỏng cho dòng SSE', () => {
  it('dòng sạch: parse thường, trả object', () => {
    expect(parseLooseJson('{"type":"video","url":"https://x/v.mp4"}')).toEqual({
      type: 'video',
      url: 'https://x/v.mp4',
    });
  });

  it('dòng hỏng nhẹ: sửa xong parse được — không mất event media', () => {
    // Status text chứa newline trần — JSON.parse thuần ném lỗi.
    const raw = '{"type":"status","text":"đang render\n50%"}';
    expect(parseLooseJson(raw)).toEqual({ type: 'status', text: 'đang render\n50%' });
  });

  it('rác thật sự -> null để caller giữ hành vi drop', () => {
    expect(parseLooseJson('[DONE]')).toBeNull();
    expect(parseLooseJson('<html>error</html>')).toBeNull();
    expect(parseLooseJson('')).toBeNull();
  });

  it('mảng và primitive hợp lệ vẫn parse đúng', () => {
    expect(parseLooseJson('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseLooseJson('"chữ"')).toBe('chữ');
  });
});
