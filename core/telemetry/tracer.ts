/**
 * OpenTelemetry-Compatible Lightweight Tracer (Layer 1: Zero External Dependencies).
 *
 * Quản lý bộ đệm xoay vòng (Ring Buffer) 500 spans gần nhất trong RAM,
 * đo đạc chính xác độ trễ từng Turn, LLM stream, và các Tool executions (fs_*, shell_run, mcp).
 */

export interface TelemetrySpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface TelemetrySpan {
  id: string;
  traceId: string;
  parentId?: string;
  seq: number;
  name: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: 'ok' | 'error';
  attributes: Record<string, string | number | boolean>;
  events: TelemetrySpanEvent[];
}

export const MAX_TELEMETRY_SPANS = 500;

export class LightweightTracer {
  private spans: TelemetrySpan[] = [];
  private activeSpans = new Map<string, TelemetrySpan>();
  private readonly maxSpans: number;
  private seq = 0;

  constructor(maxSpans = MAX_TELEMETRY_SPANS) {
    this.maxSpans = maxSpans;
  }

  public startSpan(
    name: string,
    options: {
      traceId?: string;
      parentId?: string;
      attributes?: Record<string, string | number | boolean>;
    } = {}
  ): TelemetrySpan {
    const id = `span-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const traceId = options.traceId || (options.parentId ? this.getSpan(options.parentId)?.traceId : null) || `trace-${Date.now().toString(36)}`;

    const span: TelemetrySpan = {
      id,
      traceId,
      parentId: options.parentId,
      seq: ++this.seq,
      name,
      startTime: Date.now(),
      status: 'ok',
      attributes: { ...(options.attributes || {}) },
      events: [],
    };

    this.activeSpans.set(id, span);
    return span;
  }

  public addSpanEvent(
    spanId: string,
    name: string,
    attributes?: Record<string, string | number | boolean>
  ): void {
    const span = this.activeSpans.get(spanId) || this.getSpan(spanId);
    if (span) {
      span.events.push({
        name,
        timestamp: Date.now(),
        attributes,
      });
    }
  }

  public endSpan(
    spanId: string,
    status: 'ok' | 'error' = 'ok',
    attributes?: Record<string, string | number | boolean>
  ): TelemetrySpan | undefined {
    const span = this.activeSpans.get(spanId);
    if (!span) return undefined;

    span.endTime = Date.now();
    span.durationMs = Math.max(0, span.endTime - span.startTime);
    span.status = status;
    if (attributes) {
      Object.assign(span.attributes, attributes);
    }

    this.activeSpans.delete(spanId);

    // Thêm vào Ring Buffer
    this.spans.push(span);
    if (this.spans.length > this.maxSpans) {
      this.spans.shift(); // Loại bỏ span cũ nhất khi vượt trần 500
    }

    return span;
  }

  public getSpan(spanId: string): TelemetrySpan | undefined {
    return this.activeSpans.get(spanId) || this.spans.find((s) => s.id === spanId);
  }

  public getRecentSpans(limit = 100): TelemetrySpan[] {
    return this.spans.slice(-limit).reverse();
  }

  public getTraceWaterfall(traceId: string): TelemetrySpan[] {
    return this.spans
      .filter((s) => s.traceId === traceId)
      .sort((a, b) => a.startTime - b.startTime || a.seq - b.seq);
  }

  public clear(): void {
    this.spans = [];
    this.activeSpans.clear();
    this.seq = 0;
  }

  public get size(): number {
    return this.spans.length;
  }
}

export const globalTracer = new LightweightTracer(MAX_TELEMETRY_SPANS);
