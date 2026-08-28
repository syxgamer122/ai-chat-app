/**
 * describeWorkspaceImage — luồng "agent xem ảnh trong workspace" qua /api/vision.
 *
 * Hợp đồng cứng: LUÔN resolve, lỗi nhét vào field `error` (model đọc được lý
 * do và báo user tử tế thay vì sập tool call). Không bao giờ trả bytes nhị
 * phân về cho model — chỉ description text.
 */

import { describe, expect, it } from 'vitest';
import { describeWorkspaceImage, isImagePath } from '@/lib/fs-vision';

const PNG_DATA_URL = 'data:image/png;base64,' + btoa('fakepng');

function okFetch(description: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true, description }), { status: 200 })) as typeof fetch;
}

describe('isImagePath', () => {
  it('nhận các đuôi ảnh vision', () => {
    for (const p of ['image.png', 'a/b/shot.jpeg', 'IMG.webp', 'x/photo.heic']) {
      expect(isImagePath(p)).toBe(true);
    }
  });
  it('từ chối đuôi khác kể cả khi tên chứa chữ ảnh', () => {
    for (const p of ['image.gif', 'image.png.txt', 'doc.pdf', 'a.txt']) {
      expect(isImagePath(p)).toBe(false);
    }
  });
});

describe('describeWorkspaceImage', () => {
  it('thành công → tool result có description, không có bytes', async () => {
    const r = await describeWorkspaceImage(
      'image.png',
      async () => ({ path: 'image.png', dataUrl: PNG_DATA_URL, size: 7 }),
      okFetch('Ảnh chụp màn hình form đăng nhập.'),
    );
    expect(r).toEqual({
      path: 'image.png',
      kind: 'image',
      size: 7,
      description: 'Ảnh chụp màn hình form đăng nhập.',
    });
    expect(JSON.stringify(r)).not.toContain('base64');
  });

  it('reader lỗi (file không tồn tại / quá lớn) → error field, không ném', async () => {
    const r = await describeWorkspaceImage(
      'nope.png',
      async () => {
        throw new Error('NotFoundError');
      },
      okFetch('không bao giờ gọi'),
    );
    expect(r.error).toContain('NotFoundError');
  });

  it('API trả ok:false → error từ server truyền thẳng', async () => {
    const res = new Response(JSON.stringify({ ok: false, error: 'Máy chủ chưa cấu hình GEMINI_API_KEY' }), {
      status: 503,
    });
    const r = await describeWorkspaceImage(
      'image.png',
      async () => ({ path: 'image.png', dataUrl: PNG_DATA_URL, size: 7 }),
      (async () => res) as typeof fetch,
    );
    expect(r.error).toContain('GEMINI_API_KEY');
    expect(r.description).toBeUndefined();
  });

  it('API trả JSON rác / network fail → error mạch lạc', async () => {
    const bad = await describeWorkspaceImage(
      'image.png',
      async () => ({ path: 'image.png', dataUrl: PNG_DATA_URL, size: 7 }),
      (async () => new Response('not json', { status: 200 })) as typeof fetch,
    );
    expect(bad.error).toBeTruthy();

    const net = await describeWorkspaceImage(
      'image.png',
      async () => ({ path: 'image.png', dataUrl: PNG_DATA_URL, size: 7 }),
      (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    );
    expect(net.error).toContain('connection refused');
  });
});
