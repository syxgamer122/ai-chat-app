'use client';

import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BarChart3 } from 'lucide-react';
import { db } from '@/lib/db';
import { aggregateUsage, extractUsage, formatTokens, formatUsd } from '@/lib/usage-stats';

const RANGES = [
  { label: '7 ngày', days: 7 },
  { label: '30 ngày', days: 30 },
  { label: 'Tất cả', days: 0 },
] as const;

/** Thống kê token sử dụng theo model/ngày — dữ liệu từ usage annotations. */
export function UsageStats() {
  const [days, setDays] = useState<number>(30);

  const messages = useLiveQuery(
    () => db.messages.where('role').equals('assistant').toArray(),
    [],
    [],
  );

  const summary = useMemo(
    () => aggregateUsage((messages ?? []).map(extractUsage).filter((r): r is NonNullable<typeof r> => r !== null), days),
    [messages, days],
  );

  const totalAll = summary.promptTokens + summary.completionTokens;
  const maxDay = Math.max(1, ...summary.byDay.map((d) => d.promptTokens + d.completionTokens));
  const totalBarMax = Math.max(1, ...summary.byModel.map((m) => m.promptTokens + m.completionTokens));

  return (
    <div className="space-y-3 font-mono">
      {/* Bộ lọc thời gian */}
      <div className="flex items-center justify-between gap-2">
        <div role="group" aria-label="Khoảng thời gian" className="flex gap-1 border border-border-hairline bg-surface-raised p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              aria-pressed={days === r.days}
              onClick={() => setDays(r.days)}
              className={`rounded-none px-2.5 py-1 text-[11px] font-medium transition ${
                days === r.days
                  ? 'bg-[#6a9fcc] text-[#0d1116] font-semibold'
                  : 'text-text-muted hover:text-text-primary hover:bg-panel-bg'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-text-muted">{formatTokens(summary.messages)} tin nhắn</span>
      </div>

      {totalAll === 0 ? (
        <div className="flex flex-col items-center gap-2 border border-dashed border-border-hairline bg-surface-raised py-6 text-center">
          <BarChart3 size={20} aria-hidden="true" className="text-text-muted" />
          <p className="px-3 text-xs text-text-muted">
            Chưa có dữ liệu — thống kê được ghi tự động từ các tin nhắn mới
            (tính từ khi cập nhật tính năng này).
          </p>
        </div>
      ) : (
        <>
          {/* Tổng quan */}
          <div className={`grid gap-2 ${summary.costUsd !== null ? 'grid-cols-4' : 'grid-cols-3'}`}>
            <div className="border border-border-hairline bg-surface-raised p-2.5">
              <div className="text-[11px] uppercase tracking-wide text-text-muted">Token vào</div>
              <div className="text-sm font-semibold text-text-primary">{formatTokens(summary.promptTokens)}</div>
            </div>
            <div className="border border-border-hairline bg-surface-raised p-2.5">
              <div className="text-[11px] uppercase tracking-wide text-text-muted">Token ra</div>
              <div className="text-sm font-semibold text-text-primary">{formatTokens(summary.completionTokens)}</div>
            </div>
            <div className="border border-border-hairline bg-surface-raised p-2.5">
              <div className="text-[11px] uppercase tracking-wide text-text-muted">Tổng cộng</div>
              <div className="text-sm font-semibold text-accent-steel">{formatTokens(totalAll)}</div>
            </div>
            {summary.costUsd !== null && (
              <div
                title="Ước lượng theo bảng giá công khai — gateway riêng của bạn có thể khác"
                className="border border-border-hairline bg-surface-raised p-2.5"
              >
                <div className="text-[11px] uppercase tracking-wide text-text-muted">Chi phí ước tính</div>
                <div className="text-sm font-semibold text-accent-steel">{formatUsd(summary.costUsd)}</div>
              </div>
            )}
          </div>

          {/* Theo ngày — cột xếp chồng vào/ra */}
          {summary.byDay.length > 1 && (
            <div className="border border-border-hairline bg-surface-raised p-3">
              <div className="mb-2 text-[11px] font-medium text-text-primary">Theo ngày</div>
              <div className="flex h-20 items-end gap-1">
                {summary.byDay.map((d) => {
                  const t = d.promptTokens + d.completionTokens;
                  const h = Math.max(3, Math.round((t / maxDay) * 100));
                  const inPct = t > 0 ? (d.promptTokens / t) * 100 : 0;
                  return (
                    <div
                      key={d.day}
                      title={`${d.day}: ${formatTokens(d.promptTokens)} vào / ${formatTokens(d.completionTokens)} ra`}
                      className="flex h-full min-w-0 flex-1 flex-col justify-end"
                    >
                      <div className="flex w-full flex-col overflow-hidden" style={{ height: `${h}%` }}>
                        <div className="w-full bg-[#4b607c]" style={{ height: `${100 - inPct}%` }} />
                        <div className="w-full bg-[#6a9fcc]" style={{ height: `${inPct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-text-muted">
                <span>{summary.byDay[0]?.day}</span>
                <span>{summary.byDay[summary.byDay.length - 1]?.day}</span>
              </div>
            </div>
          )}

          {/* Theo model */}
          <div className="space-y-1.5 border border-border-hairline bg-surface-raised p-3">
            <div className="mb-1 text-[11px] font-medium text-text-primary">Theo model</div>
            {summary.byModel.map((m) => {
              const t = m.promptTokens + m.completionTokens;
              return (
                <div key={m.model} className="space-y-0.5">
                  <div className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="min-w-0 truncate font-mono text-text-primary">{m.model}</span>
                    <span className="flex-shrink-0 text-text-muted">
                      {formatTokens(t)} · {m.messages} tin
                      {m.costUsd !== null && (
                        <span className="ml-1 font-medium text-accent-steel">· {formatUsd(m.costUsd)}</span>
                      )}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden bg-panel-bg">
                    <div
                      className="h-full bg-[#6a9fcc]"
                      style={{ width: `${Math.max(2, (t / totalBarMax) * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
