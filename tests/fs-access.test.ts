import { beforeEach, describe, expect, it } from 'vitest';
import {
  fsList,
  fsRead,
  fsSearch,
  fsWrite,
  normalizeRelPath,
  type FsDeps,
  type FsDirHandleLike,
} from '@/lib/fs-access';

/** Fake handle tối thiểu mô phỏng FileSystemDirectoryHandle trong bộ nhớ. */
function fakeFile(name: string, content: string) {
  const state = { content };
  const handle = {
    kind: 'file' as const,
    name,
    async getFile() {
      return { size: state.content.length, text: async () => state.content } as unknown as File;
    },
    async createWritable() {
      return {
        write: async (chunk: string) => {
          state.content = chunk;
        },
        close: async () => {},
      };
    },
  };
  return handle;
}

const fakeContent = new Map<string, string>();
let currentDir = '';

function pathKey(dir: string, name: string): string {
  return `${dir}/${name}`.replace(/^\/+/, '');
}

function fakeDir(name: string, children: Array<any>): FsDirHandleLike {
  const self: FsDirHandleLike = {
    kind: 'directory',
    name,
    values: async function* () {
      for (const c of children) yield c;
    },
    async getDirectoryHandle(childName: string, opts?: { create?: boolean }) {
      const found = children.find((c) => c.name === childName && c.kind === 'directory') as FsDirHandleLike | undefined;
      if (!found) {
        if (!opts?.create) throw new Error(`NotFoundError: ${childName}`);
        const created = fakeDir(childName, []);
        children.push(created);
        return created;
      }
      return found;
    },
    async getFileHandle(childName: string, opts?: { create?: boolean }) {
      const found = children.find((c) => c.name === childName && c.kind === 'file');
      if (!found) {
        if (!opts?.create) throw new Error(`NotFoundError: ${childName}`);
        const created = fakeFile(childName, '');
        children.push(created);
        return created;
      }
      return found;
    },
  };
  return self;
}

describe('normalizeRelPath — chắn path traversal', () => {
  it('chuẩn hóa backslash, slash thừa, ./', () => {
    expect(normalizeRelPath('src\\lib\\a.ts')).toBe('src/lib/a.ts');
    expect(normalizeRelPath('/src/')).toBe('src');
    expect(normalizeRelPath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeRelPath('')).toBe('');
  });

  it('chặn tuyệt đối, drive, ..', () => {
    expect(normalizeRelPath('../secret')).toBeNull();
    expect(normalizeRelPath('src/../../etc/passwd')).toBeNull();
    expect(normalizeRelPath('C:/Windows')).toBeNull();
    expect(normalizeRelPath('//server/share')).toBeNull();
  });
});

describe('fs ops trên fake handle', () => {
  let root: FsDirHandleLike;
  let deps: FsDeps;

  beforeEach(() => {
    fakeContent.clear();
    currentDir = '';
    root = fakeDir('proj', [
      fakeFile('README.md', '# hello\nversion 1'),
      fakeDir('src', [
        fakeFile('index.ts', 'export function main() {\n  console.log("hi");\n}\n'),
        fakeFile('util.ts', 'export const add = (a,b) => a+b;'),
        fakeDir('__pycache__', [fakeFile('junk.pyc', 'binary-ish')]),
      ]),
    ]);
    deps = { root, writable: true };
  });

  it('fsList liệt kê một cấp, thư mục trước', async () => {
    const entries = await fsList(deps, '');
    expect(entries[0].type).toBe('dir');
    expect(entries.map((e) => e.name)).toContain('README.md');
    const src = await fsList(deps, 'src');
    expect(src.some((e) => e.name === '__pycache__' && e.type === 'dir')).toBe(true);
  });

  it('fsRead đọc nội dung + ghi nhận truncated', async () => {
    const r = await fsRead(deps, 'src/index.ts');
    expect(r.content).toContain('console.log');
    expect(r.truncated).toBe(false);
    await expect(fsRead(deps, '../outside')).rejects.toThrow();
  });

  it('fsWrite tạo file mới trong thư mục con có create', async () => {
    const r = await fsWrite(deps, 'src/new-file.ts', 'export {};\n');
    expect(r.created).toBe(true);
    expect(r.path).toBe('src/new-file.ts');
    const readBack = await fsRead(deps, 'src/new-file.ts');
    expect(readBack.content).toContain('export {}');
  });

  it('fsSearch tìm case-insensitive, bỏ qua node_modules/.git style dirs', async () => {
    const hits = await fsSearch(deps, 'CONSOLE.LOG'.toLowerCase(), { maxResults: 10 });
    expect(hits.some((h) => h.path === 'src/index.ts' && h.line === 2)).toBe(true);
  });

  it('fsSearch regex mode', async () => {
    const hits = await fsSearch(deps, 'add\\s*=', { isRegex: true });
    expect(hits[0]?.path).toBe('src/util.ts');
  });

  it('fsSearch query rỗng → rỗng', async () => {
    expect(await fsSearch(deps, '   ')).toEqual([]);
  });
});
