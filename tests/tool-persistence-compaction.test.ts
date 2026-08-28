/**
 * Bảo vệ hai lỗ rò dữ liệu tool đã sửa:
 *  1. toolInvocations phải sống sót qua Dexie (trước đây StoredMessage không
 *     có trường này → tải lại trang là mất sạch kết quả fs_*).
 *  2. serializeForCompaction phải giữ dấu vết tool (trước đây bỏ qua hoàn
 *     toàn, và message chỉ-có-tool bị loại khỏi payload tóm tắt).
 */

import { describe, expect, it } from 'vitest';
import { toChatMessage } from '@/lib/chat-tree-persistence';
import { sanitizeToolInvocations, STORED_TOOL_INVOCATIONS_MAX } from '@/lib/db';
import type { StoredMessage } from '@/lib/db';
import {
  buildEmergencySummary,
  extractFileOps,
  extractLastConclusion,
  extractUserRequests,
  mergeCompactionState,
  formatCompactContextBlock,
  serializeForCompaction,
  emptyCompactionState,
  COMPACTION_STATE_LIMITS,
} from '@/lib/context-compaction';
import { estimateContextTokens } from '@/lib/context-budget';

function row(extra: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'a1',
    chatId: 'c1',
    role: 'assistant',
    content: 'xong rồi',
    parentId: '__ROOT__',
    seq: 0,
    branchOrder: 0,
    branchTieBreaker: 'a1',
    createdAt: 1,
    ...extra,
  };
}

describe('toolInvocations sống sót qua Dexie', () => {
  it('toChatMessage trả lại toolInvocations cho useChat', () => {
    const msg = toChatMessage(
      row({
        toolInvocations: [
          { toolCallId: 't1', toolName: 'fs_read', args: { path: 'a.ts' }, state: 'result', result: { content: 'X' } },
        ],
      }),
      new Set(),
    );
    const invs = (msg as { toolInvocations?: unknown[] }).toolInvocations;
    expect(invs).toHaveLength(1);
    expect((invs as any)[0].toolName).toBe('fs_read');
  });

  it('message không có tool → không gắn trường thừa', () => {
    const msg = toChatMessage(row(), new Set());
    expect((msg as { toolInvocations?: unknown }).toolInvocations).toBeUndefined();
  });

  it('sanitize loại invocation chưa có kết quả (convert sẽ ném nếu giữ)', () => {
    const out = sanitizeToolInvocations([
      { toolCallId: 't1', toolName: 'fs_read', state: 'call' },
      { toolCallId: 't2', toolName: 'fs_list', state: 'result', result: [] },
    ]);
    expect(out).toHaveLength(1);
    expect(out![0].toolCallId).toBe('t2');
  });

  it('kết quả khổng lồ bị cắt trước khi vào IndexedDB', () => {
    const out = sanitizeToolInvocations([
      { toolCallId: 't1', toolName: 'fs_read', state: 'result', result: { content: 'x'.repeat(60_000) } },
    ]);
    const size = JSON.stringify(out).length;
    expect(size).toBeLessThan(40_000);
    expect((out![0].result as any).truncated).toBe(true);
  });

  it('giữ tối đa N invocation, ưu tiên cái MỚI NHẤT', () => {
    const many = Array.from({ length: STORED_TOOL_INVOCATIONS_MAX + 5 }, (_, i) => ({
      toolCallId: `t${i}`,
      toolName: 'fs_read',
      state: 'result',
      result: { i },
    }));
    const out = sanitizeToolInvocations(many)!;
    expect(out).toHaveLength(STORED_TOOL_INVOCATIONS_MAX);
    expect(out[out.length - 1].toolCallId).toBe(`t${many.length - 1}`);
  });

  it('kết quả không serialize được không làm hỏng cả lượt ghi', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      sanitizeToolInvocations([
        { toolCallId: 't1', toolName: 'x', state: 'result', result: circular },
      ]),
    ).not.toThrow();
  });

  it('ngân sách context đếm được tool result sau khi khôi phục từ DB', () => {
    const restored = toChatMessage(
      row({
        content: '',
        toolInvocations: [
          { toolCallId: 't1', toolName: 'fs_read', state: 'result', result: { content: 'y'.repeat(4_000) } },
        ],
      }),
      new Set(),
    );
    // Trước khi sửa: 0 token vì toolInvocations bị mất khi đọc từ DB.
    expect(estimateContextTokens([restored as never])).toBeGreaterThan(900);
  });
});

describe('compaction giữ dấu vết tool', () => {
  it('message CHỈ có tool call không còn bị loại khỏi payload nén', () => {
    const out = serializeForCompaction([
      {
        role: 'assistant',
        content: '',
        toolInvocations: [
          { state: 'result', args: { path: 'src/a.ts' }, result: { lines: 120 } },
        ],
      } as never,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toMatch(/đã gọi/);
  });

  it('dấu vết nêu tên tool và tham số chính', () => {
    const out = serializeForCompaction([
      {
        role: 'assistant',
        content: 'Đã đọc file.',
        toolInvocations: [
          {
            state: 'result',
            args: { path: 'src/index.ts' },
            result: { ok: true },
            toolName: 'fs_read',
          } as never,
        ],
      } as never,
    ]);
    expect(out[0].content).toContain('fs_read');
    expect(out[0].content).toContain('src/index.ts');
  });

  it('prose dài bị cắt nhưng dấu vết tool vẫn còn (không bị cắt mất)', () => {
    const out = serializeForCompaction([
      {
        role: 'assistant',
        content: 'z'.repeat(50_000),
        toolInvocations: [
          { state: 'result', args: { path: 'keep.ts' }, result: {}, toolName: 'fs_edit' } as never,
        ],
      } as never,
    ]);
    expect(out[0].content).toContain('fs_edit');
    expect(out[0].content).toContain('keep.ts');
  });

  it('args/result khổng lồ bị rút gọn, không thổi phồng payload nén', () => {
    const out = serializeForCompaction([
      {
        role: 'assistant',
        content: '',
        toolInvocations: [
          {
            state: 'result',
            args: { content: 'q'.repeat(30_000) },
            result: { data: 'r'.repeat(30_000) },
            toolName: 'fs_write',
          } as never,
        ],
      } as never,
    ]);
    expect(out[0].content.length).toBeLessThan(2_000);
  });

  it('tin nhắn rỗng hoàn toàn vẫn bị bỏ', () => {
    expect(serializeForCompaction([{ role: 'assistant', content: '' } as never])).toHaveLength(0);
  });
});

/**
 * Tóm tắt TẤT ĐỊNH — thay hard-trim trắng khi gateway không tạo được tóm tắt.
 * Trước đây `summary: ''` nghĩa là hàng chục tin bị loại khỏi ngữ cảnh mà
 * không để lại dấu vết: model mất sạch thông tin đã sửa file nào.
 */
describe('buildEmergencySummary', () => {
  const inv = (toolName: string, path: string) => ({
    state: 'result',
    toolName,
    args: { path },
    result: { ok: true },
  });

  it('phân loại file theo thao tác; đã sửa/ghi thì không nằm ở nhóm đọc', () => {
    const ops = extractFileOps([
      { role: 'assistant', content: '', toolInvocations: [inv('fs_read', 'a.ts')] },
      { role: 'assistant', content: '', toolInvocations: [inv('fs_read', 'b.ts')] },
      { role: 'assistant', content: '', toolInvocations: [inv('fs_edit', 'b.ts')] },
      { role: 'assistant', content: '', toolInvocations: [inv('fs_write', 'c.ts')] },
    ] as never);
    expect(ops.read).toEqual(['a.ts']);
    expect(ops.edited).toEqual(['b.ts']);
    expect(ops.written).toEqual(['c.ts']);
  });

  it('bỏ qua invocation partial-call và tool không có path', () => {
    const ops = extractFileOps([
      {
        role: 'assistant',
        content: '',
        toolInvocations: [
          { state: 'partial-call', toolName: 'fs_read', args: { path: 'x.ts' } },
          { state: 'result', toolName: 'web_search', args: { query: 'abc' } },
        ],
      },
    ] as never);
    expect(ops).toEqual({ read: [], written: [], edited: [] });
  });

  it('trích yêu cầu user, giữ những cái gần nhất', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `việc ${i}` }));
    const out = extractUserRequests(many as never);
    expect(out.length).toBeLessThanOrEqual(8);
    expect(out[out.length - 1]).toBe('việc 19');
  });

  it('kết luận cuối bỏ qua câu đệm vô nghĩa', () => {
    const out = extractLastConclusion([
      { role: 'assistant', content: 'Đã refactor xong module auth.' },
      { role: 'assistant', content: 'xong' },
    ] as never);
    expect(out).toBe('Đã refactor xong module auth.');
  });

  it('summary nêu rõ file đã sửa và yêu cầu đã nêu', () => {
    const summary = buildEmergencySummary({
      messages: [
        { role: 'user', content: 'Sửa lỗi đăng nhập trong auth.ts' },
        { role: 'assistant', content: '', toolInvocations: [inv('fs_read', 'src/auth.ts')] },
        { role: 'assistant', content: '', toolInvocations: [inv('fs_edit', 'src/auth.ts')] },
        { role: 'assistant', content: 'Đã sửa điều kiện kiểm tra token.' },
      ] as never,
    });
    expect(summary).toContain('Sửa lỗi đăng nhập');
    expect(summary).toContain('src/auth.ts');
    expect(summary).toContain('File đã SỬA');
    expect(summary).toContain('Đã sửa điều kiện kiểm tra token.');
  });

  it('giữ nguyên văn tóm tắt của lần nén trước (không có LLM để hợp nhất)', () => {
    const summary = buildEmergencySummary({
      messages: [{ role: 'user', content: 'tiếp tục' }] as never,
      previousSummary: 'Phiên trước: đã dựng xong schema Dexie v10.',
    });
    expect(summary).toContain('đã dựng xong schema Dexie v10');
  });

  it('nêu ngữ cảnh lượt đang dở khi điểm cắt rơi giữa lượt', () => {
    const summary = buildEmergencySummary({
      messages: [{ role: 'user', content: 'cũ' }] as never,
      splitTurnPrefix: [
        { role: 'user', content: 'Chuyển toàn bộ sang TypeScript' },
        { role: 'assistant', content: '', toolInvocations: [inv('fs_search', 'src')] },
      ] as never,
    });
    expect(summary).toContain('đang dở');
    expect(summary).toContain('Chuyển toàn bộ sang TypeScript');
    expect(summary).toContain('fs_search');
  });

  it('phần bị nén không có gì đáng giữ -> trả rỗng để caller hard-trim', () => {
    expect(buildEmergencySummary({ messages: [{ role: 'assistant', content: '' }] as never })).toBe('');
  });

  it('không bao giờ vượt trần ký tự dù đầu vào khổng lồ', () => {
    const huge = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'z'.repeat(5_000),
      toolInvocations: [inv('fs_edit', `src/very/long/path/file-${i}.ts`)],
    }));
    const summary = buildEmergencySummary({ messages: huge as never });
    expect(summary.length).toBeLessThanOrEqual(4_100);
  });
});

/**
 * State tích lũy qua các lần nén — giải quyết vấn đề "sau 2-3 lần nén,
 * model mất sạch dấu vết file đã sửa". Mỗi lần nén merge dữ kiện mới vào
 * state cũ; state sống trong ChatSession.compaction (field không index).
 */
describe('mergeCompactionState', () => {
  it('lần nén đầu: tạo state từ dữ liệu hiện tại, generation = 1', () => {
    const state = mergeCompactionState(
      undefined,
      { read: ['a.ts'], written: [], edited: ['b.ts'] },
      ['sửa lỗi login'],
    );
    expect(state.generation).toBe(1);
    expect(state.filesRead).toEqual(['a.ts']);
    expect(state.filesEdited).toEqual(['b.ts']);
    expect(state.completedRequests).toEqual(['sửa lỗi login']);
  });

  it('file đã sửa/ghi thì KHÔNG còn ở nhóm đọc (loại trừ chéo)', () => {
    const prev = { ...emptyCompactionState(), filesRead: ['a.ts', 'b.ts'], generation: 1 };
    const state = mergeCompactionState(
      prev,
      { read: ['c.ts'], written: ['a.ts'], edited: [] },
      [],
    );
    expect(state.filesRead).toEqual(['b.ts', 'c.ts']); // a.ts bị loại vì đã written
    expect(state.filesWritten).toEqual(['a.ts']);
  });

  it('requests giữ gần nhất khi vượt trần', () => {
    const manyRequests = Array.from({ length: 30 }, (_, i) => `yêu cầu ${i}`);
    const state = mergeCompactionState(undefined, { read: [], written: [], edited: [] }, manyRequests);
    expect(state.completedRequests).toHaveLength(COMPACTION_STATE_LIMITS.maxRequests);
    expect(state.completedRequests[0]).toBe(`yêu cầu ${30 - COMPACTION_STATE_LIMITS.maxRequests}`);
  });

  it('generation tăng dần qua các lần nén', () => {
    let state = mergeCompactionState(undefined, { read: [], written: [], edited: [] }, []);
    expect(state.generation).toBe(1);
    state = mergeCompactionState(state, { read: [], written: [], edited: [] }, []);
    expect(state.generation).toBe(2);
    state = mergeCompactionState(state, { read: [], written: [], edited: [] }, []);
    expect(state.generation).toBe(3);
  });

  it('dedupe requests nguyên văn', () => {
    const prev = { ...emptyCompactionState(), completedRequests: ['sửa auth'], generation: 1 };
    const state = mergeCompactionState(prev, { read: [], written: [], edited: [] }, ['sửa auth', 'thêm test']);
    expect(state.completedRequests).toEqual(['sửa auth', 'thêm test']);
  });

  it('files không vượt trần mỗi nhóm', () => {
    const manyFiles = Array.from({ length: 50 }, (_, i) => `file-${i}.ts`);
    const state = mergeCompactionState(
      undefined,
      { read: manyFiles, written: [], edited: [] },
      [],
    );
    expect(state.filesRead).toHaveLength(COMPACTION_STATE_LIMITS.maxFilesPerGroup);
  });
});

describe('formatCompactContextBlock', () => {
  it('trả rỗng khi không có dữ liệu gì', () => {
    expect(formatCompactContextBlock({ read: [], written: [], edited: [] }, [])).toBe('');
  });

  it('liệt kê file và requests của lượt hiện tại', () => {
    const block = formatCompactContextBlock(
      { read: ['a.ts'], written: [], edited: ['b.ts'] },
      ['sửa lỗi login'],
    );
    expect(block).toContain('File vừa SỬA: b.ts');
    expect(block).toContain('File vừa ĐỌC: a.ts');
    expect(block).toContain('sửa lỗi login');
  });

  it('nêu state tích lũy từ lần nén trước', () => {
    const prev = {
      ...emptyCompactionState(),
      filesEdited: ['old.ts'],
      completedRequests: ['yêu cầu cũ'],
      generation: 2,
    };
    const block = formatCompactContextBlock(
      { read: [], written: [], edited: ['new.ts'] },
      [],
      undefined,
      prev,
    );
    expect(block).toContain('2 lần nén trước');
    expect(block).toContain('old.ts');
    expect(block).toContain('yêu cầu cũ');
    expect(block).toContain('File vừa SỬA: new.ts');
  });

  it('nêu ngữ cảnh lượt đang dở khi có splitTurnPrefixText', () => {
    const block = formatCompactContextBlock(
      { read: [], written: [], edited: [] },
      [],
      'Chuyển toàn bộ sang TypeScript',
    );
    expect(block).toContain('đang dở');
    expect(block).toContain('Chuyển toàn bộ sang TypeScript');
  });
});
