/**
 * Path guard của Vyen desktop (electron/path-guard.cjs) — CJS thuần nên
 * test qua createRequire thay vì import ESM.
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveWithin, isWithinRoot } = require('../electron/path-guard.cjs') as {
  resolveWithin: (root: string, rel: string) => string;
  isWithinRoot: (root: string, target: string) => boolean;
};

const isWin = process.platform === 'win32';
const root = path.resolve(os.tmpdir(), 'vyen-guard-test-root');

function expectWithin(rel: string, expectedSuffix: string): void {
  const got = resolveWithin(root, rel);
  const expected = path.resolve(root, expectedSuffix);
  expect(got).toBe(expected);
}

describe('resolveWithin — đường dẫn hợp lệ', () => {
  it('cho phép "" và "." (chính root)', () => {
    expect(resolveWithin(root, '')).toBe(path.resolve(root));
    expect(resolveWithin(root, '.')).toBe(path.resolve(root));
  });

  it('cho phép đường dẫn tương đối thường + lồng sâu', () => {
    expectWithin('a.txt', 'a.txt');
    expectWithin('src/lib/x.ts', 'src/lib/x.ts');
    if (isWin) expectWithin('src\\lib\\x.ts', 'src/lib/x.ts');
  });

  it('cho phép đi xuống rồi lên lại trong root', () => {
    expectWithin('src/../a.txt', 'a.txt');
  });
});

describe('resolveWithin — chặn thoát khỏi workspace', () => {
  it('chặn .. thoát root', () => {
    expect(() => resolveWithin(root, '..')).toThrow(/thoát khỏi workspace/);
    expect(() => resolveWithin(root, '../outside.txt')).toThrow(/thoát khỏi workspace/);
    expect(() => resolveWithin(root, 'a/../../outside.txt')).toThrow(/thoát khỏi workspace/);
  });

  it('chặn đường dẫn tuyệt đối', () => {
    expect(() => resolveWithin(root, isWin ? 'C:\\Windows\\system32' : '/etc/passwd')).toThrow(
      /tuyệt đối/,
    );
  });

  it('chặn drive-letter tương đối (Windows: "C:foo")', () => {
    if (!isWin) return;
    expect(() => resolveWithin(root, 'C:foo')).toThrow(/tuyệt đối/);
  });

  it('chặn UNC / double-slash', () => {
    if (isWin) {
      expect(() => resolveWithin(root, '\\\\server\\share')).toThrow(/tuyệt đối/);
    } else {
      expect(() => resolveWithin(root, '//server/share')).toThrow(/tuyệt đối/);
    }
  });

  it('chặn NUL và đường dài', () => {
    expect(() => resolveWithin(root, 'a\0b')).toThrow(/NUL/);
    expect(() => resolveWithin(root, 'a'.repeat(2000))).toThrow(/quá dài/);
  });

  it('chặn root không hợp lệ', () => {
    expect(() => resolveWithin('', 'a.txt')).toThrow(/root/);
  });
});

describe('isWithinRoot', () => {
  it('so khớp prefix đúng cách (không nhầm "root2" là con của "root")', () => {
    const r = isWin ? 'C:\\ws' : '/ws';
    expect(isWithinRoot(r, isWin ? 'C:\\ws\\a.txt' : '/ws/a.txt')).toBe(true);
    expect(isWithinRoot(r, isWin ? 'C:\\ws2\\a.txt' : '/ws2/a.txt')).toBe(false);
  });

  it('case-insensitive trên Windows', () => {
    if (!isWin) return;
    expect(isWithinRoot('C:\\WS', 'c:\\ws\\a.txt')).toBe(true);
  });
});
