/**
 * TinyFish Search + Fetch — engine ưu tiên vì MIỄN PHÍ ở mọi mức ví.
 *
 * Vì sao đặt trước Brave/Tavily: hai cái đó đốt quota trả phí ($5–8 / 1.000
 * lượt) còn TinyFish không tính tiền Search/Fetch. Nhưng free cũng nghĩa là
 * KHÔNG SLA, nên các ca dưới đây khẳng định chuỗi fallback cũ vẫn nguyên vẹn
 * khi TinyFish hỏng — nó là engine ưu tiên, không phải engine duy nhất.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchReadablePage,
  parseTinyfishFetchJson,
  parseTinyfishSearchJson,
  searchWeb,
  __clearSearchCache,
} from '@/lib/web-backend';

const TF_SEARCH_OK = JSON.stringify({
  query: 'test',
  results: [
    {
      position: 1,
      site_name: 'tinyfish.ai',
      title: 'Kết quả TinyFish',
      snippet: 'đoạn mô tả',
      url: 'https://tinyfish.ai/',
    },
  ],
  total_results: 1,
  page: 0,
});

const TF_FETCH_OK = JSON.stringify({
  results: [
    {
      url: 'https://spa.example/',
      final_url: 'https://spa.example/',
      title: 'Trang SPA',
      format: 'markdown',
      text: '# Tiêu đề\n\nNội dung do TinyFish render.',
    },
  ],
  errors: [],
});

const DDG_LITE_HTML =
  '<table><tr><td><a class="result-link" href="https://example.com/a">Kết quả DDG</a></td>' +
  '<td class="result-snippet">mô tả</td></tr></table>';
const SPA_HTML = '<html><head><title>App</title></head><body><div id="root"></div></body></html>';

function htmlRes(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
function jsonRes(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}
function textRes(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

const ORIGINAL_KEY = process.env.TINYFISH_API_KEY;

beforeEach(() => {
  __clearSearchCache();
  process.env.TINYFISH_API_KEY = 'tf-test-key';
});
afterEach(() => {
  vi.unstubAllGlobals();
  __clearSearchCache();
  if (ORIGINAL_KEY === undefined) delete process.env.TINYFISH_API_KEY;
  else process.env.TINYFISH_API_KEY = ORIGINAL_KEY;
});

/* ------------------------------------------------------------------ */
/* Parser thuần                                                        */
/* ------------------------------------------------------------------ */

describe('parseTinyfishSearchJson', () => {
  it('map results[] → hits{title,url,snippet}', () => {
    const hits = parseTinyfishSearchJson(TF_SEARCH_OK);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      title: 'Kết quả TinyFish',
      url: 'https://tinyfish.ai/',
      snippet: 'đoạn mô tả',
    });
  });

  it('bỏ mục thiếu title hoặc URL không phải http(s)', () => {
    const hits = parseTinyfishSearchJson(
      JSON.stringify({
        results: [
          { title: '', url: 'https://a.com', snippet: 's' },
          { title: 'có title', url: 'javascript:alert(1)', snippet: 's' },
          { title: 'ok', url: 'https://b.com', snippet: 's' },
        ],
      }),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://b.com');
  });

  it('JSON rác / payload lạ → [] (coi như engine hỏng, không ném)', () => {
    expect(parseTinyfishSearchJson('không phải json')).toEqual([]);
    expect(parseTinyfishSearchJson('{}')).toEqual([]);
    expect(parseTinyfishSearchJson(JSON.stringify({ results: 'sai kiểu' }))).toEqual([]);
  });
});

describe('parseTinyfishFetchJson', () => {
  it('lấy title + text của kết quả đầu', () => {
    const out = parseTinyfishFetchJson(TF_FETCH_OK)!;
    expect(out.title).toBe('Trang SPA');
    expect(out.content).toContain('TinyFish render');
  });

  it('results rỗng kèm errors[] → null (HTTP 200 nhưng thất bại thật)', () => {
    /* Lỗi từng URL nằm trong errors[] cùng status 200 — nếu chỉ tin res.ok
       thì sẽ coi đây là thành công và trả nội dung rỗng cho model. */
    const out = parseTinyfishFetchJson(
      JSON.stringify({ results: [], errors: [{ url: 'https://x', error: 'timeout' }] }),
    );
    expect(out).toBeNull();
  });

  it('text rỗng/không phải string → null', () => {
    expect(parseTinyfishFetchJson(JSON.stringify({ results: [{ text: '   ' }] }))).toBeNull();
    expect(
      parseTinyfishFetchJson(JSON.stringify({ results: [{ text: { type: 'document' } }] })),
    ).toBeNull();
  });

  it('JSON rác → null', () => {
    expect(parseTinyfishFetchJson('<html>lỗi</html>')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Vị trí trong chuỗi engine                                           */
/* ------------------------------------------------------------------ */

describe('searchWeb — TinyFish đứng trước các engine trả phí', () => {
  it('có key → dùng TinyFish, KHÔNG chạm DDG/Yahoo', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return jsonRes(TF_SEARCH_OK);
      }),
    );

    const r = await searchWeb('truy vấn thật');
    expect(r.engine).toBe('tinyfish');
    expect(r.hits[0].title).toBe('Kết quả TinyFish');
    expect(urls[0]).toContain('api.search.tinyfish.ai');
    expect(urls.some((u) => u.includes('duckduckgo.com'))).toBe(false);
  });

  it('gửi key qua header X-API-Key (không phải query string)', async () => {
    let seenHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        return jsonRes(TF_SEARCH_OK);
      }),
    );

    await searchWeb('kiểm tra header');
    expect(seenHeaders['X-API-Key']).toBe('tf-test-key');
  });

  it('KHÔNG có key → bỏ qua hẳn TinyFish, chuỗi cũ chạy như trước', async () => {
    delete process.env.TINYFISH_API_KEY;
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return htmlRes(DDG_LITE_HTML);
      }),
    );

    const r = await searchWeb('không key');
    expect(r.engine).toBe('ddg-html');
    expect(urls.some((u) => u.includes('tinyfish'))).toBe(false);
  });

  it('TinyFish trả 429 (vượt 30 req/phút) → rơi xuống engine kế tiếp', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('tinyfish') ? jsonRes('{}', 429) : htmlRes(DDG_LITE_HTML),
      ),
    );

    const r = await searchWeb('bị rate limit');
    expect(r.engine).toBe('ddg-html');
  });

  it('TinyFish trả 200 nhưng results rỗng → vẫn fallback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('tinyfish')
          ? jsonRes(JSON.stringify({ results: [] }))
          : htmlRes(DDG_LITE_HTML),
      ),
    );

    const r = await searchWeb('rỗng');
    expect(r.engine).toBe('ddg-html');
  });

  it('TinyFish sập mạng → không làm vỡ lượt tìm kiếm', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('tinyfish')) throw new Error('ECONNRESET');
        return htmlRes(DDG_LITE_HTML);
      }),
    );

    const r = await searchWeb('mạng sập');
    expect(r.engine).toBe('ddg-html');
  });
});

/* ------------------------------------------------------------------ */
/* Fetch: lưới cứu cho trang JS-heavy                                  */
/* ------------------------------------------------------------------ */

describe('fetchReadablePage — TinyFish Fetch trước Jina Reader', () => {
  it('trang SPA rỗng → TinyFish render được, không cần Jina', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        if (String(url).includes('api.fetch.tinyfish.ai')) return jsonRes(TF_FETCH_OK);
        return htmlRes(SPA_HTML);
      }),
    );

    const page = await fetchReadablePage('https://spa.example/');
    expect(page.title).toBe('Trang SPA');
    expect(page.content).toContain('TinyFish render');
    expect(urls.some((u) => u.includes('r.jina.ai'))).toBe(false);
  });

  it('yêu cầu bản LIVE (ttl 0), định dạng markdown', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('api.fetch.tinyfish.ai')) {
          body = JSON.parse(String(init?.body ?? '{}'));
          return jsonRes(TF_FETCH_OK);
        }
        return htmlRes(SPA_HTML);
      }),
    );

    await fetchReadablePage('https://spa.example/');
    expect(body.urls).toEqual(['https://spa.example/']);
    expect(body.format).toBe('markdown');
    expect(body.ttl).toBe(0);
  });

  it('TinyFish hỏng → vẫn thử Jina Reader (hai lưới độc lập)', async () => {
    const jina =
      'Title: Từ Jina\n\nURL Source: https://spa.example/\n\nMarkdown Content:\nNội dung Jina.';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('api.fetch.tinyfish.ai')) return jsonRes('{}', 503);
        if (u.startsWith('https://r.jina.ai/')) return textRes(jina);
        return htmlRes(SPA_HTML);
      }),
    );

    const page = await fetchReadablePage('https://spa.example/');
    expect(page.title).toBe('Từ Jina');
    expect(page.content).toContain('Nội dung Jina');
  });

  it('cả hai lưới hỏng → giữ nguyên lỗi gốc WEB_EMPTY_CONTENT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('api.fetch.tinyfish.ai')) return jsonRes('{}', 503);
        if (u.startsWith('https://r.jina.ai/')) return textRes('', 503);
        return htmlRes(SPA_HTML);
      }),
    );

    await expect(fetchReadablePage('https://spa.example/')).rejects.toMatchObject({
      code: 'WEB_EMPTY_CONTENT',
    });
  });

  it('trang tĩnh bình thường KHÔNG gọi TinyFish (đường chính vẫn nhanh)', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return htmlRes(
          '<html><head><title>Tĩnh</title></head><body><article><p>Nội dung thật, đủ dài.</p></article></body></html>',
        );
      }),
    );

    const page = await fetchReadablePage('https://static.example/');
    expect(page.content).toContain('Nội dung thật');
    expect(urls.some((u) => u.includes('tinyfish'))).toBe(false);
  });

  it('không có key → bỏ qua TinyFish, đi thẳng Jina như trước', async () => {
    delete process.env.TINYFISH_API_KEY;
    const jina = 'Title: X\n\nMarkdown Content:\nNội dung.';
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return String(url).startsWith('https://r.jina.ai/') ? textRes(jina) : htmlRes(SPA_HTML);
      }),
    );

    const page = await fetchReadablePage('https://spa.example/');
    expect(page.content).toContain('Nội dung.');
    expect(urls.some((u) => u.includes('tinyfish'))).toBe(false);
  });

  it('SSRF guard vẫn chặn URL private TRƯỚC khi chạm TinyFish', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(fetchReadablePage('http://169.254.169.254/latest/meta-data')).rejects.toMatchObject(
      { code: 'WEB_URL_BLOCKED' },
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
