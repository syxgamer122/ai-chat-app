'use client';

/**
 * Micro-transitions pack cho Vyen — port từ Amicro registry (MIT,
 * github.com/Subhan-code/Amicro--Micro-transitions-).
 *
 * PHIÊN BẢN KHÔNG framer: thư viện motion đó nặng ~100KB gz chỉ để chạy vài
 * animation vòng lặp đơn giản, và nó nằm trong chunk khởi động. Toàn bộ hiệu
 * ứng chuyển sang CSS animation thuần (keyframes `fx-*` trong
 * tailwind.config.ts) — tham số duration/ease/delay copy nguyên từ bản
 * framer cũ để HÀNH VI hiển thị không đổi.
 *
 * Quy tắc bắt buộc khi dùng:
 * - CHỈ gắn effect ở trạng thái ĐANG CHỜ (mic nghe, thinking, tool chip) —
 *   không bao giờ gắn animation loop vào bubble tĩnh (message re-render mỗi
 *   token khi stream, animation loop sẽ nhân chi phí render).
 * - Mọi effect tự tắt qua useFxEnabled(): settings.perf.animations (máy yếu)
 *   + prefers-reduced-motion của OS. Khi tắt → render fallback tĩnh.
 *  globals.css còn một lớp phòng thủ: media query prefers-reduced-motion và
 *   html[data-animations='off'] ép mọi animation-duration về 0.01ms.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/lib/store';

/**
 * Thay useReducedMotion của framer: cùng ngữ nghĩa (true khi OS bật
 * giảm chuyển động, cập nhật theo change event) nhưng chỉ là 1 matchMedia —
 * không kéo thư viện animation vào bundle.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/** Bật/tắt toàn bộ micro-transitions: flag máy yếu + OS reduced-motion. */
export function useFxEnabled(): boolean {
  const animations = useAppStore((s) => s.settings.perf.animations);
  const reduced = usePrefersReducedMotion();
  return animations && !reduced;
}

/* ------------------------------------------------------------------ */
/* SiriWave — 5 thanh nhún khi mic đang nghe                           */
/* ------------------------------------------------------------------ */

export function SiriWave({ active = true }: { active?: boolean }) {
  const fx = useFxEnabled();
  return (
    <div className="flex h-6 items-center space-x-1" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) =>
        fx && active ? (
          <span
            key={i}
            className="w-1 animate-fx-bar-bounce rounded-full bg-brand"
            style={{ animationDelay: `${i * 0.12}s` }}
          />
        ) : (
          // Fallback tĩnh 6px, transition-[height] giữ độ mượt 0.2s như bản framer.
          <span key={i} className="h-1.5 w-1 rounded-full bg-brand transition-[height] duration-200" />
        ),
      )}
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
      <span className="w-1/3 animate-fx-sweep absolute inset-y-0 bg-gradient-to-r from-transparent via-white/15 to-transparent dark:via-white/10" />
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
      {[0, 1, 2].map((i) =>
        fx ? (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-fx-dot-bounce rounded-full bg-brand/80"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ) : (
          <span key={i} className="h-1.5 w-1.5 rounded-full bg-brand/80 opacity-60 transition-opacity duration-200" />
        ),
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* MorphIcon — crossfade 2 icon trên cùng nút (Send↔Stop, Mic↔Stop)    */
/* ------------------------------------------------------------------ */

export function MorphIcon({ active, children, inactive }: { active: boolean; children: React.ReactNode; inactive: React.ReactNode }) {
  const fx = useFxEnabled();
  if (!fx) return <>{active ? children : inactive}</>;
  // Crossfade bằng transition CSS: 0.18s ease-out như bản framer, đổi cả
  // opacity + scale + rotate theo cùng easing.
  const base = 'absolute inset-0 flex items-center justify-center transition-[opacity,transform] duration-[180ms] ease-out';
  return (
    <span className="relative flex h-full w-full items-center justify-center" aria-hidden="true">
      <span className={`${base} ${active ? 'scale-100 rotate-0 opacity-100' : 'scale-[0.6] rotate-[-30deg] opacity-0'}`}>
        {children}
      </span>
      <span className={`${base} ${active ? 'scale-[0.6] rotate-[30deg] opacity-0' : 'scale-100 rotate-0 opacity-100'}`}>
        {inactive}
      </span>
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
