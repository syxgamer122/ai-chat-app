/**
 * Logic điều hướng menu mức suy luận (ThinkingSlider).
 *
 * Repo chạy vitest ở environment 'node' (không jsdom/happy-dom, không
 * @testing-library) nên phần keyboard wiring (Escape, focus) không test render
 * được; bước mũi tên và việc chọn item nhận focus lúc mở menu được tách thành
 * hàm thuần (`stepLevelCursor`, `resolveOpenFocusIndex`) để test tại đây.
 */
import { describe, expect, it } from 'vitest';
import { resolveOpenFocusIndex, stepLevelCursor } from '@/components/thinking-slider';

const ALL = [true, true, true, true];

describe('stepLevelCursor', () => {
  it('đi tới 1 mức theo hướng dương', () => {
    expect(stepLevelCursor(0, 1, ALL)).toBe(1);
    expect(stepLevelCursor(2, 1, ALL)).toBe(3);
  });

  it('đi lùi 1 mức theo hướng âm', () => {
    expect(stepLevelCursor(3, -1, ALL)).toBe(2);
    expect(stepLevelCursor(1, -1, ALL)).toBe(0);
  });

  it('quay vòng ở cả hai đầu', () => {
    expect(stepLevelCursor(3, 1, ALL)).toBe(0);
    expect(stepLevelCursor(0, -1, ALL)).toBe(3);
  });

  it('bỏ qua mức bị model khóa khi đi tới', () => {
    // medium(1) bị khóa: từ low phải nhảy thẳng sang high.
    expect(stepLevelCursor(0, 1, [true, false, true, true])).toBe(2);
  });

  it('bỏ qua mức bị model khóa khi đi lùi', () => {
    // max(3) và medium(1) bị khóa: từ high lùi phải vòng về low.
    expect(stepLevelCursor(2, -1, [true, false, true, false])).toBe(0);
  });

  it('bỏ qua cụm mức khóa liền kề', () => {
    expect(stepLevelCursor(0, 1, [true, false, false, true])).toBe(3);
    expect(stepLevelCursor(3, -1, [true, false, false, true])).toBe(0);
  });

  it('trả về vị trí cũ khi mọi mức đều khóa', () => {
    expect(stepLevelCursor(2, 1, [false, false, false, false])).toBe(2);
    expect(stepLevelCursor(1, -1, [false, false, false, false])).toBe(1);
  });

  it('trả về vị trí cũ với danh sách rỗng', () => {
    expect(stepLevelCursor(0, 1, [])).toBe(0);
    expect(stepLevelCursor(0, -1, [])).toBe(0);
  });
});

describe('resolveOpenFocusIndex', () => {
  it('focus đúng mức đang chọn khi mức đó mở', () => {
    expect(resolveOpenFocusIndex(0, ALL)).toBe(0);
    expect(resolveOpenFocusIndex(2, ALL)).toBe(2);
    expect(resolveOpenFocusIndex(3, ALL)).toBe(3);
  });

  it('mức đang chọn bị khóa thì lấy mức mở gần nhất', () => {
    // high(2) bị khóa: max(3) gần hơn low(0).
    expect(resolveOpenFocusIndex(2, [true, false, false, true])).toBe(3);
    // max(3) bị khóa: high(2) là mức mở gần nhất.
    expect(resolveOpenFocusIndex(3, [true, true, true, false])).toBe(2);
  });

  it('hòa khoảng cách thì mức thấp hơn thắng', () => {
    // medium(1) bị khóa: low(0) và high(2) cách đều, giữ mức đứng trước.
    expect(resolveOpenFocusIndex(1, [true, false, true, true])).toBe(0);
  });

  it('không tìm thấy mức đang chọn (-1) thì focus mức mở đầu tiên', () => {
    expect(resolveOpenFocusIndex(-1, ALL)).toBe(0);
    expect(resolveOpenFocusIndex(-1, [false, true, true, false])).toBe(1);
  });

  it('trả -1 khi mọi mức đều khóa hoặc danh sách rỗng', () => {
    expect(resolveOpenFocusIndex(2, [false, false, false, false])).toBe(-1);
    expect(resolveOpenFocusIndex(0, [])).toBe(-1);
  });
});
