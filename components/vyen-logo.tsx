/*
 * Logo Vyen — nguồn duy nhất cho dấu hiệu thương hiệu.
 * Trước đây SVG này bị inline lặp ở sidebar, empty state và settings với 3 id
 * gradient khác nhau; gom về một chỗ để đổi nhận diện chỉ cần sửa 1 file.
 */
import React, { useId } from 'react';

interface VyenMarkProps {
  size?: number;
  className?: string;
}

/** Chỉ riêng dấu hiệu (chữ V — hai nét hội tụ, hai node ở đỉnh) — không có chữ. */
export function VyenMark({ size = 16, className }: VyenMarkProps) {
  // useId: mỗi instance một gradient id riêng, tránh trùng khi render nhiều lần.
  const gradientId = `vyen-mark-${useId()}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id={gradientId} x1="8" y1="7" x2="24" y2="25" gradientUnits="userSpaceOnUse">
          <stop stopColor="rgb(var(--brand))" />
          <stop offset="1" stopColor="rgb(var(--brand-accent))" />
        </linearGradient>
      </defs>
      <path d="M10 7.5L16 24.5" stroke={`url(#${gradientId})`} strokeWidth="3.2" strokeLinecap="round" />
      <path d="M22 7.5L16 24.5" stroke={`url(#${gradientId})`} strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="10" cy="7.5" r="2.4" fill="rgb(var(--brand))" />
      <circle cx="22" cy="7.5" r="2.4" fill="rgb(var(--brand-accent))" />
    </svg>
  );
}

interface VyenLogoProps {
  /** `sm` cho sidebar, `lg` cho empty state. */
  size?: 'sm' | 'lg';
  /** Hiển thị chữ "Vyen / AI Innovations" bên cạnh (sm) hoặc bên dưới (lg). */
  withWordmark?: boolean;
  className?: string;
}

/** Dấu hiệu + wordmark, dùng ở sidebar và trạng thái rỗng. */
export function VyenLogo({ size = 'sm', withWordmark = true, className }: VyenLogoProps) {
  const isLarge = size === 'lg';

  const tile = (
    <div
      className={
        isLarge
          ? 'flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-raised shadow-brand-lg ring-1 ring-zinc-900/5'
          : 'flex h-7 w-7 items-center justify-center rounded-lg bg-surface-muted ring-1 ring-zinc-900/5'
      }
    >
      <VyenMark size={isLarge ? 34 : 16} />
    </div>
  );

  if (!withWordmark) return <div className={className}>{tile}</div>;

  if (isLarge) {
    return (
      <div className={`flex flex-col items-center ${className ?? ''}`}>
        {tile}
        <div className="mt-5 text-[15px] font-extrabold tracking-tight text-zinc-800">Vyen</div>
        <div className="text-[10px] font-medium uppercase tracking-[0.28em] text-zinc-500">
          AI Innovations
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2.5 ${className ?? ''}`}>
      {tile}
      <div className="leading-tight">
        <div className="text-[14px] font-extrabold tracking-tight text-zinc-800">Vyen</div>
        <div className="text-[10px] font-medium uppercase tracking-[0.24em] text-zinc-500">
          AI Innovations
        </div>
      </div>
    </div>
  );
}
