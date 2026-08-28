/**
 * fs_read phải TỪ CHỐI file nhị phân.
 *
 * LỖI THẬT ĐÃ GẶP: người dùng báo app hiện
 *   ERROR: Cannot read "image.png" (this model does not support image input).
 * Chuỗi đó KHÔNG có trong mã nguồn — nó do model tự bịa ra sau khi nhận nội
 * dung rác. Nguyên nhân: agent gọi fs_read("image.png"), `file.text()` decode
 * PNG thành chuỗi đầy byte NUL và U+FFFD, rồi gửi thẳng cho model.
 *
 * Người dùng tưởng tính năng ảnh hỏng, nhưng thực chất là công cụ đọc file
 * nhị phân như thể nó là file text. BINARY_EXT_RE vốn chỉ được dùng ở
 * fs_search — fs_read hoàn toàn bỏ qua nó.
 */

import { describe, expect, it } from 'vitest';
import { fsRead } from '@/lib/fs-access';
import type { FsDeps, FsDirHandleLike } from '@/lib/fs-access';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe]);
const ELF_NO_EXT = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]);
const SOURCE = new TextEncoder().encode('export const a = 1;\nconst b = 2;\n');

function mkFile(name: string, bytes: Uint8Array) {
  return {
    kind: 'file' as const,
    name,
    async getFile() {
      return {
        size: bytes.length,
        async text() {
          return new TextDecoder().decode(bytes);
        },
      };
    },
  };
}

function fakeRoot(): FsDirHandleLike {
  const files = [
    mkFile('image.png', PNG_BYTES),
    mkFile('photo.JPEG', PNG_BYTES),
    mkFile('doc.pdf', PNG_BYTES),
    mkFile('binfile', ELF_NO_EXT),
    mkFile('app.ts', SOURCE),
  ];
  return {
    kind: 'directory',
    name: 'root',
    async *values() {
      for (const f of files) yield f as never;
    },
    async getDirectoryHandle() {
      throw new Error('NotFoundError');
    },
    async getFileHandle(n: string) {
      const f = files.find((x) => x.name === n);
      if (!f) throw new Error(`NotFoundError: ${n}`);
      return f as never;
    },
  } as unknown as FsDirHandleLike;
}

const deps: FsDeps = { root: fakeRoot(), writable: true };

describe('fs_read — chặn file nhị phân theo đuôi', () => {
  it.each(['image.png', 'photo.JPEG', 'doc.pdf'])('từ chối %s', async (name) => {
    await expect(fsRead(deps, name)).rejects.toThrow(/nhị phân/i);
  });

  it('thông báo hướng dẫn người dùng đính kèm ảnh vào chat', async () => {
    await expect(fsRead(deps, 'image.png')).rejects.toThrow(/đính kèm/i);
  });

  it('không phân biệt hoa thường ở phần đuôi', async () => {
    await expect(fsRead(deps, 'photo.JPEG')).rejects.toThrow(/nhị phân/i);
  });
});

describe('fs_read — lưới cuối cho file không có đuôi nhận diện được', () => {
  it('file chứa byte NUL bị từ chối', async () => {
    await expect(fsRead(deps, 'binfile')).rejects.toThrow(/byte NUL/i);
  });
});

describe('fs_read — file text KHÔNG bị ảnh hưởng', () => {
  it('đọc mã nguồn bình thường', async () => {
    const r = await fsRead(deps, 'app.ts');
    expect(r.content).toContain('export const a = 1;');
    expect(r.truncated).toBe(false);
  });

  it('phân trang theo dòng vẫn hoạt động', async () => {
    const r = await fsRead(deps, 'app.ts', { startLine: 2, lineCount: 1 });
    expect(r.content).toBe('const b = 2;');
    expect(r.startLine).toBe(2);
  });
});
