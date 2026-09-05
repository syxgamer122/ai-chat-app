/**
 * describeWorkspaceImage / describeMcpImage — luồng "agent xem ảnh" qua
 * /api/vision với provider active BYOK (headers + model do opts truyền xuống).
 *
 * Hợp đồng cứng: LUÔN resolve (describeWorkspaceImage), lỗi nhét vào field
 * `error` (model đọc được lý do và báo user tử tế thay vì sập tool call).
 * Không bao giờ trả bytes nhị phân về cho model — chỉ description text.
 */

import { describe, expect, it } from 'vitest';
import {
  describeWorkspaceImage,
  describeMcpImage,
  isImagePath,
  type VisionCallOpts,
} from '@/lib/fs-vision';

const PNG_DATA_URL = 'data:image/png;base64,' + btoa('fakepng');

function okFetch(description: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true, description }), { status: 200 })) as typeof fetch;
}

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** fetch mock ghi lại request để assert headers/body lượt gọi /api/vision. */
function captureFetch(
  respond: () => Response,
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  return {
    calls,
    fetch: (async (url: any, init: any) => {
      calls.push({
        url: String(url),
        headers: init?.headers ?? {},
        body: JSON.parse(init?.body),
      });
      return respond();
    }) as unknown as typeof fetch,
  };
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
    const res = new Response(
      JSON.stringify({ ok: false, error: 'Chưa cấu hình Nhà cung cấp (provider) — hãy vào Cài đặt.' }),
      { status: 503 },
    );
    const r = await describeWorkspaceImage(
      'image.png',
      async () => ({ path: 'image.png', dataUrl: PNG_DATA_URL, size: 7 }),
      (async () => res) as typeof fetch,
    );
    expect(r.error).toContain('Nhà cung cấp');
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

  it('opts.headers + opts.model gắn vào request /api/vision', async () => {
    const { fetch, calls } = captureFetch(() =>
      new Response(JSON.stringify({ ok: true, description: 'desc qua provider' }), { status: 200 }),
    );
    const opts: VisionCallOpts = {
      headers: { 'x-api-key': 'sk-byok', 'x-api-base': 'https://p.example/v1' },
      model: 'vm-1',
    };
    const r = await describeWorkspaceImage(
      'image.png',
      async () => ({ path: 'image.png', dataUrl: PNG_DATA_URL, size: 7 }),
      fetch,
      opts,
    );
    expect(r.description).toBe('desc qua provider');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/vision');
    // Headers BYOK merge với Content-Type, không đè mất nhau.
    expect(calls[0].headers).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'sk-byok',
      'x-api-base': 'https://p.example/v1',
    });
    expect(calls[0].body).toEqual({ dataUrl: PNG_DATA_URL, model: 'vm-1' });
  });

  it('không có opts → body chỉ gồm dataUrl (backward-compatible)', async () => {
    const { fetch, calls } = captureFetch(() =>
      new Response(JSON.stringify({ ok: true, description: 'd' }), { status: 200 }),
    );
    await describeWorkspaceImage(
      'image.png',
      async () => ({ path: 'image.png', dataUrl: PNG_DATA_URL, size: 7 }),
      fetch,
    );
    expect(calls[0].body).toEqual({ dataUrl: PNG_DATA_URL });
    expect(calls[0].headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('describeMcpImage', () => {
  it('thành công → trả chuỗi description', async () => {
    const d = await describeMcpImage(PNG_DATA_URL, okFetch('ảnh MCP'));
    expect(d).toBe('ảnh MCP');
  });

  it('ok:false → throw lỗi mang message server (caller tự hóa thành khối text)', async () => {
    const res = new Response(
      JSON.stringify({ ok: false, error: 'Thiếu model vision — hãy chọn model hỗ trợ xem ảnh.' }),
      { status: 400 },
    );
    await expect(
      describeMcpImage(PNG_DATA_URL, (async () => res) as typeof fetch),
    ).rejects.toThrow('Thiếu model vision');
  });

  it('truyền opts xuyên xuống body/headers', async () => {
    const { fetch, calls } = captureFetch(() =>
      new Response(JSON.stringify({ ok: true, description: 'ok' }), { status: 200 }),
    );
    const opts: VisionCallOpts = { headers: { 'x-api-key': 'sk-2' }, model: 'vm-2' };
    await describeMcpImage(PNG_DATA_URL, fetch, opts);
    expect(calls[0].headers['x-api-key']).toBe('sk-2');
    expect(calls[0].body).toEqual({ dataUrl: PNG_DATA_URL, model: 'vm-2' });
  });
});
