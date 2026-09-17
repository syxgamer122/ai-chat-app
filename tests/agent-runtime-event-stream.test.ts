import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendEvent,
  getEventStream,
  getRecentEvents,
  getLastEvent,
  getEventCount,
  countEventsByType,
  formatEventStreamAudit,
  hashEventPayload,
  __clearAllEventStreams,
  EVENT_STREAM_MAX_EVENTS,
  EVENT_PAYLOAD_CHAR_CAP,
  type AgentRuntimeEvent,
} from '@/lib/agent-runtime/event-stream';

describe('agent runtime event-stream', () => {
  beforeEach(() => {
    __clearAllEventStreams();
  });

  it('appendEvent gán id tuần tự và lưu theo conversation', () => {
    appendEvent('c1', { type: 'user_message', payload: 'xin chào' });
    appendEvent('c1', { type: 'agent_action', payload: '{"path":"a.ts"}', toolName: 'fs_read', source: 'model' });
    const events = getEventStream('c1');
    expect(events.length).toBe(2);
    expect(events[0].id).toBe(0);
    expect(events[1].id).toBe(1);
    expect(events[1].toolName).toBe('fs_read');
    expect(events[1].source).toBe('model');
  });

  it('stream tách biệt giữa các conversation', () => {
    appendEvent('a', { type: 'user_message', payload: 'A' });
    appendEvent('b', { type: 'user_message', payload: 'B' });
    expect(getEventCount('a')).toBe(1);
    expect(getEventCount('b')).toBe(1);
    expect(getEventStream('a')[0].payload).toBe('A');
  });

  it('conversation chưa tồn tại trả mảng rỗng', () => {
    expect(getEventStream('none')).toEqual([]);
    expect(getLastEvent('none')).toBeUndefined();
    expect(getEventCount(null)).toBe(0);
  });

  it('append không có conversationId trả event vô danh id -1, không lưu', () => {
    const ev = appendEvent(null, { type: 'system_event', payload: 'x' });
    expect(ev.id).toBe(-1);
    expect(getEventStream(null)).toEqual([]);
  });

  it('contentHash ổn định và chuẩn hoá whitespace', () => {
    const h1 = hashEventPayload('Hello  World\n\nfoo');
    const h2 = hashEventPayload('hello world foo');
    expect(h1).toBe(h2);
    const ev1 = appendEvent('c', { type: 'assistant_message', payload: 'câu trả lời' });
    const ev2 = appendEvent('c', { type: 'assistant_message', payload: 'câu trả lời  \n' });
    expect(ev1.contentHash).toBe(ev2.contentHash);
  });

  it('payload vượt trần bị cắt và đánh dấu', () => {
    const long = 'x'.repeat(EVENT_PAYLOAD_CHAR_CAP + 100);
    const ev = appendEvent('c', { type: 'agent_observation', payload: long, toolName: 'fs_read' });
    expect(ev.payload.length).toBeLessThanOrEqual(EVENT_PAYLOAD_CHAR_CAP + 10);
    expect(ev.payload.endsWith('…[cắt]')).toBe(true);
  });

  it('stream trượt khi vượt EVENT_STREAM_MAX_EVENTS', () => {
    for (let i = 0; i < EVENT_STREAM_MAX_EVENTS + 10; i += 1) {
      appendEvent('c', { type: 'system_event', payload: `e${i}` });
    }
    const events = getEventStream('c');
    expect(events.length).toBe(EVENT_STREAM_MAX_EVENTS);
    // Event cũ nhất bị bỏ — id đầu tiên còn lại là 10.
    expect(events[0].id).toBe(10);
    expect(events[events.length - 1].id).toBe(EVENT_STREAM_MAX_EVENTS + 9);
  });

  it('getRecentEvents trả N event cuối đúng thứ tự', () => {
    for (let i = 0; i < 5; i += 1) {
      appendEvent('c', { type: 'system_event', payload: `e${i}` });
    }
    const recent = getRecentEvents('c', 2);
    expect(recent.map((e) => e.payload)).toEqual(['e3', 'e4']);
  });

  it('countEventsByType đếm đúng theo loại', () => {
    appendEvent('c', { type: 'user_message', payload: 'u1' });
    appendEvent('c', { type: 'user_message', payload: 'u2' });
    appendEvent('c', { type: 'agent_action', payload: 'a', toolName: 'fs_read' });
    appendEvent('c', { type: 'agent_error', payload: 'err', toolName: 'shell_run' });
    const counts = countEventsByType('c');
    expect(counts.user_message).toBe(2);
    expect(counts.agent_action).toBe(1);
    expect(counts.agent_error).toBe(1);
    expect(counts.assistant_message).toBeUndefined();
  });

  it('formatEventStreamAudit render nhãn đúng loại', () => {
    appendEvent('c', { type: 'user_message', payload: 'sửa bug này' });
    appendEvent('c', { type: 'agent_action', payload: '{"cmd":"npm test"}', toolName: 'shell_run' });
    appendEvent('c', { type: 'agent_observation', payload: 'all pass', toolName: 'shell_run' });
    appendEvent('c', { type: 'agent_error', payload: 'boom', toolName: 'fs_write' });
    const audit = formatEventStreamAudit('c');
    expect(audit).toContain('#0 [USER] sửa bug này');
    expect(audit).toContain('TOOL►shell_run');
    expect(audit).toContain('RESULT◄shell_run');
    expect(audit).toContain('ERROR•fs_write');
  });

  it('formatEventStreamAudit stream rỗng trả nhãn tường minh', () => {
    expect(formatEventStreamAudit('empty')).toBe('(stream trống)');
  });

  it('getEventStream trả bản sao, event frozen — mutate không ảnh hưởng store', () => {
    appendEvent('c', { type: 'user_message', payload: 'x' });
    const events = getEventStream('c') as AgentRuntimeEvent[];
    // Mảng là bản sao: push/pop không đụng store.
    events.push({} as AgentRuntimeEvent);
    expect(getEventCount('c')).toBe(1);
    // Event object frozen: gán thuộc tính ném TypeError (strict mode).
    expect(() => {
      (events[0] as { payload: string }).payload = 'mutated';
    }).toThrow();
    expect(getEventStream('c')[0].payload).toBe('x');
  });
});
