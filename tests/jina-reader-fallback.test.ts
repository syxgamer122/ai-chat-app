/**
 * Fallback đọc trang qua Jina Reader (r.jina.ai) — KHÔNG cần API key.
 *
 * Vì sao cần: trang SPA/JS-heavy chỉ có `<div id="root"></div>` trong HTML
 * thô, bộ trích theo regex trả rỗng và lượt đọc chết với WEB_EMPTY_CONTENT.
 * Kiểm chứng thực tế: react.dev trước đây rỗng, qua Reader lấy được ~7.9KB.
 *
 * Lưu ý: `s.jina.ai` (search) CẦN key (đo được 401) nên KHÔNG dùng; chỉ
 * endpoint đọc trang `r.jina.ai` là miễn phí.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchReadablePage } from '@/lib/web-backend';

const SPA_HTML = '<html><head><title>App</title></head><body><div id="root"></div></body></html>';
const STATIC_HTML =
  '<html><head><title>Tĩnh</title></head><body><article><p>Nội dung thật ở đây, đủ dài để trích.</p></article></body></html>';

const JINA_RESPONSE =
  'Title: Trang SPA\n\nURL Source: https://spa.example/\n\nMarkdown Content:\n' +
  '## Tiêu đề\n\nNội dung đã render bởi Reader.';

function htmlRes(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
function textRes(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchReadablePage — fallback Jina Reader', () => {
  it('trang SPA rỗng → dùng Reader và lấy được nội dung', async () => {
    const spy = vi.fn(async (url: string) =>
      String(url).startsWith('https://r.jina.ai/') ? textRes(JINA_RESPONSE) : htmlRes(SPA_HTML),
    );
    vi.stubGlobal('fetch', spy);

    const page = await fetchReadablePage('https://spa.example/');
    expect(page.title).toBe('Trang SPA');
    expect(page.content).toContain('Nội dung đã render');
    // Phần header của Reader không được lẫn vào nội dung.
    expect(page.content).not.toContain('URL Source:');
    expect(page.content).not.toContain('Markdown Content:');
  });

  it('trang tĩnh bình thường KHÔNG gọi Reader (đường chính vẫn nhanh)', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return htmlRes(STATIC_HTML);
      }),
    );

    const page = await fetchReadablePage('https://static.example/');
    expect(page.content).toContain('Nội dung thật');
    expect(urls.every((u) => !u.includes('r.jina.ai'))).toBe(true);
  });

  it('Reader cũng hỏng → giữ nguyên lỗi gốc WEB_EMPTY_CONTENT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith('https://r.jina.ai/') ? textRes('', 503) : htmlRes(SPA_HTML),
      ),
    );
    await expect(fetchReadablePage('https://spa.example/')).rejects.toMatchObject({
      code: 'WEB_EMPTY_CONTENT',
    });
  });

  it('Reader ném lỗi mạng → không làm vỡ lượt, vẫn báo lỗi gốc', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).startsWith('https://r.jina.ai/')) throw new Error('network down');
        return htmlRes(SPA_HTML);
      }),
    );
    await expect(fetchReadablePage('https://spa.example/')).rejects.toMatchObject({
      code: 'WEB_EMPTY_CONTENT',
    });
  });

  it('Reader trả rỗng sau header → coi như thất bại', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).startsWith('https://r.jina.ai/')
          ? textRes('Title: X\n\nMarkdown Content:\n   ')
          : htmlRes(SPA_HTML),
      ),
    );
    await expect(fetchReadablePage('https://spa.example/')).rejects.toMatchObject({
      code: 'WEB_EMPTY_CONTENT',
    });
  });
});
