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

function collectToolEvents(annotations: Array<Record<string, unknown>> | undefined): ToolEvent[] {
  if (!annotations?.length) return [];
  const order: string[] = [];
  const byId = new Map<string, ToolEvent>();
  for (const ann of annotations) {
    const tool = ann?.tool as Record<string, unknown> | undefined;
    if (!tool || typeof tool !== 'object') continue;
    const id = String(tool.id ?? '');
    const key = id || `${String(tool.name)}:${order.length}`;
    let ev = byId.get(key);
    if (!ev || (!id && ev.name !== String(tool.name))) {
      ev = { id: key, name: '', done: false, args: '', summary: '' };
      byId.set(key, ev);
      order.push(key);
    }
    ev.name = String(tool.name ?? ev.name ?? '');
    if (tool.phase === 'start') {
      ev.args = typeof tool.args === 'string' ? tool.args : '';
      ev.done = false;
    } else if (tool.phase === 'done') {
      ev.summary = typeof tool.summary === 'string' ? tool.summary : '';
      ev.done = true;
    }
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
}: {
  annotations?: Array<Record<string, unknown>>;
}) {
  const events = collectToolEvents(annotations);
  if (events.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-1" role="list" aria-label="Các công cụ AI đã dùng">
      {events.map((ev) => {
        const meta = LABELS[ev.name] ?? { label: ev.name, Icon: Wrench };
        const { Icon } = meta;
        const detail = ev.done ? ev.summary : ev.args;
        return (
          <div
            key={ev.id}
            role="listitem"
            title={detail || undefined}
            className="flex max-w-full items-center gap-1.5 rounded-lg border border-zinc-200/70 bg-surface-muted px-2 py-1 text-[11px] text-zinc-600"
          >
            <Icon size={12} className="flex-shrink-0 text-brand" aria-hidden />
            <span className="flex-shrink-0 font-medium text-zinc-700">{meta.label}</span>
            {ev.args && !ev.done && (
              <span className="min-w-0 truncate text-zinc-500">{ev.args}</span>
            )}
            {ev.done && (
              <>
                {ev.summary && <span className="min-w-0 truncate">{ev.summary}</span>}
                <Check size={12} className="ml-auto flex-shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              </>
            )}
            {!ev.done && (
              <Loader2 size={11} className="ml-auto flex-shrink-0 animate-spin text-zinc-400" aria-hidden />
            )}
          </div>
        );
      })}
    </div>
  );
});
