'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Throttle một giá trị đang thay đổi liên tục (leading + trailing edge).
 *
 * @param value  giá trị nguồn (nội dung stream)
 * @param delay  khoảng gom nhóm, ms
 * @param active chỉ throttle khi true. Khi false -> trả về value gốc ngay lập tức.
 */
export function useThrottledValue<T>(value: T, delay = 150, active = true): T {
  const [throttled, setThrottled] = useState<T>(value);
  const lastRun = useRef<number>(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clear = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };

    // Stream kết thúc -> hủy timer treo, đồng bộ ngay giá trị cuối.
    if (!active) {
      clear();
      setThrottled(value);
      return;
    }

    const elapsed = Date.now() - lastRun.current;

    // Leading edge: đủ thời gian thì render luôn cho cảm giác phản hồi tức thì.
    if (elapsed >= delay) {
      lastRun.current = Date.now();
      setThrottled(value);
      return clear;
    }

    // Trailing edge: hẹn giờ cho phần còn lại của cửa sổ throttle.
    timer.current = setTimeout(() => {
      lastRun.current = Date.now();
      timer.current = null;
      setThrottled(value);
    }, delay - elapsed);

    return clear;
  }, [value, delay, active]);

  // Chốt an toàn kép: khi không throttle, luôn đọc thẳng từ nguồn.
  return active ? throttled : value;
}
