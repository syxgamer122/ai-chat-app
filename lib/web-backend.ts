/**
 * Backend web dùng chung cho server: /api/web route VÀ các agentic tools
 * (web_search/web_fetch trong /api/chat). Tách khỏi route để tool của model
 * gọi được cùng một đường ống đã qua kiểm soát SSRF/timeout/trần byte.
 *
 * Toán nhẹ (fetch + regex), không DOM parser — cùng triết lý với lib/web-extract.
 */

import { assertFetchableUrl } from '@/lib/web-url-guard';
import {
  capText,
  extractReadableText,
  parseDdgHtml,
  parseDdgLite,
  unwrapDdgRedirect,
} from '@/lib/web-extract';
import { WEB_LIMITS } from '@/lib/web-context';

export class WebOpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

/** Trần byte khi tải HTML trang/web engine — hơn thế chắc không phải nội dung chữ đáng đọc. */
const MAX_PAGE_BYTES = 1_500_000;
const MAX_ENGINE_BYTES = 512 * 1024;
export const FETCH_TIMEOUT_MS = 12_000;
export const SEARCH_TIMEOUT_MS = 8_000;
/** Số hop redirect tối đa khi tự đi tay (để kiểm tra SSRF TỪNG hop). */
const MAX_REDIRECTS = 4;
/** Trần ký tự nội dung mỗi trang đưa vào context (~2k token). */
const MAX_TEXT_CHARS = WEB_LIMITS.pageContentChars;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Đọc response body với trần byte — dừng sớm và cancel stream khi vượt.
 * Trang HTML có thể nặng hàng chục MB; đọc cả thì Node tốn RAM oan.
 */
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { stream: true } as TextDecoderOptions);
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((text += decoder.decode(value, { stream: true })).length > maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text.slice(0, maxBytes);
}

/**
 * Fetch URL public với kiểm soát SSRF TỪNG hop redirect: dùng `redirect:
 * 'manual'` rồi tự resolve Location — nếu để `follow`, request tới host private
 * trong hop redirect ĐÃ xảy ra trước khi ta kịp nhìn URL cuối.
 */
export async function guardedFetch(rawUrl: string, timeoutMs: number): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = assertFetchableUrl(current);
    if (!check.ok) throw new WebOpError(check.error, 400, 'WEB_URL_BLOCKED');

    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new WebOpError(`Redirect ${res.status} thiếu Location.`, 502, 'WEB_UPSTREAM_BAD_REDIRECT');
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new WebOpError(`Quá ${MAX_REDIRECTS} lần redirect.`, 502, 'WEB_TOO_MANY_REDIRECTS');
}

async function engineText(url: string, label: string): Promise<string> {
  const res = await guardedFetch(url, SEARCH_TIMEOUT_MS);
  if (!res.ok) throw new WebOpError(`${label} trả ${res.status}.`, 502, 'WEB_SEARCH_UPSTREAM');
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('text/html')) throw new WebOpError(`${label} trả content-type lạ.`, 502, 'WEB_SEARCH_UPSTREAM');
  return readTextCapped(res, MAX_ENGINE_BYTES);
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface WebSearchResult {
  hits: Array<{ title: string; url: string; snippet: string }>;
  engine: 'ddg-lite' | 'ddg-html';
}

/**
 * Chuỗi engine fallback: lite → html. Cả hai hỏng mới trả lỗi; một cái sống
 * là đủ kết quả. Lite bị bot-challenge đôi khi vẫn trả 200 với trang rỗng —
 * coi như thất bại để rơi sang engine kế tiếp.
 */
export async function searchWeb(query: string): Promise<WebSearchResult> {
  const failures: string[] = [];
  const engines = [
    ['ddg-lite', `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, 'DuckDuckGo Lite'],
    ['ddg-html', `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 'DuckDuckGo HTML'],
  ] as const;
  for (const [engine, url, label] of engines) {
    try {
      const html = await engineText(url, label);
      const parsedHits = html.includes('result-link') ? parseDdgLite(html) : parseDdgHtml(html);
      if (parsedHits.length > 0) return { hits: parsedHits, engine };
      failures.push(`${label}: trang rỗng`);
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new WebOpError(failures.join(' | '), 502, 'SEARCH_UNAVAILABLE');
}

/** Kết quả đã cắt trần theo WEB_LIMITS — dùng cho cả route lẫn tool. */
export function capHits(
  hits: WebSearchResult['hits'],
  count: number,
): WebSearchResult['hits'] {
  return hits.slice(0, count).map((h) => ({
    title: capText(h.title, WEB_LIMITS.hitTitleChars),
    url: h.url.slice(0, WEB_LIMITS.hitUrlChars),
    snippet: capText(h.snippet, WEB_LIMITS.hitSnippetChars),
  }));
}

/* ------------------------------------------------------------------ */
/* Fetch + extract                                                     */
/* ------------------------------------------------------------------ */

const TEXT_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/xml',
  'text/xml',
];

export interface ReadablePage {
  url: string;
  title: string;
  content: string;
  truncated: boolean;
}

/** Fetch một URL public và trích văn bản "đủ đọc cho LLM". */
export async function fetchReadablePage(rawUrl: string): Promise<ReadablePage> {
  const res = await guardedFetch(rawUrl, FETCH_TIMEOUT_MS);
  if (!res.ok) {
    throw new WebOpError(`Trang trả về HTTP ${res.status}.`, 502, 'WEB_UPSTREAM_STATUS');
  }

  // Hop cuối sau redirect phải lại qua guard (guardedFetch đã kiểm từng hop,
  // đây chỉ là chốt hạ với URL phản ánh cuối cùng — gồm cả giải mã redirect
  // theo dõi click của DDG).
  const finalUrl = unwrapDdgRedirect(res.url || rawUrl);
  const finalCheck = assertFetchableUrl(finalUrl);
  if (!finalCheck.ok) {
    throw new WebOpError(finalCheck.error, 400, 'WEB_URL_BLOCKED');
  }

  const ct = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!TEXT_CONTENT_TYPES.some((t) => ct === t)) {
    throw new WebOpError(
      `Loại nội dung "${ct || 'không rõ'}" không đọc được — chỉ hỗ trợ trang văn bản.`,
      415,
      'WEB_UNSUPPORTED_CONTENT_TYPE',
    );
  }

  const html = await readTextCapped(res, MAX_PAGE_BYTES);
  const extracted = extractReadableText(html);
  if (!extracted.text) {
    throw new WebOpError('Trang không có nội dung văn bản nào đọc được.', 422, 'WEB_EMPTY_CONTENT');
  }

  return {
    url: finalUrl.slice(0, WEB_LIMITS.hitUrlChars),
    title: capText(extracted.title ?? '', WEB_LIMITS.pageTitleChars),
    content: capText(extracted.text, MAX_TEXT_CHARS),
    truncated: extracted.text.length > MAX_TEXT_CHARS,
  };
}
