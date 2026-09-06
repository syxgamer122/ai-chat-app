/**
 * RED TEAM — các hàm thuần của ThinkingMenu (components/thinking-menu.tsx).
 *
 * Mặt nạ enabled toàn false, index ngoài phạm vi, mảng rỗng, metadata
 * metadata lệch thứ tự, requested trùng effective. Chuẩn phòng thủ: xác định,
 * không throw, focus index luôn hợp lệ (-1 khi không còn gì mở), copy tiếng
 * Việt đúng ngữ cảnh mandatory/toggle-only.
 */
import { describe, expect, it } from 'vitest';
import {
  menuSubtitle,
  resolveOpenFocusIndex,
  snappedTitle,
  stepLevelCursor,
  supportedLevelsText,
} from '@/components/thinking-menu';

describe('RED TEAM stepLevelCursor — mặt nạ tất cả false / ngoài phạm vi', () => {
  it('mọi mức khóa: trả đúng vị trí cũ với mọi from và hai hướng', () => {
    const mask = [false, false, false, false];
    for (const from of [0, 1, 2, 3]) {
      expect(stepLevelCursor(from, 1, mask)).toBe(from);
      expect(stepLevelCursor(from, -1, mask)).toBe(from);
    }
  });

  it('mảng rỗng với from bất kỳ (kể cả ngoài phạm vi): trả nguyên from', () => {
    expect(stepLevelCursor(0, 1, [])).toBe(0);
    expect(stepLevelCursor(-1, 1, [])).toBe(-1);
    expect(stepLevelCursor(99, -1, [])).toBe(99);
  });

  it('from ngoài phạm vi với mặt nạ có mức mở: vòng về trong phạm vi', () => {
    expect(stepLevelCursor(99, 1, [false, true])).toBe(1);
    // (-7+1+2)%2 = -0: về index 0 (dùng làm chỉ số mảng thì -0 là '0').
    const wrapped = stepLevelCursor(-7, 1, [true, false]);
    expect(wrapped === 0).toBe(true);
    expect(wrapped >= 0).toBe(true);
  });

  it('một mức mở duy nhất: hai hướng đều dừng ở mức đó', () => {
    const mask = [false, false, true, false];
    expect(stepLevelCursor(0, 1, mask)).toBe(2);
    expect(stepLevelCursor(2, 1, mask)).toBe(2);
    expect(stepLevelCursor(2, -1, mask)).toBe(2);
    expect(stepLevelCursor(3, -1, mask)).toBe(2);
  });
});

describe('RED TEAM resolveOpenFocusIndex — đầu vào bất thường', () => {
  it('mảng rỗng trả -1, kể cả activeIndex = -1', () => {
    expect(resolveOpenFocusIndex(-1, [])).toBe(-1);
    expect(resolveOpenFocusIndex(0, [])).toBe(-1);
  });

  it('activeIndex = -1 với đủ mức mở: focus mức đầu (0)', () => {
    expect(resolveOpenFocusIndex(-1, [true, true, true, true])).toBe(0);
  });

  it('activeIndex ngoài phạm vi: mức mở gần nhất theo khoảng cách tuyệt đối', () => {
    expect(resolveOpenFocusIndex(9, [true, false, true, true])).toBe(3);
    expect(resolveOpenFocusIndex(-5, [true, false, true, true])).toBe(0);
  });

  it('mọi mức khóa: trả -1 (caller phải bỏ focus, không focus mù)', () => {
    expect(resolveOpenFocusIndex(2, [false, false, false, false])).toBe(-1);
  });
});

describe('RED TEAM menuSubtitle — metadata null / rỗng / lệch thứ tự', () => {
  it('null + mandatory: mô tả chung kèm ghi chú luôn suy luận', () => {
    expect(menuSubtitle(null, true)).toBe(
      'Điều khiển độ sâu phân tích của AI · Model này luôn suy luận',
    );
  });

  it('undefined + không mandatory: mô tả chung thuần', () => {
    expect(menuSubtitle(undefined, false)).toBe('Điều khiển độ sâu phân tích của AI');
  });

  it('mảng rỗng (toggle-only): gateway tự dịch', () => {
    expect(menuSubtitle([], false)).toBe('Gateway tự dịch mức thành bật/tắt');
    expect(menuSubtitle([], true)).toBe('Gateway tự dịch mức thành bật/tắt · Model này luôn suy luận');
  });

  it("['max','low'] + mandatory: liệt kê theo thang low→max bất kể thứ tự nhập", () => {
    expect(menuSubtitle(['max', 'low'], true)).toBe(
      'Model hỗ trợ: Thấp, Tối đa · Model này luôn suy luận',
    );
  });
});

describe('RED TEAM supportedLevelsText — thứ tự bất kể đầu vào', () => {
  it("['max','low'] sắp về 'Thấp, Tối đa'", () => {
    expect(supportedLevelsText(['max', 'low'])).toBe('Thấp, Tối đa');
  });

  it('đảo đủ 4 mức: vẫn in theo thang low→max', () => {
    expect(supportedLevelsText(['max', 'high', 'medium', 'low'])).toBe(
      'Thấp, Trung bình, Cao, Tối đa',
    );
  });

  it('mảng rỗng trả chuỗi rỗng (không "Model hỗ trợ: ")', () => {
    expect(supportedLevelsText([])).toBe('');
  });
});

describe('RED TEAM snappedTitle — requested trùng effective', () => {
  it("snappedTitle('max','max') không throw, nhắc cả hai mức", () => {
    const title = snappedTitle('max', 'max');
    expect(title).toContain('Mức suy luận');
    expect(title).toContain('Tối đa');
    expect(title).toContain('đang gửi Tối đa');
  });

  it('cặp thường: requested low, effective high', () => {
    expect(snappedTitle('low', 'high')).toBe(
      'Mức suy luận: Cao (Model không hỗ trợ Thấp, đang gửi Cao)',
    );
  });
});
