import { describe, expect, it } from 'vitest';
import {
  capText,
  decodeHtmlEntities,
  extractReadableText,
  parseDdgHtml,
  parseDdgLite,
  unwrapDdgRedirect,
} from '@/lib/web-extract';

describe('decodeHtmlEntities', () => {
  it('entity đặt tên + numeric + hex', () => {
    expect(decodeHtmlEntities('a &amp; b &lt;c&gt; &quot;x&quot;')).toBe('a & b <c> "x"');
    expect(decodeHtmlEntities('&#65;&#x42;')).toBe('AB');
    // nbsp chủ đích map thành space thường — bước dọn dòng phía sau sẽ gộp lại.
    expect(decodeHtmlEntities('tiếng Việt&nbsp;có dấu &mdash; ok')).toBe(
      'tiếng Việt có dấu \u2014 ok',
    );
  });

  it('giữ nguyên entity lạ', () => {
    expect(decodeHtmlEntities('&unknown;')).toBe('&unknown;');
  });
});

describe('extractReadableText — HTML → văn bản cho LLM', () => {
  const html = `
    <html><head><title>Trang kiểm tra</title>
      <style>.x { color: red }</style>
      <script>console.log("junk")</script>
    </head>
    <body>
      <nav>Menu Home Liên hệ</nav>
      <main>
        <h1>Tiêu đề chính</h1>
        <p>Đoạn văn thứ nhất, có&nbsp;dấu cách.</p>
        <ul><li>Mục A</li><li>Mục B</li></ul>
        <p>Đoạn cuối.</p>
      </main>
      <footer>Bản quyền 2026</footer>
    </body></html>`;

  it('lấy title, bỏ script/style/nav/footer, giữ cấu trúc heading/li', () => {
    const { title, text } = extractReadableText(html);
    expect(title).toBe('Trang kiểm tra');
    expect(text).toContain('## Tiêu đề chính');
    expect(text).toContain('- Mục A');
    expect(text).toContain('- Mục B');
    expect(text).toContain('Đoạn văn thứ nhất, có dấu cách.');
    expect(text).not.toContain('junk');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('Bản quyền');
    expect(text).not.toContain('Liên hệ');
  });

  it('không có main/article thì dùng cả document', () => {
    const { text } = extractReadableText('<html><body><p>chỉ có một đoạn</p></body></html>');
    expect(text).toBe('chỉ có một đoạn');
  });

  it('trang rác chỉ còn whitespace', () => {
    const { title, text } = extractReadableText('<div>&nbsp;</div>');
    expect(title).toBeNull();
    expect(text).toBe('');
  });
});

describe('capText', () => {
  it('ngắn thì giữ nguyên', () => {
    expect(capText('abc', 10)).toBe('abc');
  });

  it('dài thì cắt tại ranh giới câu nếu hợp lý', () => {
    const long = `${'A'.repeat(50)}. ${'B'.repeat(200)}`;
    const capped = capText(long, 100);
    // Trần mềm: tối đa maxChars + 2 ký tự của dấu " …".
    expect(capped.length).toBeLessThanOrEqual(102);
    expect(capped.endsWith('…')).toBe(true);
  });
});

describe('unwrapDdgRedirect', () => {
  it('giải mã tham số uddg', () => {
    const target = 'https://example.com/bài?v=2';
    expect(
      unwrapDdgRedirect(`//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=x`),
    ).toBe(target);
  });

  it('URL thường đi qua nguyên vẹn', () => {
    expect(unwrapDdgRedirect('https://example.com/a')).toBe('https://example.com/a');
  });
});

describe('parseDdgLite — lite.duckduckgo.com', () => {
  const fixture = `<table>
    <tr>
      <td><a rel="nofollow" class='result-link' href="https://example.com/1">Kết quả một</a></td>
    </tr>
    <tr><td class="result-snippet"> Mô tả một &amp; chi tiết </td></tr>
    <tr>
      <td><a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2F2">Kết quả hai</a></td>
    </tr>
    <tr><td class="result-snippet">Mô tả hai</td></tr>
    <tr>
      <td><a class="result-link" href="https://duckduckgo.com/y.js?ad_domain=ads.example">Quảng cáo lite</a></td>
    </tr>
    <tr>
      <td><a class="result-link" href="https://example.com/1">Kết quả một trùng URL</a></td>
    </tr>
  </table>`;

  it('bóc title/url/snippet, giải mã redirect, dedupe theo URL, bỏ quảng cáo', () => {
    const hits = parseDdgLite(fixture);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.url)).not.toContain(expect.stringContaining('duckduckgo.com'));
    expect(hits[0]).toEqual({
      title: 'Kết quả một',
      url: 'https://example.com/1',
      snippet: 'Mô tả một & chi tiết',
    });
    expect(hits[1].url).toBe('https://example.org/2');
    expect(hits[1].title).toBe('Kết quả hai');
  });

  it('trang challenge rỗng trả mảng rỗng (để fallback engine)', () => {
    expect(parseDdgLite('<html><body>Anomaly detected</body></html>')).toEqual([]);
  });
});

describe('parseDdgHtml — html.duckduckgo.com', () => {
  const fixture = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide">Hướng dẫn</a>
    <a class="result__snippet" href="#">Phần mô tả ngắn của kết quả đầu tiên</a>
    <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example">Quảng cáo</a>
    <a class="result__snippet">Quảng cáo đây</a>`;

  it('lấy kết quả thật và BỎ link quảng cáo y.js', () => {
    const hits = parseDdgHtml(fixture);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      title: 'Hướng dẫn',
      url: 'https://docs.example.com/guide',
      snippet: 'Phần mô tả ngắn của kết quả đầu tiên',
    });
  });
});
