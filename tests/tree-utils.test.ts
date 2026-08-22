import { describe, expect, it } from 'vitest';
import {
  reconstructActiveThread,
  reconstructActiveThreadSafe,
  findDeepestLeafId,
  getSiblings,
} from '@/lib/tree-utils';
import { validateLeafChain } from '@/lib/tree-validation';
import type { StoredMessage } from '@/lib/db';

const ROOT = '__ROOT__';
let n = 0;

function msg(partial: Partial<StoredMessage> & { id: string; parentId: string }): StoredMessage {
  n += 1;
  return {
    chatId: 'c1',
    role: 'user',
    content: `content-${partial.id}`,
    seq: n,
    branchOrder: 0,
    branchTieBreaker: partial.id,
    createdAt: n,
    ...partial,
  };
}

/** Cây: root ── u1 ── a1 (leaf)
 *              └── u2 ── a2 (leaf, nhánh thứ hai của root) */
function buildTree(): StoredMessage[] {
  return [
    msg({ id: 'u1', parentId: ROOT, branchOrder: 0, createdAt: 1 }),
    msg({ id: 'a1', parentId: 'u1', createdAt: 2 }),
    msg({ id: 'u2', parentId: ROOT, branchOrder: 1, createdAt: 3 }),
    msg({ id: 'a2', parentId: 'u2', createdAt: 4 }),
  ];
}

describe('tree-utils', () => {
  it('reconstructActiveThread đi từ leaf lên root đúng thứ tự', () => {
    const thread = reconstructActiveThread(buildTree(), 'a1');
    expect(thread.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('leaf không tồn tại → fallback sang nhánh sâu nhất (sibling cuối)', () => {
    const thread = reconstructActiveThread(buildTree(), 'khong-ton-tai');
    expect(thread.map((m) => m.id)).toEqual(['u2', 'a2']);
  });

  it('findDeepestLeafId từ root chọn sibling cuối cùng đi xuống', () => {
    expect(findDeepestLeafId(buildTree(), 'u1')).toBe('a1');
  });

  it('getSiblings trả về nhóm sibling đúng vị trí hiện tại', () => {
    const rows = buildTree();
    const info = getSiblings(rows, 'u2');
    expect(info.total).toBe(2);
    expect(info.currentIndex).toBe(1);
    expect(info.siblings.map((s) => s.id)).toEqual(['u1', 'u2']);
  });

  it('orphan (cha đã xoá) được quy về root và vẫn đọc được thread', () => {
    const rows = [msg({ id: 'orphan', parentId: 'da-xoa', createdAt: 9 })];
    const result = reconstructActiveThreadSafe(rows, 'orphan');
    expect(result.messages.map((m) => m.id)).toEqual(['orphan']);
    expect(result.detachedRootId).toBe('orphan');
  });

  it('cycle không gây vòng lặp vô hạn', () => {
    const rows = [
      msg({ id: 'x', parentId: 'y', createdAt: 1 }),
      msg({ id: 'y', parentId: 'x', createdAt: 2 }),
    ];
    const result = reconstructActiveThreadSafe(rows, 'x');
    expect(result.broken).toBe(true);
  });
});

describe('validateLeafChain', () => {
  it('chuỗi leaf→root hợp lệ với sentinel __ROOT__', () => {
    const rows = buildTree();
    expect(validateLeafChain(rows, 'c1', 'a1')).toEqual({ valid: true });
    expect(validateLeafChain(rows, 'c1', 'a2')).toEqual({ valid: true });
  });

  it('leaf thuộc chat khác → wrong-session', () => {
    const rows = [msg({ id: 'other', parentId: ROOT, chatId: 'c2' })];
    const result = validateLeafChain([...buildTree(), ...rows], 'c1', 'other');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('wrong-session');
  });

  it('cha thiếu → missing-parent', () => {
    const rows = [msg({ id: 'lost', parentId: 'khong-co', createdAt: 5 })];
    const result = validateLeafChain(rows, 'c1', 'lost');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing-parent');
  });

  it('leaf null → missing-leaf', () => {
    expect(validateLeafChain(buildTree(), 'c1', null).reason).toBe('missing-leaf');
  });
});
