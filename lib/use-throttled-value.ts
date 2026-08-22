'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Throttle giá trị render (leading + trailing). Dùng cho content stream:
 * UI cập nhật tối đa 1 lần / interval, luôn có flush cuối.
 */
export function useThrottledValue<T>(value: T, intervalMs = 100): T {
  const [throttled, setThrottled] = useState(value);
  const lastEmitRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const latestRef = useRef(value);

  latestRef.current = value;

  useEffect(() => {
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
  }, [value, intervalMs]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return throttled;
}

/** Persister ghi Dexie: throttle >= 250ms, CHỈ field content, flush cuối bắt buộc. */
export function createThrottledPersister(
  write: (content: string) => Promise<unknown>,
  intervalMs = 250,
) {
  let pending: string | null = null;
  let lastWrite = 0;
  let timer: number | null = null;
  let closed = false;

  const doWrite = async () => {
    if (pending === null) return;
    const payload = pending;
    pending = null;
    lastWrite = Date.now();
    try {
      await write(payload);
    } catch (err) {
      console.error('[persister] write failed', err);
    }
  };

  return {
    push(content: string) {
      if (closed) return;
      pending = content;
      const elapsed = Date.now() - lastWrite;
      if (elapsed >= intervalMs) {
        void doWrite();
      } else if (timer === null) {
        timer = window.setTimeout(() => {
          timer = null;
          void doWrite();
        }, intervalMs - elapsed);
      }
    },
    async flush(finalContent?: string) {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (finalContent !== undefined) pending = finalContent;
      await doWrite();
    },
    close() {
      closed = true;
      if (timer !== null) window.clearTimeout(timer);
    },
  };
}