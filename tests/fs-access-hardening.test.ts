/**
 * Vệ sinh input thật của model cho fs_list/fs_search.
 *
 * fs_list: model khám phá workspace rất hay truyền '.' hoặc './src'. Bản cũ
 * đẩy path thô vào getDirectoryHandle — segment '.' là tên không hợp lệ theo
 * spec File System Access nên Chrome ném TypeError mù mờ. Mock ở đây tái hiện
 * đúng hành vi đó để test đỏ nếu ai bỏ bước normalize.
 *
 * fs_search: hai lớp chống regex đóng băng UI — từ chối pattern lượng hóa
 * lồng nhau TRƯỚC khi dựng RegExp, và bỏ qua dòng dài khi search bằng regex
 * (backtracking nhân theo độ dài dòng; tìm chuỗi thường thì tuyến tính nên
 * không bị skip).
 */

import { describe, expect, it } from 'vitest';
import {
  fsList,
  fsSearch,
  hasNestedQuantifier,
  MAX_SEARCH_LINE_CHARS,
  type FsDeps,
  type FsDirHandleLike,
} from '@/lib/fs-access';

function fakeFile(name: string, content: string) {
  return {
    kind: 'file' as const,
    name,
    async getFile() {
      return { size: content.length, text: async () => content } as unknown as File;
    },
  };
}

function fakeDir(name: string, children: Array<any>): FsDirHandleLike {
  const self: FsDirHandleLike = {
    kind: 'directory',
    name,
    async *values() {
      for (const c of children) yield c as never;
    },
    async getDirectoryHandle(childName: string, opts?: { create?: boolean }) {
      /* Tái hiện spec File System Access: '.'/'..' không phải tên hợp lệ —
         đúng lỗi TypeError mà Chrome ném, đó chính là bug fs_list gốc. */
      if (childName === '.' || childName === '..') {
        throw new TypeError(
          `Failed to execute 'getDirectoryHandle' on '${name}': Name is not allowed to be '.' or '..'.`,
        );
      }
      const found = children.find((c) => c.name === childName && c.kind === 'directory') as FsDirHandleLike | undefined;
      if (!found) {
        if (!opts?.create) throw new Error(`NotFoundError: ${childName}`);
        const created = fakeDir(childName, []);
        children.push(created);
        return created;
      }
      return found;
    },
    async getFileHandle(childName: string) {
      const found = children.find((c) => c.name === childName && c.kind === 'file');
      if (!found) throw new Error(`NotFoundError: ${childName}`);
      return found as never;
    },
  };
  return self;
}

function makeDeps(): FsDeps {
  const root = fakeDir('proj', [
    fakeFile('README.md', '# hello'),
    fakeDir('src', [fakeFile('index.ts', 'console.log("hi");\n')]),
  ]);
  return { root, writable: false };
}

describe('fs_list — chuẩn hóa path như mọi op fs khác', () => {
  it("'.' liệt kê gốc thay vì TypeError", async () => {
    const deps = makeDeps();
    const entries = await fsList(deps, '.');
    expect(entries.map((e) => e.name).sort()).toEqual(['README.md', 'src']);
  });

  it("'./src' resolve như 'src'", async () => {
    const deps = makeDeps();
    const withDot = await fsList(deps, './src');
    const plain = await fsList(deps, 'src');
    expect(withDot).toEqual(plain);
    expect(withDot.map((e) => e.name)).toContain('index.ts');
  });

  it("'..' bị chặn với thông báo đường dẫn không hợp lệ", async () => {
    const deps = makeDeps();
    await expect(fsList(deps, '../outside')).rejects.toThrow(/không hợp lệ/);
    await expect(fsList(deps, 'src/../..')).rejects.toThrow(/không hợp lệ/);
  });

  it("trailing slash vẫn chạy ('src/')", async () => {
    const deps = makeDeps();
    const entries = await fsList(deps, 'src/');
    expect(entries.map((e) => e.name)).toContain('index.ts');
  });
});

describe('hasNestedQuantifier — heuristic chặn backtracking thảm hoạ', () => {
  it('bắt các dạng nhóm lặp chứa quantifier', () => {
    expect(hasNestedQuantifier('(a+)+')).toBe(true);
    expect(hasNestedQuantifier('(a*)*')).toBe(true);
    expect(hasNestedQuantifier('(\\w+\\s*)+')).toBe(true);
    expect(hasNestedQuantifier('((a+))+')).toBe(true);
    expect(hasNestedQuantifier('(?:ab+)+')).toBe(true);
    expect(hasNestedQuantifier('(a|b+)+')).toBe(true);
  });

  it('pattern lành thường không bị từ chối', () => {
    expect(hasNestedQuantifier('add\\s*=')).toBe(false);
    expect(hasNestedQuantifier('a+b*c?')).toBe(false);
    expect(hasNestedQuantifier('(?:ab)+')).toBe(false);
    expect(hasNestedQuantifier('(\\d+)?')).toBe(false);
    expect(hasNestedQuantifier('[a+z]+\\d')).toBe(false);
    expect(hasNestedQuantifier('(?:https?:\\/\\/)[^\\s]+')).toBe(false);
    expect(hasNestedQuantifier('x{2,3}y')).toBe(false);
    expect(hasNestedQuantifier('(a|b)*')).toBe(false);
  });

  it('ranh giới đã chốt: quantifier ngoài có chặn trên thì bỏ qua, alternation chồng lấn thì khỏi gắp', () => {
    // (a+){2} lặp hữu hạn — không bùng nổ hàm mũ, heuristic cố ý bỏ qua.
    expect(hasNestedQuantifier('(a+){2}')).toBe(false);
    // (a|aa)+ chồng lấn vế — KHÔNG bị heuristic bắt (giới hạn đã ghi trong
    // doc của hàm); lớp phòng thủ thứ hai là trần 5000 ký tự/dòng của fsSearch.
    expect(hasNestedQuantifier('(a|aa)+')).toBe(false);
  });
});

describe('fs_search — guard regex + trần độ dài dòng', () => {
  it('pattern lượng hóa lồng nhau bị từ chối với gợi ý tắt is_regex', async () => {
    const deps = makeDeps();
    await expect(fsSearch(deps, '(a+)+$', { isRegex: true })).rejects.toThrow(/is_regex/);
    await expect(fsSearch(deps, '(\\w+\\s*)+x', { isRegex: true })).rejects.toThrow(/backtracking/i);
  });

  it('regex lành vẫn chạy qua guard', async () => {
    const deps = makeDeps();
    const hits = await fsSearch(deps, 'console\\.', { isRegex: true });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('src/index.ts');
  });

  it('dòng dài quá trần bị bỏ qua khi search regex, dòng ngắn vẫn khớp', async () => {
    const longLine = 'x'.repeat(MAX_SEARCH_LINE_CHARS) + 'NEEDLE_LONG' + 'y'.repeat(50);
    const root = fakeDir('proj', [
      fakeFile('generated.ts', 'NEEDLE_SHORT here\n' + longLine + '\nNEEDLE_TAIL after\n'),
    ]);
    const deps: FsDeps = { root, writable: false };

    const hits = await fsSearch(deps, 'NEEDLE_[A-Z]+', { isRegex: true });
    // Đảo điều kiện: bỏ skip thì NEEDLE_LONG ở dòng 2 xuất hiện → test đỏ.
    expect(hits.map((h) => h.line)).toEqual([1, 3]);
    expect(hits.every((h) => !h.text.includes('NEEDLE_LONG'))).toBe(true);
  });

  it('tìm chuỗi thường KHÔNG bị skip dòng dài (includes là tuyến tính)', async () => {
    const longLine = 'x'.repeat(MAX_SEARCH_LINE_CHARS) + 'NEEDLE_LONG' + 'y'.repeat(50);
    const root = fakeDir('proj', [
      fakeFile('generated.ts', 'NEEDLE_SHORT here\n' + longLine + '\n'),
    ]);
    const deps: FsDeps = { root, writable: false };

    const hits = await fsSearch(deps, 'NEEDLE_LONG', { isRegex: false });
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });
});
