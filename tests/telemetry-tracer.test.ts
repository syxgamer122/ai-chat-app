import { describe, it } from 'vitest';
import assert from 'node:assert';
import { LightweightTracer } from '../core/telemetry/tracer';

describe('OpenTelemetry Tracer & Ring Buffer', () => {
  it('handles root and child spans hierarchy and event logging', () => {
    const tracer = new LightweightTracer(5);
    const rootSpan = tracer.startSpan('turn:execute', {
      attributes: { chatId: 'c-1', model: 'gpt-4o' },
    });
    assert.ok(rootSpan.id);
    assert.strictEqual(rootSpan.name, 'turn:execute');
    assert.strictEqual(rootSpan.attributes.model, 'gpt-4o');

    // Child span for tool
    const childSpan = tracer.startSpan('tool:fs_read', {
      parentId: rootSpan.id,
      attributes: { path: 'src/index.ts' },
    });
    assert.strictEqual(childSpan.parentId, rootSpan.id);
    assert.strictEqual(childSpan.traceId, rootSpan.traceId, 'Child span must inherit parent traceId');

    // Add event
    tracer.addSpanEvent(childSpan.id, 'toctou_verified', { hash: 'abc123' });
    tracer.endSpan(childSpan.id, 'ok');

    assert.strictEqual(childSpan.events.length, 1);
    assert.strictEqual(childSpan.events[0].name, 'toctou_verified');
    assert.ok(typeof childSpan.durationMs === 'number');

    tracer.endSpan(rootSpan.id, 'ok');

    const waterfall = tracer.getTraceWaterfall(rootSpan.traceId);
    assert.strictEqual(waterfall.length, 2);
    assert.strictEqual(waterfall[0].id, rootSpan.id);
    assert.strictEqual(waterfall[1].id, childSpan.id);
  });

  it('caps memory and evicts oldest spans in ring buffer', () => {
    const tracer = new LightweightTracer(5);
    for (let i = 0; i < 10; i++) {
      const s = tracer.startSpan(`span-${i}`);
      tracer.endSpan(s.id);
    }
    assert.strictEqual(tracer.size, 5, 'Ring buffer must not exceed capacity');
    const recent = tracer.getRecentSpans();
    assert.strictEqual(recent.length, 5);
    assert.strictEqual(recent[0].name, 'span-9', 'Most recent span should be first');
  });
});
