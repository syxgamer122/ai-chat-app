/**
 * Bộ bóc tách HTML thuần regex — KHÔNG DOM parser (Edge/Node serverless không
 * có DOMParser, không muốn thêm dependency nặng kiểu jsdom).
 *
 * Mục đích là "đủ đọc cho LLM", không phải render: bỏ script/style/nav,
 * ưu tiên vùng nội dung chính, giữ cấu trúc tối thiểu (heading, list item).
 * Cùng file này chứa parser kết quả tìm kiếm DuckDuckGo (lite + html) —
 * hai endpoint không cần API key, đủ làm chuỗi fallback cho /api/web.
 */

export interface ExtractedPage {
  title: string | null;
  text: string;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  ldquo: '\u201c',
  rdquo: '\u201d',
  copy: '\u00a9',
  middot: '\u00b7',
  laquo: '\u00ab',
  raquo: '\u00bb',
};

export function decodeHtmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Gộp whitespace xuống 1 space — dùng cho title/snippet một dòng. */
export function collapseWs(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function stripNoisyBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object|canvas|select|button|input|form|head|nav|footer|aside)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|input|img|br|hr|link|meta)[^>]*\/?>/gi, ' ');
}

/**
 * Chuyển HTML thành văn bản phẳng có cấu trúc nhẹ:
 * - h1-h6 → dòng "## ..." ; li → "- ..."
 * - mọi tag block khác → ngắt dòng
 */
export function extractReadableText(html: string): ExtractedPage {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? collapseWs(decodeHtmlEntities(titleMatch[1])) || null : null;

  let body = html;

  // Ưu tiên vùng nội dung chính: chọn ứng viên DÀI NHẤT để tránh bắt nhịp
  // <article> rác (widget, card). Không tìm thấy thì dùng cả document.
  const candidates: string[] = [];
  const mainRe = /<main[^>]*>([\s\S]*?)<\/main>/gi;
  const articleRe = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  const roleRe = /<div[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/div>/gi;
  for (const re of [mainRe, articleRe, roleRe]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) candidates.push(m[1]);
  }
  const best = candidates.reduce<string | null>(
    (acc, c) => (c.length > (acc?.length ?? 0) ? c : acc),
    null,
  );
  if (best && best.length > 200) body = best;

  body = stripNoisyBlocks(body)
    // Đánh dấu cấu trúc TRƯỚC khi tuốt tag.
    .replace(/<h[1-6][^>]*>/gi, '\n## ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<pre[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre|table|ul|ol|dl|dd|dt|figure|header)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' | ')
    .replace(/<\/td>/gi, ' ');

  const text = decodeHtmlEntities(body.replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, i, arr) => line.length > 0 || arr[i - 1] !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text };
}

/** Cắt văn bản theo trần ký tự, cố gắng đứt tại ranh giới câu/từ. */
export function capText(text: string, maxChars: number): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const slice = clean.slice(0, maxChars);
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('\n'));
  return (lastStop > maxChars * 0.6 ? slice.slice(0, lastStop + 1) : slice.trimEnd()) + ' …';
}

/* ------------------------------------------------------------------ */
/* Parser kết quả DuckDuckGo                                           */
/* ------------------------------------------------------------------ */

/**
 * DDG hay trả link qua redirect `/l/?uddg=<encoded>` (track click + chống bot).
 * Giải mã về URL thật; không phải redirect thì trả nguyên.
 */
export function unwrapDdgRedirect(href: string): string {
  try {
    const abs = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(abs, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch {
    return href;
  }
}

interface AnchorInfo {
  href: string;
  class: string;
  text: string;
}

function scanAnchors(html: string): AnchorInfo[] {
  const out: AnchorInfo[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const cls = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!href) continue;
    out.push({
      href: href[1] ?? href[2] ?? '',
      class: (cls?.[1] ?? cls?.[2] ?? '').toLowerCase(),
      text: collapseWs(decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ' '))),
    });
  }
  return out;
}

function scanClassedBlocks(html: string, className: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`class\\s*=\\s*["'][^"']*${className}[^"']*["'][^>]*>([\\s\\S]*?)<`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(collapseWs(decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' '))));
  }
  return out;
}

/**
 * Kết quả thật không bao giờ nằm trên domain của DuckDuckGo — mọi URL trỏ về
 * ddg đều là quảng cáo (y.js) hoặc trang giải thích ("more info") cần loại bỏ.
 */
function isDdgSelfUrl(url: string): boolean {
  return /^https?:\/\/([a-z0-9-]+\.)*duckduckgo\.com(\/|$)/i.test(url);
}

function dedupe(hits: WebSearchHit[]): WebSearchHit[] {
  const seen = new Set<string>();
  const out: WebSearchHit[] = [];
  for (const hit of hits) {
    if (!hit.title || !/^https?:\/\//i.test(hit.url) || isDdgSelfUrl(hit.url)) continue;
    const key = hit.url.replace(/[?#].*$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/**
 * lite.duckduckgo.com/lite/?q= — bảng phẳng: anchor class `result-link`,
 * snippet nằm ở ô `result-snippet` cùng hàng.
 */
export function parseDdgLite(html: string): WebSearchHit[] {
  const links = scanAnchors(html).filter(
    (a) => a.class.includes('result-link') && !a.class.includes('result-link--top'),
  );
  const snippets = scanClassedBlocks(html, 'result-snippet');
  const hits = links.map((a, i) => ({
    title: a.text,
    url: unwrapDdgRedirect(a.href),
    snippet: capText(snippets[i] ?? '', 500),
  }));
  return dedupe(hits);
}

/**
 * html.duckduckgo.com/html/?q= — anchor class `result__a` (hay kèm redirect
 * uddg), snippet class `result__snippet`. Bỏ qua link quảng cáo (y.js).
 */
export function parseDdgHtml(html: string): WebSearchHit[] {
  const links = scanAnchors(html).filter((a) => a.class.includes('result__a'));
  const snippets = scanClassedBlocks(html, 'result__snippet');
  const hits = links
    .filter((a) => !/duckduckgo\.com\/y\.js/i.test(a.href))
    .map((a, i) => ({
      title: a.text,
      url: unwrapDdgRedirect(a.href),
      snippet: capText(snippets[i] ?? '', 500),
    }));
  return dedupe(hits);
}
