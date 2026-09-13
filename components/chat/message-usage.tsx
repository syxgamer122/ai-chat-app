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
      {stats.routingRole && (
        <span
          className={`mr-1 ${
            stats.routingRole === 'worker' ? 'text-[#9fa4ab]' : 'text-[#6a9fcc]'
          }`}
          title={
            stats.routingRole === 'planner'
              ? 'Lượt chạy bằng planner model (lệnh /plan)'
              : stats.routingRole === 'lead'
                ? 'Model mạnh (lead) — lập kế hoạch hoặc fallback sau thất bại'
                : 'Model rẻ (worker) — pha thực thi'
          }
        >
          {stats.routingRole}
        </span>
      )}
      {text}
    </p>
  );
}
