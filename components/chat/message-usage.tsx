'use client';

import { extractMessageUsage, formatMessageUsage } from '@/lib/message-usage';

/**
 * Dòng mờ dưới câu trả lời assistant: ↑token ↓token · thời lượng · chi phí
 * (chỉ khi là số thật). Ẩn hoàn toàn khi message không có usage annotation.
 */
export function MessageUsage({ annotations }: { annotations?: unknown }) {
  const stats = extractMessageUsage(annotations);
  if (!stats) return null;
  const text = formatMessageUsage(stats);
  if (!text) return null;
  return (
    <p
      className="mt-1 font-mono text-[10px] tabular-nums text-[#9fa4ab]"
      title={
        stats.estimated
          ? 'Gateway không báo usage: token ước lượng từ độ dài trả lời'
          : 'Token thật do gateway báo'
      }
    >
      {text}
    </p>
  );
}
