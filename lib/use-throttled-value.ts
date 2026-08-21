'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Throttle giá trị stream (leading + trailing edge), luôn flush giá trị cuối.
 * Khác bản cũ: timer chỉ tạo MỘT lần cho mỗi cửa sổ và đọc `latest.current`,
 * nên không bao giờ render giá trị cũ và không tạo/hủy timer theo từng token.
 */
export function useThrottledValue<T>(value: T, delay = 150, active = true): T {
  const [throttled, setThrottled] = useState<T>(value);
  const latest = useRef(value);
  const lastRun = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  latest.current = value;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    // Stream kết thúc -> flush ngay, reset cửa sổ cho lần stream sau.
    if (!active) {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      lastRun.current = 0;
      setThrottled(value);
      return;
    }

    // Đã có hẹn giờ -> để nó tự đọc latest.current, không churn timer.
    if (timer.current) return;

    const elapsed = Date.now() - lastRun.current;
    if (elapsed >= delay) {
      lastRun.current = Date.now();
      setThrottled(value);
      return;
    }

    timer.current = setTimeout(() => {
      timer.current = null;
      lastRun.current = Date.now();
      if (mounted.current) setThrottled(latest.current);
    }, delay - elapsed);
  }, [value, delay, active]);

  return active ? throttled : value;
}
