import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WebOpError,
  archiveFallbackUrl,
  capHits,
  fetchReadablePage,
  searchWeb,
  shouldTryArchive,
  __clearSearchCache,
} from '@/lib/web-backend';

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

/* Cache search sống giữa các ca test — không dọn thì ca sau nhận kết quả của
   ca trước và mọi assertion về engine trở nên vô nghĩa. */
beforeEach(() => __clearSearchCache());
afterEach(() => {
  vi.unstubAllGlobals();
  __clearSearchCache();
});

describe('searchWeb', () => {
  /* Thứ tự engine ĐÃ ĐỔI: html chạy trước lite. Dạng URL `html?q=…&kp=1`
     (port từ Firecrawl) đo được 200 + kết quả, trong khi dạng cũ nhận 202. */
  it('engine html sống → trả hits từ html', async () => {
    const spy = vi.fn(async (_url: string) => htmlRes(DDG_LITE_HTML));
    vi.stubGlobal('fetch', spy);
    const r = await searchWeb('test');
    expect(r.engine).toBe('ddg-html');
    expect(r.hits[0].title).toBe('Kết quả A');
    expect(spy.mock.calls[0][0]).toContain('html.duckduckgo.com');
  });

  it('html rỗng → rơi sang lite endpoint', async () => {
    const spy = vi.fn(async (url: string) =>
      String(url).includes('html.') ? htmlRes(DDG_HTML_EMPTY) : htmlRes(DDG_LITE_HTML),
    );
    vi.stubGlobal('fetch', spy);
    const r = await searchWeb('test');
    expect(r.engine).toBe('ddg-lite');
  });

  it('HTTP 202 = bị chặn, KHÔNG phải "không có kết quả"', async () => {
    // Đây là phản hồi thật của DDG khi IP bị gắn cờ: 202 + trang rỗng.
    vi.stubGlobal('fetch', vi.fn(async () => htmlRes('<html></html>', 202)));
    await expect(searchWeb('x')).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
  });

  it('trang anomaly-modal của DDG được nhận là bị chặn', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlRes('<div class="anomaly-modal__modal">bot?</div>')),
    );
    await expect(searchWeb('x')).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
  });

  it('kết quả được cache — truy vấn lặp không gọi lại engine', async () => {
    const spy = vi.fn(async (_url: string) => htmlRes(DDG_LITE_HTML));
    vi.stubGlobal('fetch', spy);
    await searchWeb('lặp lại');
    const callsAfterFirst = spy.mock.calls.length;
    await searchWeb('lặp lại');
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
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

describe('archive fallback (cứu link chết 404/410)', () => {
  it('helper lỗi: chỉ WebOpError + WEB_UPSTREAM_STATUS + upstream 404/410', () => {
    expect(shouldTryArchive(new WebOpError('x', 502, 'WEB_UPSTREAM_STATUS', 404))).toBe(true);
    expect(shouldTryArchive(new WebOpError('x', 502, 'WEB_UPSTREAM_STATUS', 410))).toBe(true);
    expect(shouldTryArchive(new WebOpError('x', 502, 'WEB_UPSTREAM_STATUS', 403))).toBe(false);
    expect(shouldTryArchive(new WebOpError('x', 502, 'WEB_UPSTREAM_STATUS', 500))).toBe(false);
    expect(shouldTryArchive(new WebOpError('x', 502, 'WEB_UPSTREAM_STATUS'))).toBe(false);
    expect(shouldTryArchive(new WebOpError('x', 400, 'WEB_URL_BLOCKED', 404))).toBe(false);
    expect(shouldTryArchive(new Error('lỗi thường'))).toBe(false);
  });

  it('helper URL: http(s) → wayback; đã là archive / phi-http / rác → null', () => {
    expect(archiveFallbackUrl('https://example.com/a')).toBe(
      'https://web.archive.org/web/2/https://example.com/a',
    );
    expect(archiveFallbackUrl('http://example.com')).toBe(
      'https://web.archive.org/web/2/http://example.com',
    );
    expect(archiveFallbackUrl('https://web.archive.org/web/2/https://example.com')).toBeNull();
    expect(archiveFallbackUrl('ftp://example.com')).toBeNull();
    expect(archiveFallbackUrl('không phải url')).toBeNull();
  });

  it('404 gốc → thử archive đúng MỘT lần, thành công → note + giữ url gốc', async () => {
    const spy = vi.fn(async (url: string) => {
      if (String(url).startsWith('https://example.com/chet')) return htmlRes('<html></html>', 404);
      return htmlRes('<html><body><p>Nội dung lưu trữ</p></body></html>');
    });
    vi.stubGlobal('fetch', spy);
    const page = await fetchReadablePage('https://example.com/chet');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(String(spy.mock.calls[1][0])).toContain('web.archive.org');
    expect(page.url).toBe('https://example.com/chet');
    expect(page.content).toContain('[Nội dung từ Internet Archive');
    expect(page.content).toContain('Nội dung lưu trữ');
  });

  it('archive cũng chết → ném lại lỗi GỐC (upstream 404), không phải lỗi archive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlRes('<html></html>', 404)));
    await expect(fetchReadablePage('https://example.com/chet')).rejects.toMatchObject({
      code: 'WEB_UPSTREAM_STATUS',
      upstreamStatus: 404,
    });
  });

  it('trang 403/500 hoặc trang sống → KHÔNG đụng archive', async () => {
    const spy403 = vi.fn(async () => htmlRes('<html></html>', 403));
    vi.stubGlobal('fetch', spy403);
    await expect(fetchReadablePage('https://example.com/x')).rejects.toBeTruthy();
    expect(spy403).toHaveBeenCalledTimes(1);

    const spy500 = vi.fn(async () => htmlRes('<html></html>', 500));
    vi.stubGlobal('fetch', spy500);
    await expect(fetchReadablePage('https://example.com/x')).rejects.toBeTruthy();
    expect(spy500).toHaveBeenCalledTimes(1);

    const spyOk = vi.fn(async () => htmlRes('<html><body><p>Trang sống</p></body></html>'));
    vi.stubGlobal('fetch', spyOk);
    await fetchReadablePage('https://example.com/song');
    expect(spyOk).toHaveBeenCalledTimes(1);
  });
});
