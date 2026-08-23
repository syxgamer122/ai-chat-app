'use client';

import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BarChart3 } from 'lucide-react';
import { db } from '@/lib/db';
import { aggregateUsage, extractUsage, formatTokens } from '@/lib/usage-stats';

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
    <div className="space-y-3">
      {/* Bộ lọc thời gian */}
      <div className="flex items-center justify-between gap-2">
        <div role="group" aria-label="Khoảng thời gian" className="flex gap-1 rounded-lg bg-zinc-100 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              aria-pressed={days === r.days}
              onClick={() => setDays(r.days)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                days === r.days
                  ? 'bg-surface-raised text-brand shadow-sm'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-zinc-600">{formatTokens(summary.messages)} tin nhắn</span>
      </div>

      {totalAll === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 py-6 text-center">
          <BarChart3 size={20} aria-hidden="true" className="text-zinc-500" />
          <p className="px-3 text-xs text-zinc-600">
            Chưa có dữ liệu — thống kê được ghi tự động từ các tin nhắn mới
            (tính từ khi cập nhật tính năng này).
          </p>
        </div>
      ) : (
        <>
          {/* Tổng quan */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl border border-zinc-200 bg-surface-raised p-2.5">
              <div className="text-[11px] uppercase tracking-wide text-zinc-600">Token vào</div>
              <div className="text-sm font-semibold text-zinc-900">{formatTokens(summary.promptTokens)}</div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-surface-raised p-2.5">
              <div className="text-[11px] uppercase tracking-wide text-zinc-600">Token ra</div>
              <div className="text-sm font-semibold text-zinc-900">{formatTokens(summary.completionTokens)}</div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-surface-raised p-2.5">
              <div className="text-[11px] uppercase tracking-wide text-zinc-600">Tổng cộng</div>
              <div className="text-sm font-semibold text-brand">{formatTokens(totalAll)}</div>
            </div>
          </div>

          {/* Theo ngày — cột xếp chồng vào/ra */}
          {summary.byDay.length > 1 && (
            <div className="rounded-xl border border-zinc-200 bg-surface-raised p-3">
              <div className="mb-2 text-[11px] font-medium text-zinc-700">Theo ngày</div>
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
                      <div className="flex w-full flex-col overflow-hidden rounded-[3px]" style={{ height: `${h}%` }}>
                        <div className="w-full bg-brand-accent/70" style={{ height: `${100 - inPct}%` }} />
                        <div className="w-full bg-brand" style={{ height: `${inPct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
                <span>{summary.byDay[0]?.day}</span>
                <span>{summary.byDay[summary.byDay.length - 1]?.day}</span>
              </div>
            </div>
          )}

          {/* Theo model */}
          <div className="space-y-1.5 rounded-xl border border-zinc-200 bg-surface-raised p-3">
            <div className="mb-1 text-[11px] font-medium text-zinc-700">Theo model</div>
            {summary.byModel.map((m) => {
              const t = m.promptTokens + m.completionTokens;
              return (
                <div key={m.model} className="space-y-0.5">
                  <div className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="min-w-0 truncate font-mono text-zinc-800">{m.model}</span>
                    <span className="flex-shrink-0 text-zinc-600">
                      {formatTokens(t)} · {m.messages} tin
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-brand to-brand-accent"
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
