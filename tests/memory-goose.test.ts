import { describe, expect, it } from 'vitest';
import {
  validateMemoryInput,
  normalizeCategory,
  normalizeTags,
  memoriesForWorkspace,
  buildMemoryIndexBlock,
  retrieveMatchingMemories,
  renderMemoryMarkdown,
  agentMemoriesAsLessons,
  GOOSE_MEMORY_LIMITS,
  type AgentMemoryRecord,
} from '@/lib/memory/goose';
import { parseMemoryMarkdown } from '@/lib/memory/goose-client';

function rec(over: Partial<AgentMemoryRecord> = {}): AgentMemoryRecord {
  return {
    id: 'm1',
    category: 'workflow',
    data: 'project dùng pnpm',
    tags: ['tooling'],
    scope: 'local',
    workspaceKey: 'ai-chat-app',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

/** fold đơn giản cho test (bỏ dấu thủ công không cần ở đây — dùng lowercase). */
const fold = (s: string) => s.toLowerCase();

describe('memory/goose — validate + normalize', () => {
  it('category chuẩn hoá: lower + space→dash + trần', () => {
    expect(normalizeCategory('  WorkFlow  ')).toBe('workflow');
    expect(normalizeCategory('My Notes Here')).toBe('my-notes-here');
    expect(normalizeCategory('x'.repeat(100)).length).toBe(GOOSE_MEMORY_LIMITS.categoryChars);
  });

  it('tags: dedupe + lower + trần 8', () => {
    expect(normalizeTags(['A', 'a', 'b'])).toEqual(['a', 'b']);
    expect(normalizeTags(Array.from({ length: 12 }, (_, i) => `t${i}`)).length).toBe(8);
  });

  it('validate: thiếu category / data quá ngắn → lỗi', () => {
    expect(validateMemoryInput({ category: '', data: 'abc', workspaceKey: 'w' }).ok).toBe(false);
    expect(validateMemoryInput({ category: 'c', data: 'ab', workspaceKey: 'w' }).ok).toBe(false);
  });

  it('validate: trần 2.000 ký tự (nâng từ 400)', () => {
    const long = 'x'.repeat(3_000);
    const r = validateMemoryInput({ category: 'c', data: long, workspaceKey: 'w' });
    expect(r.ok).toBe(true);
    expect(r.record!.data.length).toBe(GOOSE_MEMORY_LIMITS.dataChars);
  });

  it('is_global=true → scope global + workspaceKey "*"', () => {
    const r = validateMemoryInput({ category: 'c', data: 'dài hơn 4 ký tự', is_global: true, workspaceKey: 'w' });
    expect(r.record!.scope).toBe('global');
    expect(r.record!.workspaceKey).toBe('*');
  });

  it('mặc định local + workspaceKey của workspace hiện tại', () => {
    const r = validateMemoryInput({ category: 'c', data: 'dài hơn 4 ký tự', workspaceKey: 'myproj' });
    expect(r.record!.scope).toBe('local');
    expect(r.record!.workspaceKey).toBe('myproj');
  });
});

describe('memory/goose — lọc scope', () => {
  it('global luôn vào; local chỉ khi trùng workspaceKey', () => {
    const records = [
      rec({ id: 'l1', workspaceKey: 'proj-a' }),
      rec({ id: 'l2', workspaceKey: 'proj-b' }),
      rec({ id: 'g1', scope: 'global', workspaceKey: '*' }),
    ];
    expect(memoriesForWorkspace(records, 'proj-a').map((r) => r.id).sort()).toEqual(['g1', 'l1']);
  });
});

describe('memory/goose — index block (ngân sách 4.000)', () => {
  it('rỗng → block rỗng', () => {
    const b = buildMemoryIndexBlock([]);
    expect(b.block).toBe('');
    expect(b.totalCount).toBe(0);
  });

  it('liệt kê category + số lượng + tags; global ngắn chèn sau', () => {
    const b = buildMemoryIndexBlock([
      rec({ id: '1', category: 'workflow' }),
      rec({ id: '2', category: 'workflow' }),
      rec({ id: '3', category: 'preference', scope: 'global', data: 'thích dark mode' }),
    ]);
    expect(b.block).toContain('workflow · 2');
    expect(b.block).toContain('preference · 1');
    expect(b.block).toContain('thích dark mode');
    expect(b.injectedCount).toBe(1); // chỉ global mới được nhúng nội dung
    expect(b.totalCount).toBe(3);
  });

  it('vượt ngân sách → truncated + không nhúng quá trần', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      rec({ id: `g${i}`, scope: 'global', data: 'x'.repeat(300), createdAt: i }),
    );
    const b = buildMemoryIndexBlock(many, 1_000);
    expect(b.truncated).toBe(true);
    expect(b.block.length).toBeLessThanOrEqual(1_200);
  });
});

describe('memory/goose — retrieve', () => {
  const records = [
    rec({ id: 'a', category: 'workflow', data: 'project dùng pnpm để cài', tags: ['tooling'], createdAt: 3 }),
    rec({ id: 'b', category: 'preference', data: 'thích dark mode', tags: ['ui'], createdAt: 2 }),
    rec({ id: 'c', category: 'workflow', workspaceKey: 'other', data: 'không thuộc workspace', createdAt: 1 }),
  ];

  it('không query → mới nhất trước, theo scope', () => {
    const r = retrieveMatchingMemories(records, { workspaceKey: 'ai-chat-app' }, fold);
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('query khớp text', () => {
    const r = retrieveMatchingMemories(records, { query: 'pnpm', workspaceKey: 'ai-chat-app' }, fold);
    expect(r.map((x) => x.id)).toEqual(['a']);
  });

  it('filter category + tags', () => {
    expect(
      retrieveMatchingMemories(records, { category: 'preference', workspaceKey: 'ai-chat-app' }, fold).map((x) => x.id),
    ).toEqual(['b']);
    expect(
      retrieveMatchingMemories(records, { tags: ['tooling'], workspaceKey: 'ai-chat-app' }, fold).map((x) => x.id),
    ).toEqual(['a']);
  });

  it('không khớp → rỗng', () => {
    expect(retrieveMatchingMemories(records, { query: 'zzzz', workspaceKey: 'ai-chat-app' }, fold)).toEqual([]);
  });

  it('trần kết quả retrieveLimit', () => {
    const many = Array.from({ length: 20 }, (_, i) => rec({ id: `x${i}`, data: 'chung chung', createdAt: i }));
    expect(
      retrieveMatchingMemories(many, { workspaceKey: 'ai-chat-app' }, fold).length,
    ).toBe(GOOSE_MEMORY_LIMITS.retrieveLimit);
  });
});

describe('memory/goose — markdown mirror', () => {
  it('render ra heading theo category + id comment', () => {
    const md = renderMemoryMarkdown('workflow', [rec({ id: 'abc' })]);
    expect(md).toContain('# workflow');
    expect(md).toContain('<!-- id: abc -->');
    expect(md).toContain('project dùng pnpm');
  });

  it('parseMemoryMarkdown round-trip giữ id + data + tags', () => {
    const md = renderMemoryMarkdown('workflow', [
      rec({ id: 'abc', tags: ['tooling', 'setup'] }),
      rec({ id: 'def', data: 'fact thứ hai', tags: [] }),
    ]);
    const parsed = parseMemoryMarkdown(md);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.id).toBe('abc');
    expect(parsed[0]!.data).toBe('project dùng pnpm');
    expect(parsed[0]!.tags).toEqual(['tooling', 'setup']);
    expect(parsed[1]!.id).toBe('def');
    expect(parsed[1]!.data).toBe('fact thứ hai');
  });

  it('entry người dùng tự thêm (không có id) → parse với id null', () => {
    const md = ['# mycat', '## 2026-01-01 · local', 'fact viết tay'].join('\n');
    const parsed = parseMemoryMarkdown(md);
    expect(parsed[0]!.id).toBeNull();
    expect(parsed[0]!.data).toBe('fact viết tay');
  });
});

describe('memory/goose — lesson bridge (không phá lesson_save)', () => {
  it('category lesson → prefix [LESSON:pattern] giữ đường formatLessonsBlock cũ', () => {
    const out = agentMemoriesAsLessons([rec({ category: 'lesson', data: 'luôn chạy tsc trước commit' })], 'ai-chat-app');
    expect(out[0]!.text).toBe('[LESSON:pattern] luôn chạy tsc trước commit');
  });

  it('category khác lesson bị loại', () => {
    expect(agentMemoriesAsLessons([rec({ category: 'workflow' })], 'ai-chat-app')).toEqual([]);
  });
});
