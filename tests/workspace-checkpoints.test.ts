import { beforeEach, describe, expect, it } from 'vitest';
import {
  captureFile,
  captureToSnapshot,
  getUndoTarget,
  newTurnCapture,
  planRestore,
  prunePlan,
  type TurnCapture,
} from '@/lib/workspace-checkpoints';
import {
  fsDelete,
  fsReadFull,
  SNAPSHOT_MAX_FILE_BYTES,
  type FsDeps,
  type FsDirHandleLike,
} from '@/lib/fs-access';

/* ------------------------------------------------------------------ */
/* Capture thuần                                                       */
/* ------------------------------------------------------------------ */

describe('workspace-checkpoints — captureFile', () => {
  let turn: TurnCapture;

  beforeEach(() => {
    turn = newTurnCapture('chat-1', 1_700_000_000_000);
  });

  it('file tồn tại → existedBefore=true giữ nguyên content', () => {
    captureFile(turn, { status: 'ok', path: 'src/a.ts', content: 'old' });
    expect(turn.files).toEqual([{ path: 'src/a.ts', content: 'old', existedBefore: true }]);
    expect(turn.incomplete).toBe(false);
  });

  it('missing → file mới tạo, rollback sẽ xoá', () => {
    captureFile(turn, { status: 'missing', path: 'new.ts' });
    expect(turn.files[0]).toEqual({ path: 'new.ts', content: '', existedBefore: false });
  });

  it('too-large / error → incomplete, không có entry file', () => {
    captureFile(turn, { status: 'too-large', path: 'big.bin' });
    captureFile(turn, { status: 'error', path: 'x/y.ts' });
    expect(turn.incomplete).toBe(true);
    expect(turn.files).toHaveLength(0);
  });

  it('FIRST-WINS per path: lần capture sau bị bỏ qua dù status khác', () => {
    captureFile(turn, { status: 'ok', path: 'a.ts', content: 'v1' });
    captureFile(turn, { status: 'ok', path: 'a.ts', content: 'v2' });
    captureFile(turn, { status: 'missing', path: 'a.ts' });
    expect(turn.files).toHaveLength(1);
    expect(turn.files[0].content).toBe('v1');
    // Trạng thái đầu đã chụp đủ — không dính incomplete.
    expect(turn.incomplete).toBe(false);
  });
});

describe('workspace-checkpoints — getUndoTarget (LIFO)', () => {
  const snap = (id: string, createdAt: number, extra: Record<string, unknown> = {}) => ({
    id,
    chatId: 'c',
    createdAt,
    files: [{ path: 'f.ts', content: 'x', existedBefore: true }],
    ...extra,
  });

  it('rỗng / chỉ toàn undone / chỉ toàn incomplete → null', () => {
    expect(getUndoTarget([])).toBeNull();
    expect(getUndoTarget([snap('a', 2, { undoneAt: 9 })])).toBeNull();
    expect(getUndoTarget([snap('a', 2, { incomplete: true })])).toBeNull();
    expect(
      getUndoTarget([{ id: 'a', chatId: 'c', createdAt: 1, files: [] }]),
    ).toBeNull();
  });

  it('mới nhất thắng', () => {
    expect(getUndoTarget([snap('old', 1), snap('new', 5)])?.id).toBe('new');
  });

  it('bản mới hơn đã undone → nhường bản active cũ hơn', () => {
    expect(getUndoTarget([snap('new', 5, { undoneAt: 9 }), snap('old', 1)])?.id).toBe('old');
  });

  it('incomplete KHÔNG chặn LIFO của bản khác', () => {
    expect(getUndoTarget([snap('broken', 9, { incomplete: true }), snap('good', 1)])?.id).toBe(
      'good',
    );
  });
});

describe('workspace-checkpoints — prunePlan', () => {
  const rows = (...items: Array<[string, number, boolean?]>) =>
    items.map(([id, createdAt, undone]) => ({
      id,
      chatId: 'c',
      createdAt,
      files: [{ path: 'f', content: '', existedBefore: true }],
      ...(undone ? { undoneAt: createdAt + 1 } : {}),
    }));

  it('dưới trần → không xoá gì', () => {
    expect(prunePlan(rows(['a', 1], ['b', 2]), 5)).toEqual([]);
  });

  it('vượt trần → xoá cũ nhất trước', () => {
    expect(prunePlan(rows(['a', 1], ['b', 2], ['c', 3]), 2)).toEqual(['a']);
  });

  it('ưu tiên xoá bản undone trước bản active cũ nhất', () => {
    // 'undone-new' mới hơn nhưng đã mất giá trị vận hành — xoá trước.
    expect(prunePlan(rows(['undone-new', 9, true], ['old-active', 1]), 1)).toEqual([
      'undone-new',
    ]);
  });
});

describe('workspace-checkpoints — captureToSnapshot & planRestore', () => {
  it('snapshot copy files, giữ incomplete', () => {
    const turn = newTurnCapture('chat-9', 42);
    captureFile(turn, { status: 'ok', path: 'a.ts', content: 'A' });
    captureFile(turn, { status: 'missing', path: 'b.ts' });
    const snap = captureToSnapshot(turn);
    expect(snap.id).toBe(turn.id);
    expect(snap.chatId).toBe('chat-9');
    expect(snap.files).toHaveLength(2);
    expect(snap.files).not.toBe(turn.files); // copy mảng, không dùng chung ref
    expect(snap.incomplete).toBeUndefined();

    turn.incomplete = true;
    expect(captureToSnapshot(turn).incomplete).toBe(true);
  });

  it('planRestore: existedBefore=false → delete', () => {
    const ops = planRestore({
      id: 's',
      chatId: 'c',
      createdAt: 0,
      files: [
        { path: 'keep.ts', content: 'OLD', existedBefore: true },
        { path: 'created.ts', content: '', existedBefore: false },
      ],
    });
    expect(ops).toEqual([
      { action: 'write', path: 'keep.ts', content: 'OLD' },
      { action: 'delete', path: 'created.ts' },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* fs-access additions trên fake handle                                */
/* ------------------------------------------------------------------ */

interface FakeFileHandle {
  kind: 'file';
  name: string;
  removed: boolean;
  getFile(): Promise<File>;
  remove(): Promise<void>;
}

function fakeFile(name: string, content: string): FakeFileHandle {
  const state = { content, removed: false };
  return {
    kind: 'file',
    name,
    get removed() {
      return state.removed;
    },
    async getFile() {
      if (state.removed) throw new Error(`NotFoundError: ${name}`);
      return { size: state.content.length, text: async () => state.content } as unknown as File;
    },
    async remove() {
      state.removed = true;
    },
  };
}

type AnyNode = FakeFileHandle | FsDirHandleLike;

function fakeDir(name: string, children: Array<AnyNode> = []): FsDirHandleLike & {
  __children: Array<AnyNode>;
} {
  const self = {
    kind: 'directory' as const,
    name,
    __children: children,
    values: async function* () {
      for (const c of children) yield c;
    },
    async getDirectoryHandle(childName: string, opts?: { create?: boolean }) {
      const found = children.find((c) => c.name === childName && c.kind === 'directory') as
        | FsDirHandleLike
        | undefined;
      if (!found) {
        if (!opts?.create) throw new Error(`NotFoundError: ${childName}`);
        const created = fakeDir(childName);
        children.push(created);
        return created;
      }
      return found;
    },
    async getFileHandle(childName: string, opts?: { create?: boolean }) {
      const found = children.find((c) => c.name === childName && c.kind === 'file') as
        | FakeFileHandle
        | undefined;
      if (!found || found.removed) {
        if (!opts?.create) throw new Error(`NotFoundError: ${childName}`);
        const created = fakeFile(childName, '');
        children.push(created);
        return created as never;
      }
      return found as never;
    },
    async removeEntry(childName: string) {
      const idx = children.findIndex((c) => c.name === childName && c.kind === 'file');
      if (idx < 0) throw new Error(`NotFoundError: ${childName}`);
      (children[idx] as FakeFileHandle).removed = true;
      children.splice(idx, 1);
    },
  };
  return self as FsDirHandleLike & { __children: Array<AnyNode> };
}

function childrenOf(dir: FsDirHandleLike): Array<AnyNode> {
  return (dir as unknown as { __children: Array<AnyNode> }).__children ?? [];
}

describe('fs-access — fsReadFull & fsDelete (checkpoint ops)', () => {
  let root: ReturnType<typeof fakeDir>;
  let deps: FsDeps;

  beforeEach(() => {
    root = fakeDir('proj', [
      fakeFile('README.md', '# hello'),
      fakeDir('src', [fakeFile('index.ts', 'export {};\n')]),
    ]);
    deps = { root, writable: true };
  });

  it('fsReadFull đọc đủ nội dung + chuẩn hoá path', async () => {
    const r = await fsReadFull(deps, 'src\\index.ts');
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.path).toBe('src/index.ts');
      expect(r.content).toBe('export {};\n');
    }
  });

  it('fsReadFull: missing / quá lớn / path xấu', async () => {
    expect((await fsReadFull(deps, 'nope.ts')).status).toBe('missing');

    childrenOf(await root.getDirectoryHandle('src')).push(
      fakeFile('big.log', 'x'.repeat(SNAPSHOT_MAX_FILE_BYTES + 1)),
    );
    const r = await fsReadFull(deps, 'src/big.log');
    expect(r.status).toBe('too-large');
    if (r.status === 'too-large') expect(r.size).toBeGreaterThan(SNAPSHOT_MAX_FILE_BYTES);

    expect((await fsReadFull(deps, '../escape')).status).toBe('error');
  });

  it('fsDelete ưu tiên handle.remove()', async () => {
    const f = childrenOf(root)[0] as FakeFileHandle;
    await fsDelete(deps, './README.md');
    expect(f.removed).toBe(true);
  });

  it('fsDelete fallback dir.removeEntry khi handle thiếu .remove()', async () => {
    const plain = {
      kind: 'file' as const,
      name: 'plain.txt',
      async getFile() {
        return { size: 1, text: async () => '' } as unknown as File;
      },
      // không có remove()
    };
    childrenOf(root).push(plain as never);
    const r = await fsDelete(deps, 'plain.txt');
    expect(r.path).toBe('plain.txt');
    expect(childrenOf(root).some((c) => c.name === 'plain.txt')).toBe(false);
  });

  it('fsDelete ném lỗi khi cả hai đường xoá đều không có', async () => {
    const legacyRoot: FsDirHandleLike = {
      kind: 'directory',
      name: 'legacy',
      values: async function* () {},
      async getDirectoryHandle() {
        throw new Error('not used');
      },
      async getFileHandle(name: string) {
        return {
          kind: 'file' as const,
          name,
          async getFile() {
            return { size: 1, text: async () => '' } as unknown as File;
          },
        };
      },
    };
    await expect(fsDelete({ root: legacyRoot }, 'a.txt')).rejects.toThrow(/không hỗ trợ xoá/);
  });
});
