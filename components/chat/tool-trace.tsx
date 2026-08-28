'use client';

import { memo } from 'react';
import {
  ArrowLeftRight,
  Brain,
  Check,
  Cloud,
  FileText,
  Loader2,
  Search,
  Wrench,
} from 'lucide-react';
import { ShimmerLine } from '@/components/effects';

/**
 * Tool trace — timeline các lần model gọi công cụ trong bubble assistant.
 *
 * Dữ liệu đến từ message.annotations (route ghi {tool:{id,name,phase,args|
 * summary}} cho từng tool-call/tool-result) nên vừa stream được theo thời
 * gian thực vừa persist vào DB — mở lại hội thoại cũ vẫn thấy đầy đủ.
 * Kết quả tool KHÔNG đưa nguyên văn vào đây: chỉ tóm tắt một dòng để không
 * phình payload annotation.
 */

interface ToolEvent {
  id: string;
  name: string;
  /** true = đã có kết quả; false = đang chạy. */
  done: boolean;
  args: string;
  summary: string;
}

interface ToolInvocationLike {
  toolCallId?: string;
  state?: string;
  result?: unknown;
}

function collectToolEvents(
  annotations: Array<Record<string, unknown>> | undefined,
  toolInvocations: ToolInvocationLike[] | undefined,
): ToolEvent[] {
  if (!annotations?.length && !toolInvocations?.length) return [];
  const order: string[] = [];
  const byId = new Map<string, ToolEvent>();
  const push = (key: string) => {
    if (!byId.has(key)) {
      byId.set(key, { id: key, name: '', done: false, args: '', summary: '' });
      order.push(key);
    }
    return byId.get(key)!;
  };

  for (const ann of annotations ?? []) {
    const tool = ann?.tool as Record<string, unknown> | undefined;
    if (!tool || typeof tool !== 'object') continue;
    const id = String(tool.id ?? '');
    const key = id || `${String(tool.name)}:${order.length}`;
    const ev = push(key);
    ev.name = String(tool.name ?? ev.name ?? '');
    if (tool.phase === 'start') {
      ev.args = typeof tool.args === 'string' ? tool.args : '';
      ev.done = false;
    } else if (tool.phase === 'done') {
      ev.summary = typeof tool.summary === 'string' ? tool.summary : '';
      ev.done = true;
    }
  }

  /* fs_* tools kết quả đến từ CLIENT (onToolCall) — route không bao giờ ghi
     annotation 'done' cho chúng. Trạng thái thật nằm trong message
     .toolInvocations mà AI SDK populates từ part 'tool_call' forwarded. */
  for (const inv of toolInvocations ?? []) {
    if (!inv?.toolCallId) continue;
    const ev = push(String(inv.toolCallId));
    if (inv.state === 'result') ev.done = true;
  }

  return order.map((k) => byId.get(k)!).filter((ev) => ev.name);
}

const LABELS: Record<string, { label: string; Icon: typeof Search }> = {
  web_search: { label: 'Tìm web', Icon: Search },
  web_fetch: { label: 'Đọc trang', Icon: FileText },
  weather: { label: 'Thời tiết', Icon: Cloud },
  exchange_rates: { label: 'Tỷ giá', Icon: ArrowLeftRight },
  memory_search: { label: 'Tra ghi nhớ', Icon: Brain },
};

export const ToolTrace = memo(function ToolTrace({
  annotations,
  toolInvocations,
}: {
  annotations?: Array<Record<string, unknown>>;
  toolInvocations?: ToolInvocationLike[];
}) {
  const events = collectToolEvents(annotations, toolInvocations);
  if (events.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap gap-1.5" role="list" aria-label="Các công cụ AI đã dùng">
      {events.map((ev) => {
        const meta = LABELS[ev.name] ?? { label: ev.name, Icon: Wrench };
        const { Icon } = meta;
        const detail = ev.done ? ev.summary : ev.args;
        return (
          <div
            key={ev.id}
            role="listitem"
            title={detail || undefined}
            className={`relative flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] transition-all ${
              ev.done
                ? 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400'
                : 'border-brand/20 bg-brand/[0.04] text-zinc-700 aurora-shimmer dark:border-aurora-from/20 dark:bg-aurora-from/[0.06] dark:text-zinc-300'
            }`}
          >
            <Icon size={12} className={`flex-shrink-0 ${ev.done ? 'text-zinc-400' : 'text-brand dark:text-aurora-from'}`} aria-hidden />
            <span className="font-medium">{meta.label}</span>
            {ev.done && <Check size={11} className="flex-shrink-0 text-emerald-500 dark:text-aurora-from" aria-hidden />}
            {!ev.done && <Loader2 size={11} className="flex-shrink-0 animate-spin text-zinc-400 dark:text-aurora-via" aria-hidden />}
          </div>
        );
      })}
    </div>
  );
});
