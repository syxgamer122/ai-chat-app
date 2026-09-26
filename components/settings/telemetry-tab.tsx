/**
 * TelemetryTab — Tab Đo đạc & Quan sát Phân tán (OpenTelemetry Tracing) trong Cài đặt.
 *
 * Hiển thị biểu đồ Waterfall trực quan độ trễ từng Agent Turn, LLM Stream, Tool execution
 * và Audit commit từ bộ nhớ đệm xoay vòng (Ring Buffer 500 Spans) của globalTracer.
 */

'use client';

import { useState, useEffect, useMemo } from 'react';
import { Activity, Clock, CheckCircle2, AlertTriangle, Trash2, RefreshCw } from 'lucide-react';
import { globalTracer, type TelemetrySpan } from '@/core/telemetry/tracer';

export function TelemetryTab() {
  const [spans, setSpans] = useState<TelemetrySpan[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);

  const refreshSpans = () => {
    const recent = globalTracer.getRecentSpans(100);
    setSpans(recent);
    if (!selectedTraceId && recent.length > 0) {
      setSelectedTraceId(recent[0].traceId);
    }
  };

  useEffect(() => {
    refreshSpans();
    const timer = setInterval(refreshSpans, 2000);
    return () => clearInterval(timer);
  }, []);

  // Gom nhóm các spans theo traceId
  const traces = useMemo(() => {
    const map = new Map<string, { traceId: string; rootSpan: TelemetrySpan; count: number; totalDurationMs: number }>();
    for (const span of spans) {
      const existing = map.get(span.traceId);
      if (!existing) {
        map.set(span.traceId, {
          traceId: span.traceId,
          rootSpan: span,
          count: 1,
          totalDurationMs: span.durationMs || 0,
        });
      } else {
        existing.count++;
        existing.totalDurationMs = Math.max(existing.totalDurationMs, (span.endTime || span.startTime) - existing.rootSpan.startTime);
      }
    }
    return Array.from(map.values());
  }, [spans]);

  const activeTraceSpans = useMemo(() => {
    if (!selectedTraceId) return [];
    return globalTracer.getTraceWaterfall(selectedTraceId);
  }, [selectedTraceId, spans]);

  const traceStartTime = activeTraceSpans[0]?.startTime || 0;
  const traceTotalDuration = useMemo(() => {
    if (activeTraceSpans.length === 0) return 1;
    const maxEnd = Math.max(...activeTraceSpans.map((s) => s.endTime || s.startTime + (s.durationMs || 0)));
    return Math.max(1, maxEnd - traceStartTime);
  }, [activeTraceSpans, traceStartTime]);

  const selectedSpan = useMemo(() => {
    return activeTraceSpans.find((s) => s.id === selectedSpanId) || activeTraceSpans[0];
  }, [activeTraceSpans, selectedSpanId]);

  const handleClear = () => {
    globalTracer.clear();
    setSpans([]);
    setSelectedTraceId(null);
    setSelectedSpanId(null);
  };

  return (
    <div className="space-y-5 text-xs font-mono">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-hairline/60 pb-3">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-accent-steel" />
          <span className="font-semibold text-text-primary text-sm">OpenTelemetry Waterfall</span>
          <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-muted">
            {spans.length} / 500 spans
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refreshSpans}
            className="flex items-center gap-1 rounded border border-border-hairline px-2 py-1 text-text-muted hover:bg-surface-raised hover:text-text-primary"
            title="Làm mới"
          >
            <RefreshCw size={12} />
            <span>Làm mới</span>
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="flex items-center gap-1 rounded border border-border-hairline px-2 py-1 text-red-400 hover:bg-red-950/20"
            title="Xóa bộ đệm telemetry"
          >
            <Trash2 size={12} />
            <span>Xóa cache</span>
          </button>
        </div>
      </div>

      {traces.length === 0 ? (
        <div className="rounded border border-dashed border-border-hairline/80 p-8 text-center text-text-muted">
          <Activity size={24} className="mx-auto mb-2 opacity-40 text-accent-steel" />
          <p>Chưa có dữ liệu đo đạc.</p>
          <p className="mt-1 text-[11px] opacity-75">
            Khi bạn trò chuyện và AI thực thi các công cụ (fs_*, shell_run, mcp),
            tiến trình sẽ xuất hiện dưới dạng biểu đồ Waterfall tại đây.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Trace Selector Pills */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {traces.map((t) => (
              <button
                key={t.traceId}
                type="button"
                onClick={() => {
                  setSelectedTraceId(t.traceId);
                  setSelectedSpanId(null);
                }}
                className={`flex-shrink-0 rounded border px-2 py-1 text-left text-[11px] transition-colors ${
                  selectedTraceId === t.traceId
                    ? 'border-accent-steel bg-accent-steel/10 text-text-primary font-medium'
                    : 'border-border-hairline bg-surface-raised/40 text-text-muted hover:text-text-primary'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate max-w-[120px]">{t.rootSpan.name}</span>
                  <span className="text-[10px] opacity-60">{t.totalDurationMs}ms</span>
                </div>
              </button>
            ))}
          </div>

          {/* Waterfall Chart */}
          <div className="rounded border border-border-hairline bg-surface-raised/30 p-3 space-y-2">
            <div className="flex justify-between text-[10px] text-text-muted border-b border-border-hairline/40 pb-1">
              <span>0ms</span>
              <span>Timeline: {traceTotalDuration}ms</span>
            </div>

            <div className="space-y-1.5 pt-1">
              {activeTraceSpans.map((span) => {
                const offsetMs = Math.max(0, span.startTime - traceStartTime);
                const leftPercent = Math.min(100, (offsetMs / traceTotalDuration) * 100);
                const widthPercent = Math.max(2, Math.min(100 - leftPercent, ((span.durationMs || 1) / traceTotalDuration) * 100));
                const isSelected = selectedSpan?.id === span.id;

                let barColor = 'bg-accent-steel/80';
                if (span.name.startsWith('tool:')) barColor = 'bg-emerald-500/80';
                else if (span.name.startsWith('approval:')) barColor = 'bg-amber-500/80';
                if (span.status === 'error') barColor = 'bg-red-500/80';

                return (
                  <div
                    key={span.id}
                    onClick={() => setSelectedSpanId(span.id)}
                    className={`cursor-pointer rounded px-2 py-1 transition-colors ${
                      isSelected ? 'bg-panel-bg border border-accent-steel/50' : 'hover:bg-surface-raised/60'
                    }`}
                  >
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <div className="flex items-center gap-1.5">
                        {span.status === 'ok' ? (
                          <CheckCircle2 size={11} className="text-emerald-400" />
                        ) : (
                          <AlertTriangle size={11} className="text-red-400" />
                        )}
                        <span className={span.parentId ? 'pl-2 text-text-muted' : 'font-semibold text-text-primary'}>
                          {span.parentId ? '↳ ' : ''}
                          {span.name}
                        </span>
                      </div>
                      <span className="text-[10px] text-text-muted">{span.durationMs ?? 0}ms</span>
                    </div>

                    {/* Horizontal Bar */}
                    <div className="relative h-2 w-full rounded bg-surface-raised/80 overflow-hidden">
                      <div
                        className={`absolute top-0 bottom-0 rounded-sm ${barColor}`}
                        style={{
                          left: `${leftPercent}%`,
                          width: `${widthPercent}%`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Span Details Drawer */}
          {selectedSpan && (
            <div className="rounded border border-border-hairline bg-panel-bg p-3 space-y-2">
              <div className="flex items-center justify-between border-b border-border-hairline/60 pb-1.5">
                <span className="font-semibold text-text-primary text-[11px]">{selectedSpan.name}</span>
                <span className="text-text-muted text-[10px]">ID: {selectedSpan.id}</span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <span className="text-text-muted">Thời lượng:</span> {selectedSpan.durationMs ?? 0}ms
                </div>
                <div>
                  <span className="text-text-muted">Trạng thái:</span>{' '}
                  <span className={selectedSpan.status === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
                    {selectedSpan.status.toUpperCase()}
                  </span>
                </div>
              </div>

              {Object.keys(selectedSpan.attributes).length > 0 && (
                <div className="pt-1 border-t border-border-hairline/40">
                  <div className="text-[10px] text-text-muted mb-1">Thuộc tính (Attributes):</div>
                  <pre className="max-h-24 overflow-y-auto rounded bg-surface-raised/60 p-1.5 text-[10px] text-text-primary">
                    {JSON.stringify(selectedSpan.attributes, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
