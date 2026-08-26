'use client';

/**
 * Micro-transitions pack cho KODA — port từ Amicro registry (MIT,
 * github.com/Subhan-code/Amicro--Micro-transitions-), framer-motion.
 *
 * Quy tắc bắt buộc khi dùng:
 * - CHỈ gắn effect ở trạng thái ĐANG CHỜ (mic nghe, thinking, tool chip) —
 *   không bao giờ gắn animation loop vào bubble tĩnh (message re-render mỗi
 *   token khi stream, animation loop sẽ nhân chi phí render).
 * - Mọi effect tự tắt qua useFxEnabled(): settings.perf.animations (máy yếu)
 *   + prefers-reduced-motion của OS. Khi tắt → render fallback tĩnh.
 */

import { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useAppStore } from '@/lib/store';

/** Bật/tắt toàn bộ micro-transitions: flag máy yếu + OS reduced-motion. */
export function useFxEnabled(): boolean {
  const animations = useAppStore((s) => s.settings.perf.animations);
  const reduced = useReducedMotion();
  return animations && !reduced;
}

/* ------------------------------------------------------------------ */
/* SiriWave — 5 thanh nhún khi mic đang nghe                           */
/* ------------------------------------------------------------------ */

export function SiriWave({ active = true }: { active?: boolean }) {
  const fx = useFxEnabled();
  return (
    <div className="flex h-6 items-center space-x-1" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <motion.span
          key={i}
          className="w-1 rounded-full bg-brand"
          animate={fx && active ? { height: [4, 22, 4] } : { height: 6 }}
          transition={
            fx && active
              ? { duration: 1.1, repeat: Infinity, delay: i * 0.12, ease: 'easeInOut' }
              : { duration: 0.2 }
          }
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TextShimmer — vệt sáng quét qua chữ đang chờ                        */
/* ------------------------------------------------------------------ */

export function TextShimmer({ text, className = '' }: { text: string; className?: string }) {
  const fx = useFxEnabled();
  if (!fx) return <span className={className}>{text}</span>;
  return <span className={`fx-shimmer-text ${className}`}>{text}</span>;
}

/* ------------------------------------------------------------------ */
/* ShimmerLine — vệt sáng quét qua chip đang chạy                      */
/* ------------------------------------------------------------------ */

export function ShimmerLine() {
  const fx = useFxEnabled();
  if (!fx) return null;
  return (
    <span aria-hidden="true" className="absolute inset-0 overflow-hidden rounded-[inherit]">
      <motion.span
        className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/15 to-transparent dark:via-white/10"
        animate={{ x: ['-120%', '360%'] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', repeatDelay: 0.4 }}
      />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* TypingIndicator — 3 dot nảy sóng (dùng cho thinking)                */
/* ------------------------------------------------------------------ */

export function TypingIndicator() {
  const fx = useFxEnabled();
  return (
    <span aria-hidden="true" className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-brand/80"
          animate={fx ? { y: [0, -5, 0], opacity: [0.4, 1, 0.4] } : { opacity: 0.6 }}
          transition={
            fx
              ? { duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }
              : { duration: 0.2 }
          }
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* MorphIcon — crossfade 2 icon trên cùng nút (Send↔Stop, Mic↔Stop)    */
/* ------------------------------------------------------------------ */

export function MorphIcon({ active, children, inactive }: { active: boolean; children: React.ReactNode; inactive: React.ReactNode }) {
  const fx = useFxEnabled();
  if (!fx) return <>{active ? children : inactive}</>;
  return (
    <span className="relative flex h-full w-full items-center justify-center" aria-hidden="true">
      <motion.span
        className="absolute inset-0 flex items-center justify-center"
        animate={{ opacity: active ? 1 : 0, scale: active ? 1 : 0.6, rotate: active ? 0 : -30 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        {children}
      </motion.span>
      <motion.span
        className="absolute inset-0 flex items-center justify-center"
        animate={{ opacity: active ? 0 : 1, scale: active ? 0.6 : 1, rotate: active ? 30 : 0 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        {inactive}
      </motion.span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Haptics — rung nhẹ mobile (navigator.vibrate), no-op nơi không hỗ trợ */
/* ------------------------------------------------------------------ */

export type HapticsKind = 'light' | 'medium' | 'success';

export function useHaptics() {
  const animations = useAppStore((s) => s.settings.perf.animations);
  return useMemo(
    () => ({
      trigger(kind: HapticsKind = 'light') {
        if (!animations) return false;
        if (typeof window === 'undefined' || !navigator.vibrate) return false;
        try {
          const ms = kind === 'light' ? 10 : kind === 'medium' ? 25 : kind === 'success' ? [10, 40, 15] : 15;
          return navigator.vibrate(ms);
        } catch {
          return false;
        }
      },
    }),
    [animations],
  );
}

/** Hook đồng hồ giây đã chờ — tách để ThinkingIndicator dùng lại. */
export function useElapsedSeconds(resetKey?: string): number {
  const [elapsedSec, setElapsedSec] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    setElapsedSec(0);
    const timer = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [resetKey]);
  return elapsedSec;
}
