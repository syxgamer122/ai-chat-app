'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Throttle giá trị stream (leading + trailing edge), luôn flush giá trị cuối.
 * Đảm bảo cập nhật chính xác ngay lập tức khi delay hoặc active thay đổi.
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
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
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

    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    const elapsed = Date.now() - lastRun.current;
    if (elapsed >= delay) {
      lastRun.current = Date.now();
      setThrottled(value);
      return;
    }

    timer.current = setTimeout(() => {
      timer.current = null;
      lastRun.current = Date.now();
      if (mounted.current) {
        setThrottled(latest.current);
      }
    }, Math.max(0, delay - elapsed));

    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [value, delay, active]);

  return active ? throttled : value;
}
