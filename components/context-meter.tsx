'use client';

import { memo } from 'react';

/**
 * Context meter — thanh mảnh hiển thị ngữ cảnh đã dùng / trần của model
 * đang chọn (resolveContextWindow: metadata provider → config built-in → 32k).
 *
 * Mục đích UX: người dùng hiểu vì sao hội thoại dài bị nén tự động và thấy
 * trước khi chạm ngưỡng. Vàng khi vào vùng chuẩn-bị-nén (≥75%), đỏ khi sát
 * trần (≥90%).
 */

function fmt(k: number): string {
  if (k >= 1_000_000) return `${(k / 1_000_000).toFixed(k % 1_000_000 === 0 ? 0 : 1)}M`;
  if (k >= 1000) return `${Math.round(k / 1000)}k`;
  return String(k);
}

export const ContextMeter = memo(function ContextMeter({
  used,
  max,
}: {
  used: number;
  max: number;
}) {
  const safeMax = Math.max(1, max);
  const ratio = Math.min(1, Math.max(0, used / safeMax));
  const percent = Math.round(ratio * 100);
  const tone =
    ratio >= 0.9 ? 'bg-red-500' : ratio >= 0.75 ? 'bg-amber-500' : 'bg-brand';
  const textTone =
    ratio >= 0.9
      ? 'text-red-600 dark:text-red-400'
      : ratio >= 0.75
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-zinc-500';

  return (
    <div
      className="mx-auto w-full max-w-thread px-4"
      title={`Ngữ cảnh: ${fmt(used)} / ${fmt(safeMax)} token (${percent}%)`}
    >
      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
          <div
            role="progressbar"
            aria-label="Mức sử dụng ngữ cảnh"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className={`h-full rounded-full transition-all duration-300 ${tone}`}
            style={{ width: `${Math.max(ratio > 0 ? 2 : 0, ratio * 100)}%` }}
          />
        </div>
        <span className={`flex-shrink-0 text-[10px] tabular-nums ${textTone}`}>
          {fmt(used)} / {fmt(safeMax)}
        </span>
      </div>
    </div>
  );
});
