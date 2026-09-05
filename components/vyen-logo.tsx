/*
 * Logo Vyen — nguồn duy nhất cho dấu hiệu thương hiệu Vyen.
 */
import React, { useId } from 'react';

interface VyenMarkProps {
  size?: number;
  className?: string;
}

/** Dấu hiệu thương hiệu Vyen (chữ V — hai nét hội tụ, hai node ở đỉnh). */
export function VyenMark({ size = 16, className }: VyenMarkProps) {
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

// Alias for backwards compatibility across existing components
export const PiMark = VyenMark;

interface VyenLogoProps {
  /** `sm` cho sidebar, `lg` cho empty state. */
  size?: 'sm' | 'lg';
  /** Hiển thị chữ "Vyen" bên cạnh (sm) hoặc bên dưới (lg). */
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
          ? 'relative flex h-16 w-16 items-center justify-center rounded-none bg-[#161d27] border border-[#495059]'
          : 'relative flex h-7 w-7 items-center justify-center rounded-none bg-[#161d27] border border-[#495059]'
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
        <div className="mt-4 flex items-center gap-2">
          <span className="font-pixel text-[32px] font-bold tracking-[0.05em] text-[#ebe7e4] [image-rendering:pixelated]">Vyen</span>
          <span className="rounded-none border border-[#495059] bg-[#1a2330] px-1.5 py-0.5 font-pixel text-[11px] uppercase tracking-[0.08em] text-[#6a9fcc]">
            agent
          </span>
        </div>
        <div className="mt-1 font-pixel text-[11px] uppercase tracking-[0.08em] text-[#9fa4ab]">
          AI Innovations
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2.5 ${className ?? ''}`}>
      {tile}
      <div className="leading-tight">
        <div className="flex items-center gap-1.5">
          <span className="font-pixel text-[16px] font-bold tracking-[0.05em] text-[#ebe7e4] [image-rendering:pixelated]">Vyen</span>
          <span className="rounded-none border border-[#495059] bg-[#1a2330] px-1 py-0.5 font-pixel text-[9px] uppercase tracking-[0.08em] text-[#6a9fcc]">
            v0.1
          </span>
        </div>
        <div className="font-pixel text-[9.5px] uppercase tracking-[0.08em] text-[#9fa4ab]">
          AI Innovations
        </div>
      </div>
    </div>
  );
}

export const PiLogo = VyenLogo;
