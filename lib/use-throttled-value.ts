'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Throttle giá trị render (leading + trailing). Dùng cho content stream:
 * UI cập nhật tối đa 1 lần / interval, luôn có flush cuối.
 * Khi `enabled = false` (vd: message đã hoàn tất) — truyền thẳng, không throttle.
 */
export function useThrottledValue<T>(value: T, intervalMs = 100, enabled = true): T {
  const [throttled, setThrottled] = useState(value);
  const lastEmitRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const latestRef = useRef(value);

  latestRef.current = value;

  useEffect(() => {
    if (!enabled) {
      setThrottled(value);
      return;
    }

    const now = Date.now();
    const elapsed = now - lastEmitRef.current;

    if (elapsed >= intervalMs) {
      lastEmitRef.current = now;
      setThrottled(value);
      return;
    }
    if (timerRef.current !== null) return;

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      lastEmitRef.current = Date.now();
      setThrottled(latestRef.current);
    }, intervalMs - elapsed);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, intervalMs, enabled]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return enabled ? throttled : value;
}
