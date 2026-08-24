import { describe, expect, it, vi } from 'vitest';
import { MediaGenerationError, generateMedia } from '@/lib/media-generate';

const BASE = 'https://gpt.crax.lol/v1';

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(`data: ${l}\n\n`));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

const baseReq = {
  baseUrl: BASE,
  apiKey: 'sk-test',
  model: 'qwen-image-3.0-pro',
  prompt: 'một con mèo',
} as const;

describe('generateMedia — ảnh', () => {
  it('trả về markdown ảnh từ data[0].url', async () => {
    const fetchMock = mockFetch(async () =>
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/a.png' }] }), {
        status: 200,
      }),
    );

    const res = await generateMedia({ ...baseReq, kind: 'image' });

    expect(res.url).toBe('https://cdn.example/a.png');
    expect(res.markdown).toBe('![qwen-image-3.0-pro](https://cdn.example/a.png)');
    // Gọi đúng endpoint images, kèm Bearer key.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/images/generations`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('chấp nhận b64_json khi gateway không trả URL', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'AAAB' }] }), { status: 200 }),
    );

    const res = await generateMedia({ ...baseReq, kind: 'image' });
    expect(res.url).toBe('data:image/png;base64,AAAB');
  });

  it('báo lỗi rõ ràng khi key sai', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }),
    );

    await expect(generateMedia({ ...baseReq, kind: 'image' })).rejects.toThrow(
      /invalid key[\s\S]*API key/,
    );
  });

  it('không lộ HTML thô khi gateway trả trang lỗi', async () => {
    mockFetch(async () => new Response('<!DOCTYPE html><html>502</html>', { status: 502 }));

    await expect(generateMedia({ ...baseReq, kind: 'image' })).rejects.toThrow(/quá tải/);
  });

  it('đánh dấu originBlocked khi gateway chặn tên miền (403 Origin not allowed)', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ error: { message: 'Origin not allowed', code: 403 } }),
        { status: 403 },
      ),
    );

    await expect(generateMedia({ ...baseReq, kind: 'image' })).rejects.toMatchObject({
      originBlocked: true,
      status: 403,
    });
  });

  it('403 vì key sai thì KHÔNG đánh dấu originBlocked', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { message: 'Access denied' } }), { status: 403 }),
    );

    await expect(generateMedia({ ...baseReq, kind: 'image' })).rejects.toMatchObject({
      originBlocked: false,
    });
  });

  it('CORS bị trình duyệt chặn (TypeError) cũng coi là originBlocked', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(generateMedia({ ...baseReq, kind: 'image' })).rejects.toMatchObject({
      originBlocked: true,
    });
  });

  it('người dùng bấm Dừng thì giữ nguyên lỗi abort, không coi là originBlocked', async () => {
    const controller = new AbortController();
    mockFetch(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });

    await expect(
      generateMedia({ ...baseReq, kind: 'image', signal: controller.signal }),
    ).rejects.toSatisfy((e: unknown) => (e as Error).name === 'AbortError');
  });
});

describe('generateMedia — video', () => {
  const videoReq = { ...baseReq, model: 'qwen-video', kind: 'video' } as const;

  it('đọc tiến trình rồi trả link video', async () => {
    mockFetch(async () =>
      sseResponse([
        JSON.stringify({ type: 'status', text: 'Generating your video... (34%)' }),
        JSON.stringify({ type: 'status', text: 'Generating your video... (88%)' }),
        JSON.stringify({ type: 'video', url: 'https://cdn.example/v.mp4?key=abc' }),
      ]),
    );

    const progress: string[] = [];
    const res = await generateMedia({ ...videoReq, onProgress: (t) => progress.push(t) });

    expect(res.url).toBe('https://cdn.example/v.mp4?key=abc');
    // Link markdown tường minh: URL có query dài, autolink GFM không đáng tin.
    expect(res.markdown).toBe('[qwen-video](https://cdn.example/v.mp4?key=abc)');
    expect(progress).toContain('Generating your video... (34%)');
    expect(progress).toContain('Generating your video... (88%)');
  });

  it('vẫn lấy được video khi link nằm trong text delta', async () => {
    mockFetch(async () =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Xong: https://cdn.example/x.mp4' } }] }),
      ]),
    );

    const res = await generateMedia(videoReq);
    expect(res.url).toBe('https://cdn.example/x.mp4');
  });

  it('nêu phản hồi của gateway khi không có video nào', async () => {
    mockFetch(async () =>
      sseResponse([JSON.stringify({ choices: [{ delta: { content: 'Tôi không thể.' } }] })]),
    );

    await expect(generateMedia(videoReq)).rejects.toThrow(/Tôi không thể/);
  });
});

describe('generateMedia — kiểm tra đầu vào', () => {
  it('đòi API key phía trình duyệt', async () => {
    await expect(generateMedia({ ...baseReq, apiKey: '', kind: 'image' })).rejects.toBeInstanceOf(
      MediaGenerationError,
    );
  });

  it('đòi prompt không rỗng', async () => {
    await expect(generateMedia({ ...baseReq, prompt: '   ', kind: 'image' })).rejects.toThrow(
      /mô tả/,
    );
  });

  it('chặn baseUrl http để tránh mixed content', async () => {
    await expect(
      generateMedia({ ...baseReq, baseUrl: 'http://gpt.crax.lol/v1', kind: 'image' }),
    ).rejects.toThrow(/https/);
  });

  it('cho phép http://localhost khi dev', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/a.png' }] }), {
        status: 200,
      }),
    );

    await expect(
      generateMedia({ ...baseReq, baseUrl: 'http://localhost:8080/v1', kind: 'image' }),
    ).resolves.toMatchObject({ kind: 'image' });
  });

  /**
   * Đường media gọi thẳng từ trình duyệt nên phải dùng CÙNG chính sách baseUrl
   * với server (`validateProviderBaseUrl`). Trước khi vá, các host dưới đây bị
   * /api/chat từ chối nhưng vẫn được browser gọi kèm `Bearer <key>` — SSRF vào
   * LAN của người dùng và rò key ra host tuỳ ý.
   */
  describe('chặn baseUrl trỏ vào mạng nội bộ (SSRF từ trình duyệt)', () => {
    const privateBases = [
      'https://10.0.0.5/v1',
      'https://192.168.1.1/v1',
      'https://172.16.0.9/v1',
      'https://127.0.0.1/v1',
      'https://nas.local/v1',
      'https://localhost/v1',
    ];

    for (const baseUrl of privateBases) {
      it(`từ chối ${baseUrl} và không gửi request nào`, async () => {
        const fetchMock = mockFetch(async () => new Response('{}', { status: 200 }));

        await expect(
          generateMedia({ ...baseReq, baseUrl, kind: 'image' }),
        ).rejects.toBeInstanceOf(MediaGenerationError);
        // Quan trọng: key không được rời khỏi trình duyệt.
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }

    it('từ chối baseUrl dài quá mức', async () => {
      const fetchMock = mockFetch(async () => new Response('{}', { status: 200 }));

      await expect(
        generateMedia({ ...baseReq, baseUrl: `https://a.example/${'x'.repeat(320)}`, kind: 'image' }),
      ).rejects.toBeInstanceOf(MediaGenerationError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
