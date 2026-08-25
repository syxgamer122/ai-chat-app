import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebOpError, capHits, fetchReadablePage, searchWeb } from '@/lib/web-backend';

const DDG_LITE_HTML =
  '<table><tr><td><a class="result-link" href="https://example.com/a">Kết quả A</a></td>' +
  '<td class="result-snippet">mô tả A</td></tr></table>';
const DDG_HTML_EMPTY = '<html><body>no results</body></html>';

function htmlRes(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('searchWeb', () => {
  it('engine lite sống → trả hits từ lite', async () => {
    const spy = vi.fn(async (_url: string) => htmlRes(DDG_LITE_HTML));
    vi.stubGlobal('fetch', spy);
    const r = await searchWeb('test');
    expect(r.engine).toBe('ddg-lite');
    expect(r.hits[0].title).toBe('Kết quả A');
    expect(spy.mock.calls[0][0]).toContain('lite.duckduckgo.com');
  });

  it('lite rỗng (bot-challenge) → rơi sang html endpoint', async () => {
    const spy = vi.fn(async (url: string) =>
      String(url).includes('lite.') ? htmlRes(DDG_HTML_EMPTY) : htmlRes(DDG_LITE_HTML),
    );
    vi.stubGlobal('fetch', spy);
    const r = await searchWeb('test');
    expect(r.engine).toBe('ddg-html');
  });

  it('cả hai hỏng → WebOpError SEARCH_UNAVAILABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlRes('<html>blocked</html>')),
    );
    await expect(searchWeb('x')).rejects.toMatchObject({
      code: 'SEARCH_UNAVAILABLE',
      status: 502,
    });
  });
});

describe('capHits', () => {
  it('cắt trần title/url/snippet và số lượng', () => {
    const out = capHits(
      [{ title: 't'.repeat(400), url: 'https://x.com/' + 'a'.repeat(3000), snippet: 's'.repeat(900) }],
      1,
    );
    expect(out).toHaveLength(1);
    // capText cắt tại 200 rồi thêm ' …' → cho phép lố nhẹ
    expect(out[0].title.length).toBeLessThanOrEqual(203);
    expect(out[0].url.length).toBeLessThanOrEqual(2048);
    expect(out[0].snippet.length).toBeLessThanOrEqual(503);
  });
});

describe('fetchReadablePage', () => {
  it('HTML hợp lệ → trích title + text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        htmlRes('<html><head><title>Trang thử</title></head><main><p>Nội dung chính đáng giá.</p></main></html>'),
      ),
    );
    const page = await fetchReadablePage('https://example.com/x');
    expect(page.title).toBe('Trang thử');
    expect(page.content).toContain('Nội dung chính');
    expect(page.truncated).toBe(false);
  });

  it('content-type không đọc được → 415 WEB_UNSUPPORTED_CONTENT_TYPE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('binary', { status: 200, headers: { 'content-type': 'image/png' } })),
    );
    await expect(fetchReadablePage('https://example.com/img.png')).rejects.toMatchObject({
      status: 415,
      code: 'WEB_UNSUPPORTED_CONTENT_TYPE',
    });
  });

  it('URL private/SSRF bị chặn trước khi fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(fetchReadablePage('http://127.0.0.1:8080/admin')).rejects.toBeInstanceOf(WebOpError);
    expect(spy).not.toHaveBeenCalled();
  });
});
