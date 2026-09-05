'use client';

import { memo } from 'react';

/**
 * Context meter — hairline 2px + text mono "12.3k / 200k" hiển thị ngữ cảnh
 * đã dùng / trần của model đang chọn (resolveContextWindow: metadata provider
 * → config built-in → 32k).
 *
 * Mục đích UX: người dùng hiểu vì sao hội thoại dài bị nén tự động và thấy
 * trước khi chạm ngưỡng. Màu chỉ đổi khi thật sự có chuyện: vàng khi vào vùng
 * chuẩn-bị-nén (≥75%), đỏ khi sát trần (≥90%); dưới ngưỡng đó là neutral.
 */

/** Format token theo kiểu đọc nhanh: 999 → "999", 12345 → "12.3k", 2M. */
export function fmt(k: number): string {
  if (k >= 1_000_000) return `${(k / 1_000_000).toFixed(k % 1_000_000 === 0 ? 0 : 1)}M`;
  if (k >= 1000) {
    const v = k / 1000;
    // Một chữ số thập phân (12.3k), bỏ ".0" cho số chẵn
    const s = v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '');
    return `${s}k`;
  }
  return String(k);
}

export type ContextMeterTone = 'ok' | 'warning' | 'error';

/** Toàn bộ số học của meter, tách ra để test thuần (không cần DOM). */
export function computeMeter(used: number, max: number): {
  /** Tỉ lệ gốc, KHÔNG clamp: used > max vẫn thấy "vượt trần" (105%). */
  ratio: number;
  /** Tỉ lệ clamp 0..1 cho độ rộng thanh, để không tràn layout. */
  fillRatio: number;
  /** Percent làm tròn từ tỉ lệ gốc (dùng cho title/aria). */
  percent: number;
  tone: ContextMeterTone;
  safeMax: number;
} {
  const safeMax = Math.max(1, max);
  const ratio = Math.max(0, used / safeMax);
  const fillRatio = Math.min(1, ratio);
  return {
    ratio,
    fillRatio,
    percent: Math.round(ratio * 100),
    tone: ratio >= 0.9 ? 'error' : ratio >= 0.75 ? 'warning' : 'ok',
    safeMax,
  };
}

export const ContextMeter = memo(function ContextMeter({
  used,
  max,
}: {
  used: number;
  max: number;
}) {
  const { fillRatio, percent, tone, safeMax } = computeMeter(used, max);

  // Chỉ tô màu khi gần đầy (token DESIGN.md): #e8993a warning, #e8704f error
  const barTone =
    tone === 'error' ? 'bg-[#e8704f]' : tone === 'warning' ? 'bg-[#e8993a]' : 'bg-[#4b607c]';
  const textTone =
    tone === 'error' ? 'text-[#e8704f]' : tone === 'warning' ? 'text-[#e8993a]' : 'text-[#9fa4ab]';

  return (
    <div
      className="mx-auto w-full max-w-thread px-4 font-mono"
      title={`Ngữ cảnh: ${fmt(used)} / ${fmt(safeMax)} token (${percent}%)`}
    >
      <div
        role="progressbar"
        aria-label="Mức sử dụng ngữ cảnh"
        aria-valuenow={Math.min(100, percent)}
        aria-valuetext={`${fmt(used)} / ${fmt(safeMax)} token (${percent}%)`}
        aria-valuemin={0}
        aria-valuemax={100}
        className="flex items-center gap-2"
      >
        <div className="h-0.5 flex-1 bg-[#1c2128]">
          <div
            className={`h-full ${barTone}`}
            style={{ width: `${Math.round(fillRatio * 100)}%` }}
          />
        </div>
        <span className={`flex-shrink-0 text-[10px] tabular-nums ${textTone}`}>
          {fmt(used)} / {fmt(safeMax)}
        </span>
      </div>
    </div>
  );
});
