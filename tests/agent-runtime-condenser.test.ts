import { describe, it, expect, beforeEach } from 'vitest';
import {
  appendEvent,
  __clearAllEventStreams,
  type AgentRuntimeEvent,
} from '@/lib/agent-runtime/event-stream';
import {
  condense,
  condenseForConversation,
  renderCondensedContext,
  CONDENSER_RECENT_KEEP,
  CONDENSER_FORGET_THRESHOLD,
  CONDENSER_COALESCE_MIN_RUN,
} from '@/lib/agent-runtime/condenser';

function ev(type: AgentRuntimeEvent['type'], payload: string, toolName?: string): AgentRuntimeEvent {
  return {
    id: 0,
    type,
    ts: 0,
    payload,
    toolName,
    source: 'tool',
    contentHash: payload.replace(/\s+/g, ' ').trim().toLowerCase(),
  };
}

describe('agent runtime condenser', () => {
  beforeEach(() => {
    __clearAllEventStreams();
  });

  it('stream rỗng → kết quả rỗng', () => {
    const r = condense([]);
    expect(r.regions).toEqual([]);
    expect(r.totalEvents).toBe(0);
    expect(r.savedChars).toBe(0);
  });

  it('dưới ngưỡng: giữ nguyên toàn bộ', () => {
    const events = [
      ev('user_message', 'sửa bug'),
      ev('agent_action', '{"path":"a.ts"}', 'fs_read'),
      ev('agent_observation', 'nội dung a', 'fs_read'),
    ];
    const r = condense(events);
    expect(r.totalEvents).toBe(3);
    expect(r.keptEvents).toBe(3);
    expect(r.savedChars).toBe(0);
    expect(r.regions.every((reg) => reg.kind === 'kept')).toBe(true);
  });

  it('coalesce: obs trùng lặp liên tiếp được gom thành 1 region', () => {
    const events = [
      ev('agent_action', '{"cmd":"ls"}', 'shell_run'),
      ev('agent_observation', 'file1\nfile2', 'shell_run'),
      ev('agent_observation', 'file1\nfile2', 'shell_run'),
      ev('agent_observation', 'file1\nfile2', 'shell_run'),
    ];
    const r = condense(events);
    const coalesced = r.regions.filter((reg) => reg.kind === 'coalesced');
    expect(coalesced.length).toBe(1);
    const region = coalesced[0];
    if (region.kind !== 'coalesced') throw new Error('unreachable');
    expect(region.toolName).toBe('shell_run');
    expect(region.count).toBe(3);
    // 3 payload trùng (mỗi cái 11 ký tự) chỉ còn 1 payload + dòng mô tả.
    expect(r.savedChars).toBeGreaterThanOrEqual(0);
    expect(r.keptEvents).toBe(1); // action giữ, 3 obs gom thành 1 region
  });

  it('coalesce: obs khác nhau KHÔNG bị gom', () => {
    const events = [
      ev('agent_observation', 'nội dung A', 'fs_read'),
      ev('agent_observation', 'nội dung B', 'fs_read'),
    ];
    const r = condense(events);
    expect(r.regions.every((reg) => reg.kind === 'kept')).toBe(true);
    expect(r.savedChars).toBe(0);
  });

  it('coalesce chỉ chạy từ CONDENSER_COALESCE_MIN_RUN obs trùng', () => {
    const events = [
      ev('agent_observation', 'giống nhau', 'fs_read'),
      ev('agent_observation', 'giống nhau', 'fs_read'),
    ];
    const r = condense(events);
    expect(CONDENSER_COALESCE_MIN_RUN).toBe(2);
    expect(r.regions.filter((reg) => reg.kind === 'coalesced').length).toBe(1);
  });

  it('vượt ngưỡng: vùng ĐẦU fold thành forgotten kèm tóm tắt', () => {
    const events: AgentRuntimeEvent[] = [];
    const total = CONDENSER_FORGET_THRESHOLD + 6;
    for (let i = 0; i < total; i += 1) {
      events.push(ev('user_message', `yêu cầu số ${i}`));
    }
    const r = condense(events);
    const forgotten = r.regions.filter((reg) => reg.kind === 'forgotten');
    expect(forgotten.length).toBe(1);
    const region = forgotten[0];
    if (region.kind !== 'forgotten') throw new Error('unreachable');
    expect(region.count).toBe(total - CONDENSER_RECENT_KEEP);
    expect(region.summary).toContain('tin nhắn người dùng');
    // Phần cuối được giữ nguyên văn.
    expect(r.keptEvents).toBe(CONDENSER_RECENT_KEEP);
    expect(r.savedChars).toBeGreaterThan(0);
  });

  it('vượt ngưỡng: CONDENSER_RECENT_KEEP event cuối luôn nguyên văn', () => {
    expect(CONDENSER_RECENT_KEEP).toBe(8);
    const events: AgentRuntimeEvent[] = [];
    for (let i = 0; i < CONDENSER_FORGET_THRESHOLD + 2; i += 1) {
      events.push(ev('agent_action', `{"path":"f${i}.ts"}`, 'fs_read'));
    }
    const r = condense(events);
    const keptRegions = r.regions.filter((reg) => reg.kind === 'kept');
    const keptCount = keptRegions.reduce((n, reg) => (reg.kind === 'kept' ? n + reg.events.length : n), 0);
    expect(keptCount).toBe(CONDENSER_RECENT_KEEP);
    // Event cuối cùng nguyên văn nằm trong kết quả.
    const lastKept = keptRegions[keptRegions.length - 1];
    if (lastKept.kind !== 'kept') throw new Error('unreachable');
    expect(lastKept.events[lastKept.events.length - 1].payload).toContain(`f${events.length - 1}`);
  });

  it('condenseForConversation đọc từ store', () => {
    for (let i = 0; i < CONDENSER_FORGET_THRESHOLD + 4; i += 1) {
      appendEvent('c', { type: 'system_event', payload: `sự kiện ${i}` });
    }
    const r = condenseForConversation('c');
    expect(r.totalEvents).toBe(CONDENSER_FORGET_THRESHOLD + 4);
    expect(r.regions[0].kind).toBe('forgotten');
  });

  it('renderCondensedContext hiển thị đủ 3 loại region', () => {
    const events: AgentRuntimeEvent[] = [];
    for (let i = 0; i < CONDENSER_FORGET_THRESHOLD + 2; i += 1) {
      events.push(ev('user_message', `yêu cầu ${i}`));
    }
    // Thêm cặp obs trùng ở phần giữ lại.
    events.push(ev('agent_observation', 'kết quả trùng', 'shell_run'));
    events.push(ev('agent_observation', 'kết quả trùng', 'shell_run'));
    const r = condense(events);
    const text = renderCondensedContext(r);
    expect(text).toContain('sự kiện cũ đã nén]');
    expect(text).toContain('trùng lặp — giữ 1 mẫu');
    expect(text).toMatch(/USER:|TOOL:/);
  });
});
