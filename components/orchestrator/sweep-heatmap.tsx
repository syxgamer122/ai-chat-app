'use client';

/**
 * Heatmap 2 trục — port `series.vbt.heatmap(x_level, y_level)` của vectorbt.
 *
 * Ở vectorbt đây là plotly figure tương tác (slider cho level thứ ba). Bản port
 * giữ lại phần CÓ GIÁ TRỊ NHẤT — **nhìn 2 trục cùng lúc để thấy vùng nào của
 * không gian tham số đang tốt** — và bỏ phần nặng (plotly ~3MB, widget Jupyter).
 *
 * Kết quả: ~90 dòng CSS grid, không dependency, không bundle thêm.
 */

import { Fragment } from 'react';
import type { Heatmap } from '@/lib/orchestrator/metrics';

function cellStyle(value: number | null): React.CSSProperties {
  if (value === null) return { background: 'rgb(var(--zinc-200) / 0.45)' };
  const alpha = 0.1 + 0.8 * Math.max(0, Math.min(1, value));
  return {
    background: `rgb(var(--brand) / ${alpha.toFixed(3)})`,
    color: value > 0.55 ? '#fff' : undefined,
  };
}

export function SweepHeatmap({ heatmap }: { heatmap: Heatmap }) {
  const { xAxis, yAxis, xLevels, yLevels, values, counts } = heatmap;

  return (
    <div className="inline-block max-w-full align-top">
      <div
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: `max-content repeat(${Math.max(1, xLevels.length)}, minmax(64px, 1fr))` }}
      >
        {/* Góc: nhãn trục Y nằm ngang phía trên cột nhãn */}
        <div className="self-end pb-1 pr-1 text-right text-[10px] font-medium text-zinc-500">
          {yAxis} ↓ / {xAxis} →
        </div>
        {xLevels.map((level) => (
          <div
            key={`x-${level}`}
            title={level}
            className="truncate px-1 pb-1 text-center text-[11px] font-medium text-zinc-700"
          >
            {level}
          </div>
        ))}

        {yLevels.map((y, yi) => (
          <Fragment key={`y-${y}`}>
            <div title={y} className="truncate pr-1 text-right text-[11px] font-medium text-zinc-700">
              {y}
            </div>
            {xLevels.map((x, xi) => {
              const value = values[yi]?.[xi] ?? null;
              const count = counts[yi]?.[xi] ?? 0;
              return (
                <div
                  key={`c-${y}-${x}`}
                  title={`${yAxis} = ${y} · ${xAxis} = ${x}\nĐiểm: ${value === null ? 'chưa có' : value.toFixed(3)}${count ? ` (${count} mẫu)` : ''}`}
                  style={cellStyle(value)}
                  className="flex h-9 items-center justify-center rounded text-[11px] font-semibold tabular-nums text-zinc-800"
                >
                  {value === null ? '—' : value.toFixed(2)}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/**
 * Thanh điểm theo từng mức của một trục — phần `groupby(level).mean()` của
 * vectorbt. Trả lời câu hỏi mà heatmap không trả lời được khi chỉ có 1 trục:
 * "mức nào của trục này đang kéo điểm lên?".
 */
export function AxisBars({
  axis,
  groups,
}: {
  axis: string;
  groups: Array<{ level: string; mean: number; count: number; okCount: number }>;
}) {
  const max = groups.reduce((m, g) => Math.max(m, g.mean), 0) || 1;

  return (
    <div className="min-w-0">
      <div className="mb-1 truncate text-[11px] font-medium text-zinc-500">{axis}</div>
      <div className="space-y-1">
        {groups.map((g) => (
          <div key={g.level} className="flex items-center gap-2">
            <div className="w-28 flex-shrink-0 truncate text-[11px] text-zinc-700" title={g.level}>
              {g.level}
            </div>
            <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded bg-zinc-200/70">
              <div
                className="h-full rounded"
                style={{ width: `${Math.max(2, (g.mean / max) * 100).toFixed(1)}%`, background: 'rgb(var(--brand))' }}
              />
            </div>
            <div className="w-24 flex-shrink-0 text-right text-[10px] tabular-nums text-zinc-500">
              {g.mean.toFixed(2)} · {g.okCount}/{g.count}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
