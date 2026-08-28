/**
 * fsReadImage — đọc ảnh workspace thành data URL cho luồng vision.
 *
 * Bổ sung cho guard fs_readbinary: thay vì CHỈ từ chối file nhị phân, agent
 * giờ xem được ảnh qua Gemini (mô tả text). Test chặn các đường sai trước khi
 * bytes ảnh kịp rời khỏi client: sai đuôi, quá trần, và tính đúng đắn của
 * data URL (mime + base64 giải mã ngược ra đúng bytes gốc).
 */

import { describe, expect, it } from 'vitest';
import { fsReadImage, IMAGE_VISION_MAX_BYTES } from '@/lib/fs-access';
import type { FsDeps, FsDirHandleLike } from '@/lib/fs-access';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
const TEXT_BYTES = new TextEncoder().encode('hello');

function mkFile(name: string, bytes: Uint8Array, sizeOverride?: number) {
  return {
    kind: 'file' as const,
    name,
    async getFile() {
      return {
        size: sizeOverride ?? bytes.length,
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
        async text() {
          return new TextDecoder().decode(bytes);
        },
      };
    },
  };
}

function fakeRoot(files: ReturnType<typeof mkFile>[]): FsDirHandleLike {
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

describe('fsReadImage — đọc đúng bytes', () => {
  it('png → data URL image/png, base64 giải mã ra đúng bytes gốc', async () => {
    const deps: FsDeps = { root: fakeRoot([mkFile('shot.png', PNG_BYTES)]), writable: true };
    const r = await fsReadImage(deps, 'shot.png');
    expect(r.mimeType).toBe('image/png');
    expect(r.size).toBe(PNG_BYTES.length);
    expect(r.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    const decoded = Uint8Array.from(atob(r.dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(PNG_BYTES));
  });

  it('jpeg viết hoa đuôi vẫn nhận (mime image/jpeg)', async () => {
    const deps: FsDeps = { root: fakeRoot([mkFile('photo.JPG', PNG_BYTES)]), writable: true };
    const r = await fsReadImage(deps, 'photo.JPG');
    expect(r.mimeType).toBe('image/jpeg');
  });

  it('path lồng thư mục + ./ phía trước vẫn chuẩn hóa', async () => {
    const dir = {
      kind: 'directory' as const,
      name: 'assets',
      async getFileHandle(n: string) {
        return mkFile(n, PNG_BYTES) as never;
      },
      async *values() {},
      async getDirectoryHandle() {
        throw new Error('NotFoundError');
      },
    };
    const deps: FsDeps = { root: { ...fakeRoot([]), getDirectoryHandle: async () => dir } as unknown as FsDirHandleLike, writable: true };
    const r = await fsReadImage(deps, './assets/img.webp');
    expect(r.path).toBe('assets/img.webp');
    expect(r.mimeType).toBe('image/webp');
  });
});

describe('fsReadImage — từ chối an toàn', () => {
  it('đuôi không phải ảnh (gif/avif/pdf/txt) bị từ chối', async () => {
    const deps: FsDeps = {
      root: fakeRoot([
        mkFile('anim.gif', PNG_BYTES),
        mkFile('pic.avif', PNG_BYTES),
        mkFile('doc.pdf', PNG_BYTES),
        mkFile('a.txt', TEXT_BYTES),
      ]),
      writable: true,
    };
    for (const p of ['anim.gif', 'pic.avif', 'doc.pdf', 'a.txt']) {
      await expect(fsReadImage(deps, p)).rejects.toThrow(/định dạng ảnh/i);
    }
  });

  it('ảnh vượt trần bytes bị từ chối', async () => {
    const deps: FsDeps = {
      root: fakeRoot([mkFile('big.png', PNG_BYTES, IMAGE_VISION_MAX_BYTES + 1)]),
      writable: true,
    };
    await expect(fsReadImage(deps, 'big.png')).rejects.toThrow(/quá lớn/i);
  });

  it('path traversal bị chặn', async () => {
    const deps: FsDeps = { root: fakeRoot([]), writable: true };
    await expect(fsReadImage(deps, '../../etc/passwd.png')).rejects.toThrow(/không hợp lệ/i);
  });
});
