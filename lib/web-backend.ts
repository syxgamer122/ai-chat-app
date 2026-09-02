/**
 * Backend web dùng chung cho server: /api/web route VÀ các agentic tools
 * (web_search/web_fetch trong /api/chat). Tách khỏi route để tool của model
 * gọi được cùng một đường ống đã qua kiểm soát SSRF/timeout/trần byte.
 *
 * Toán nhẹ (fetch + regex), không DOM parser — cùng triết lý với lib/web-extract.
 */

import { assertFetchableUrl, assertFetchableIp } from '@/lib/web-url-guard';
import {
  capText,
  extractReadableText,
  parseDdgHtml,
  parseDdgLite,
  parseYahoo,
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

/**
 * PERF: Cache DNS lookup function để tránh dynamic import mỗi lần fetch.
 * Edge runtime không có node:dns → cachedDnsLookup = null, check một lần.
 */
let cachedDnsLookup: ((hostname: string) => Promise<{ address: string }>) | null | undefined =
  undefined;
async function getDnsLookup() {
  if (cachedDnsLookup !== undefined) return cachedDnsLookup;
  try {
    const dns = await import('node:dns/promises');
    cachedDnsLookup = dns.lookup;
  } catch {
    cachedDnsLookup = null; // Edge runtime hoặc môi trường không hỗ trợ
  }
  return cachedDnsLookup;
}
/** Trần ký tự nội dung mỗi trang đưa vào context (~2k token). */
const MAX_TEXT_CHARS = WEB_LIMITS.pageContentChars;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Nhóm User-Agent xoay vòng cho engine scrape (kỹ thuật port từ Firecrawl,
 * `apps/api/src/search/v2/ddgsearch.ts`). Một UA cố định cho MỌI request là
 * dấu hiệu bot rõ ràng nhất.
 *
 * THỰC TẾ ĐO ĐƯỢC: kỹ thuật này giúp request ĐẦU thành công (200 + 10 kết
 * quả) nơi cách gọi cũ chỉ nhận 202 rỗng — nhưng KHÔNG cứu được khi IP đã bị
 * DuckDuckGo gắn cờ; lúc đó mọi biến thể UA/URL/method đều trả 202. Vì vậy
 * đây chỉ là cải thiện tỷ lệ thành công, không phải giải pháp thay cho engine
 * có API key.
 */
const SEARCH_USER_AGENTS: readonly string[] = Object.freeze([
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
]);

function pickSearchUserAgent(): string {
  return SEARCH_USER_AGENTS[Math.floor(Math.random() * SEARCH_USER_AGENTS.length)];
}

/** Header giống trình duyệt thật cho engine scrape (Firecrawl dùng bộ này). */
function browserLikeHeaders(userAgent: string): Record<string, string> {
  return {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Upgrade-Insecure-Requests': '1',
  };
}

/**
 * DuckDuckGo trả HTTP 202 kèm trang rỗng, hoặc 200 kèm `.anomaly-modal__modal`,
 * khi coi client là bot. Cả hai PHẢI được coi là "bị chặn" chứ không phải
 * "không có kết quả" — nhầm lẫn này khiến log cũ báo "trang rỗng" và che mất
 * nguyên nhân thật.
 */
export function isDdgBlockedResponse(status: number, html: string): boolean {
  if (status === 202) return true;
  return /anomaly-modal__modal|anomaly_modal|Unfortunately, bots use DuckDuckGo too/i.test(
    html.slice(0, 4000),
  );
}

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
 *
 * `trusted = true`: bỏ kiểm SSRF cho endpoint do NGƯỜI VẬN HÀNH cấu hình qua
 * env (vd SEARXNG_URL chạy trên localhost/LAN) — chặn theo guard sẽ vô lý vì
 * chính owner đã chọn địa chỉ đó. Input người dùng vẫn KHÔNG BAO GIỜ được
 * hưởng cờ này.
 */
export async function guardedFetch(
  rawUrl: string,
  timeoutMs: number,
  trusted = false,
  /** Header ghi đè (engine search dùng bộ giống trình duyệt để đỡ bị chặn). */
  headers?: Record<string, string>,
): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!trusted) {
      const check = assertFetchableUrl(current);
      if (!check.ok) throw new WebOpError(check.error, 400, 'WEB_URL_BLOCKED');
      // FIX #1: Chặn DNS rebinding - hostname public nhưng DNS trả về IP private.
      // assertFetchableUrl chỉ kiểm tra hostname string; fetch() resolve DNS độc lập
      // nên evil.example.com có thể trỏ về 127.0.0.1/169.254.x.x lúc TCP connect.
      // PERF: Dùng cached DNS lookup thay vì dynamic import mỗi lần fetch.
      try {
        const dnsLookup = await getDnsLookup();
        if (dnsLookup) {
          const hostname = new URL(current).hostname;
          const resolved = await dnsLookup(hostname);
          const ipCheck = assertFetchableIp(resolved.address);
          if (!ipCheck.ok) throw new WebOpError(ipCheck.error, 400, 'WEB_URL_BLOCKED');
        }
        // dnsLookup === null → Edge runtime, bỏ qua gracefully (đã cache)
      } catch (dnsErr) {
        if (dnsErr instanceof WebOpError) throw dnsErr;
        // Lỗi DNS khác (NXDOMAIN, timeout...) → bỏ qua, fetch() sẽ báo lỗi sau
      }
    }

    const res = await fetch(current, {
      redirect: 'manual',
      headers: headers ?? {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
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
  // Header giống trình duyệt + UA xoay vòng: cách gọi cũ (chỉ UA cố định)
  // nhận 202 rỗng ngay từ request đầu.
  const res = await guardedFetch(url, SEARCH_TIMEOUT_MS, false, browserLikeHeaders(pickSearchUserAgent()));
  const html = res.ok ? await readTextCapped(res, MAX_ENGINE_BYTES) : '';

  if (isDdgBlockedResponse(res.status, html)) {
    throw new WebOpError(
      `${label} chặn truy cập tự động (HTTP ${res.status}) — IP máy chủ có thể đã bị gắn cờ.`,
      502,
      'WEB_SEARCH_BLOCKED',
    );
  }
  if (!res.ok) throw new WebOpError(`${label} trả ${res.status}.`, 502, 'WEB_SEARCH_UPSTREAM');
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('text/html')) throw new WebOpError(`${label} trả content-type lạ.`, 502, 'WEB_SEARCH_UPSTREAM');
  return html;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export interface WebSearchResult {
  hits: Array<{ title: string; url: string; snippet: string }>;
  engine: 'searxng' | 'tinyfish' | 'brave' | 'tavily' | 'ddg-lite' | 'ddg-html' | 'yahoo' | 'ddg-ia';
}

/* ------------------------------------------------------------------ */
/* TinyFish Search API (env TINYFISH_API_KEY)                          */
/* ------------------------------------------------------------------ */

/**
 * `GET https://api.search.tinyfish.ai?query=…`, header `X-API-Key`.
 *
 * Search/Fetch của TinyFish MIỄN PHÍ ở mọi mức ví (kể cả $0) — họ chỉ tính
 * tiền Agent/Browser. Vì vậy engine này đứng TRƯỚC Brave/Tavily: hai cái đó
 * đốt quota trả phí ($5–8 / 1.000 lượt), còn cái này không.
 *
 * Rate limit công bố: 30 request/phút cho Search. Không có SLA (đúng logic —
 * miễn phí thì không cam kết), nên nó là engine ƯU TIÊN chứ không phải engine
 * DUY NHẤT: cả chuỗi fallback cũ vẫn nguyên vẹn phía sau.
 *
 * Kết quả: `{ results: [{ position, site_name, title, snippet, url }] }`.
 */
export function parseTinyfishSearchJson(text: string): WebSearchResult['hits'] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const results = (json as { results?: Array<Record<string, unknown>> })?.results;
  if (!Array.isArray(results)) return [];
  const out: WebSearchResult['hits'] = [];
  for (const r of results) {
    const title = typeof r?.title === 'string' ? r.title.trim() : '';
    const url = typeof r?.url === 'string' ? r.url.trim() : '';
    const snippet = typeof r?.snippet === 'string' ? r.snippet : '';
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

async function searchTinyfish(query: string, key: string): Promise<WebSearchResult['hits']> {
  const res = await fetch(
    `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}`,
    {
      headers: { Accept: 'application/json', 'X-API-Key': key },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      cache: 'no-store',
    },
  );
  if (!res.ok) {
    throw new WebOpError(`TinyFish trả ${res.status}.`, 502, 'WEB_SEARCH_UPSTREAM');
  }
  return parseTinyfishSearchJson(await readTextCapped(res, MAX_ENGINE_BYTES));
}

/* ------------------------------------------------------------------ */
/* Brave Search API (env BRAVE_SEARCH_KEY)                             */
/* ------------------------------------------------------------------ */

/**
 * API chính thức, 2.000 lượt/tháng miễn phí — lấy key tại
 * https://api-dashboard.search.brave.com. Đây là engine đáng tin cậy nhất
 * hiện nay vì hai endpoint scrape của DuckDuckGo đã bị chặn cứng bằng 403.
 */
export function parseBraveJson(text: string): WebSearchResult['hits'] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const results = (json as { web?: { results?: Array<Record<string, unknown>> } })?.web?.results;
  if (!Array.isArray(results)) return [];
  const out: WebSearchResult['hits'] = [];
  for (const r of results) {
    const title = typeof r?.title === 'string' ? r.title.trim() : '';
    const url = typeof r?.url === 'string' ? r.url.trim() : '';
    const snippet = typeof r?.description === 'string' ? r.description : '';
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

async function searchBrave(query: string, key: string): Promise<WebSearchResult['hits']> {
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`,
    {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      cache: 'no-store',
    },
  );
  if (!res.ok) throw new WebOpError(`Brave trả ${res.status}.`, 502, 'WEB_SEARCH_UPSTREAM');
  return parseBraveJson(await readTextCapped(res, MAX_ENGINE_BYTES));
}

/* ------------------------------------------------------------------ */
/* Tavily API (env TAVILY_API_KEY)                                     */
/* ------------------------------------------------------------------ */

/** API hướng LLM, 1.000 lượt/tháng miễn phí — https://tavily.com. */
export function parseTavilyJson(text: string): WebSearchResult['hits'] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const results = (json as { results?: Array<Record<string, unknown>> })?.results;
  if (!Array.isArray(results)) return [];
  const out: WebSearchResult['hits'] = [];
  for (const r of results) {
    const title = typeof r?.title === 'string' ? r.title.trim() : '';
    const url = typeof r?.url === 'string' ? r.url.trim() : '';
    const snippet = typeof r?.content === 'string' ? r.content : '';
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

async function searchTavily(query: string, key: string): Promise<WebSearchResult['hits']> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: 8 }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!res.ok) throw new WebOpError(`Tavily trả ${res.status}.`, 502, 'WEB_SEARCH_UPSTREAM');
  return parseTavilyJson(await readTextCapped(res, MAX_ENGINE_BYTES));
}

/* ------------------------------------------------------------------ */
/* DuckDuckGo Instant Answer API (không cần key)                       */
/* ------------------------------------------------------------------ */

/**
 * Endpoint JSON CÔNG KHAI của DDG, khác hẳn hai endpoint scrape đã bị 403.
 * Hạn chế: chỉ trả tri thức bách khoa (Abstract + RelatedTopics), KHÔNG có
 * tin tức/thời sự. Vì vậy nó nằm CUỐI chuỗi — chỉ dùng khi mọi engine thật
 * đều hỏng, để người dùng còn nhận được gì đó thay vì lỗi 502 trắng.
 */
export function parseDdgInstantAnswer(text: string): WebSearchResult['hits'] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const j = json as {
    AbstractText?: unknown;
    AbstractURL?: unknown;
    Heading?: unknown;
    RelatedTopics?: Array<Record<string, unknown>>;
  };
  const out: WebSearchResult['hits'] = [];

  const absText = typeof j?.AbstractText === 'string' ? j.AbstractText.trim() : '';
  const absUrl = typeof j?.AbstractURL === 'string' ? j.AbstractURL.trim() : '';
  const heading = typeof j?.Heading === 'string' ? j.Heading.trim() : '';
  if (absText && /^https?:\/\//i.test(absUrl)) {
    out.push({ title: heading || absUrl, url: absUrl, snippet: absText });
  }

  for (const t of Array.isArray(j?.RelatedTopics) ? j.RelatedTopics : []) {
    const url = typeof t?.FirstURL === 'string' ? t.FirstURL.trim() : '';
    const txt = typeof t?.Text === 'string' ? t.Text.trim() : '';
    // Bỏ link nội bộ duckduckgo.com/c/... (trang phân loại, không phải nguồn).
    if (!txt || !/^https?:\/\//i.test(url) || /^https?:\/\/duckduckgo\.com\//i.test(url)) continue;
    out.push({ title: txt.split(' - ')[0].slice(0, 120), url, snippet: txt });
  }
  return out;
}

async function searchDdgInstantAnswer(query: string): Promise<WebSearchResult['hits']> {
  const res = await guardedFetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`,
    SEARCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new WebOpError(`DDG API trả ${res.status}.`, 502, 'WEB_SEARCH_UPSTREAM');
  return parseDdgInstantAnswer(await readTextCapped(res, MAX_ENGINE_BYTES));
}

/* ------------------------------------------------------------------ */
/* SearXNG (tự host, env SEARXNG_URL)                                  */
/* ------------------------------------------------------------------ */

/** Đọc base URL SearXNG từ env; sai protocol/rác → null (bỏ engine này). */
export function searxngBase(env = process.env.SEARXNG_URL): string | null {
  return searxngBases(env)[0] ?? null;
}

/**
 * SEARXNG_URL nhận NHIỀU instance, phân tách bằng dấu phẩy — một instance
 * công cộng chết/rate-limit thì còn cái khác. Ý tưởng lấy từ cấu hình
 * `searxng_base_urls` (số nhiều) trong websearch.py.
 */
export function searxngBases(env = process.env.SEARXNG_URL): string[] {
  const out: string[] = [];
  for (const part of (env ?? '').split(',')) {
    const raw = part.trim().replace(/\/+$/, '');
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      const normalized = `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')}`;
      if (!out.includes(normalized)) out.push(normalized);
    } catch {
      /* bỏ qua mục rác, không giết cả danh sách */
    }
  }
  return out;
}

/**
 * Parse JSON của SearXNG `/search?format=json` — `results[].{url,title,content}`.
 * Trả [] cho payload lạ, coi như engine hỏng để rơi sang DDG.
 */
export function parseSearxngJson(text: string): WebSearchResult['hits'] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const results = (json as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> })
    ?.results;
  if (!Array.isArray(results)) return [];
  const out: WebSearchResult['hits'] = [];
  for (const r of results) {
    const title = typeof r?.title === 'string' ? r.title.trim() : '';
    const url = typeof r?.url === 'string' ? r.url.trim() : '';
    const snippet = typeof r?.content === 'string' ? r.content : '';
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

async function searchSearxng(query: string): Promise<WebSearchResult['hits']> {
  const bases = searxngBases();
  if (!bases.length) throw new WebOpError('SEARXNG_URL chưa cấu hình.', 502, 'WEB_SEARCH_UPSTREAM');

  let lastError = 'không instance nào phản hồi';
  for (const base of bases) {
    try {
      // trusted=true: endpoint do owner cấu hình qua env (thường localhost/LAN),
      // guard SSRF theo URL công cộng không áp dụng ở đây.
      const res = await guardedFetch(
        `${base}/search?q=${encodeURIComponent(query)}&format=json`,
        SEARCH_TIMEOUT_MS,
        true,
      );
      if (!res.ok) {
        lastError = `${base} trả ${res.status}`;
        continue;
      }
      const hits = parseSearxngJson(await readTextCapped(res, MAX_ENGINE_BYTES));
      if (hits.length) return hits;
      lastError = `${base} không có kết quả`;
    } catch (e) {
      lastError = `${base}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new WebOpError(`SearXNG: ${lastError}.`, 502, 'WEB_SEARCH_UPSTREAM');
}

/**
 * Chuỗi engine, xếp theo độ tin cậy giảm dần:
 *   SearXNG (tự host) → TinyFish API → Brave API → Tavily API → DDG scrape
 *   → Yahoo → DDG Instant Answer
 *
 * BỐI CẢNH: hai endpoint scrape của DuckDuckGo (lite/ + html/) NAY TRẢ 403 —
 * đã kiểm chứng bằng request thật, không phải suy đoán. Trước đây chúng là
 * engine mặc định duy nhất nên tính năng tìm web hỏng hoàn toàn với lỗi
 * "trang rỗng | trang rỗng". Vẫn giữ chúng trong chuỗi vì DDG có thể mở lại,
 * nhưng giờ đã có engine API chính thức đứng trước và Instant Answer đỡ phía
 * sau. Muốn tra cứu ĐÁNG TIN, đặt một trong các biến môi trường:
 *   TINYFISH_API_KEY (miễn phí) | SEARXNG_URL | BRAVE_SEARCH_KEY | TAVILY_API_KEY
 */
/* ------------------------------------------------------------------ */
/* Cache kết quả search                                                */
/* ------------------------------------------------------------------ */

/**
 * Cache TTL cho truy vấn lặp (ý tưởng từ MindSearch: `TTLCache(maxsize=100,
 * ttl=600)` bọc mọi backend search). Ở đây nó còn quan trọng hơn: mỗi request
 * tiết kiệm được là một lần KHÔNG chạm vào engine đang chặn bot, nên giảm
 * hẳn nguy cơ IP bị gắn cờ.
 */
const SEARCH_CACHE_TTL_MS = 10 * 60_000;
const SEARCH_CACHE_MAX = 100;
const searchCache = new Map<string, { at: number; value: WebSearchResult }>();

function cacheGet(key: string): WebSearchResult | null {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  // Chạm lại = đẩy lên cuối (LRU thô trên Map giữ thứ tự chèn).
  searchCache.delete(key);
  searchCache.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: WebSearchResult): void {
  searchCache.set(key, { at: Date.now(), value });
  while (searchCache.size > SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest === undefined) break;
    searchCache.delete(oldest);
  }
}

/** Chỉ dùng trong test. */
export function __clearSearchCache(): void {
  searchCache.clear();
}

export async function searchWeb(query: string): Promise<WebSearchResult> {
  const cacheKey = query.trim().toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const result = await searchWebUncached(query);
  cacheSet(cacheKey, result);
  return result;
}

async function searchWebUncached(query: string): Promise<WebSearchResult> {
  const failures: string[] = [];

  const tryEngine = async (
    label: string,
    engine: WebSearchResult['engine'],
    run: () => Promise<WebSearchResult['hits']>,
  ): Promise<WebSearchResult | null> => {
    try {
      const hits = await run();
      if (hits.length > 0) return { hits, engine };
      failures.push(`${label}: kết quả rỗng`);
    } catch (e) {
      failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  };

  // SearXNG ưu tiên tuyệt đối khi có: metasearch tổng hợp nhiều engine,
  // JSON sạch không phải scrape, không bot-challenge.
  if (searxngBase()) {
    const r = await tryEngine('SearXNG', 'searxng', () => searchSearxng(query));
    if (r) return r;
  }

  /* TinyFish trước Brave/Tavily: API chính thức, JSON sạch, và MIỄN PHÍ ở mọi
     mức ví — không đốt quota trả phí của hai engine dưới. */
  const tinyfishKey = (process.env.TINYFISH_API_KEY ?? '').trim();
  if (tinyfishKey) {
    const r = await tryEngine('TinyFish', 'tinyfish', () => searchTinyfish(query, tinyfishKey));
    if (r) return r;
  }

  const braveKey = (process.env.BRAVE_SEARCH_KEY ?? '').trim();
  if (braveKey) {
    const r = await tryEngine('Brave', 'brave', () => searchBrave(query, braveKey));
    if (r) return r;
  }

  const tavilyKey = (process.env.TAVILY_API_KEY ?? '').trim();
  if (tavilyKey) {
    const r = await tryEngine('Tavily', 'tavily', () => searchTavily(query, tavilyKey));
    if (r) return r;
  }

  /* Dạng URL port từ Firecrawl: `html?q=…&kp=1` (KHÔNG có dấu / trước ?).
     Đo thực tế cho thấy biến thể này trả 200 + kết quả ở request đầu, còn
     dạng cũ `html/?q=…` nhận 202 rỗng ngay lập tức. `kp=1` = safe-search off. */
  const q = encodeURIComponent(query);
  /* Engine scrape KHÔNG cần key, xếp theo tỷ lệ thành công đo được.
     Yahoo đứng sau DDG nhưng trước lưới cuối: khi IP bị DDG gắn cờ (mọi
     endpoint DDG trả 202 rỗng), Yahoo vẫn phục vụ bình thường — đã kiểm
     chứng bằng request thật với cả truy vấn tiếng Việt. */
  const engines = [
    ['ddg-html', `https://html.duckduckgo.com/html?q=${q}&kp=1`, 'DuckDuckGo HTML'],
    ['ddg-lite', `https://lite.duckduckgo.com/lite/?q=${q}&kp=1`, 'DuckDuckGo Lite'],
    ['yahoo', `https://search.yahoo.com/search?p=${q}`, 'Yahoo'],
  ] as const;
  for (const [engine, url, label] of engines) {
    try {
      const html = await engineText(url, label);
      const parsedHits =
        engine === 'yahoo'
          ? parseYahoo(html)
          : html.includes('result-link')
            ? parseDdgLite(html)
            : parseDdgHtml(html);
      if (parsedHits.length > 0) return { hits: parsedHits, engine };
      failures.push(`${label}: trang rỗng`);
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }

  // Lưới cuối: chỉ có tri thức bách khoa, nhưng còn hơn không có gì.
  const ia = await tryEngine('DDG Instant Answer', 'ddg-ia', () => searchDdgInstantAnswer(query));
  if (ia) return ia;

  throw new WebOpError(
    `${failures.join(' | ')}. Mọi công cụ tìm kiếm công khai đều đang chặn hoặc không có kết quả — ` +
      'đặt TINYFISH_API_KEY (miễn phí), BRAVE_SEARCH_KEY, TAVILY_API_KEY hoặc SEARXNG_URL để tra cứu ổn định.',
    502,
    'SEARCH_UNAVAILABLE',
  );
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
    /* Trang SPA/JS-heavy: HTML thô chỉ có <div id="root"></div>, bộ trích
       theo regex không lấy được gì. Trước đây lượt này chết hẳn với
       WEB_EMPTY_CONTENT.

       Hai lưới cứu, xếp theo độ tin cậy: TinyFish Fetch (API chính thức, có
       key, render bằng browser thật, miễn phí) rồi Jina Reader (công khai
       không key, hạn mức mơ hồ). Cả hai đều đẩy URL qua bên thứ ba nên chỉ
       chạy ở đây, không nằm trên đường chính. */
    const viaTinyfish = await fetchViaTinyfish(finalUrl);
    if (viaTinyfish) return viaTinyfish;
    const viaReader = await fetchViaJinaReader(finalUrl);
    if (viaReader) return viaReader;
    throw new WebOpError('Trang không có nội dung văn bản nào đọc được.', 422, 'WEB_EMPTY_CONTENT');
  }

  return {
    url: finalUrl.slice(0, WEB_LIMITS.hitUrlChars),
    title: capText(extracted.title ?? '', WEB_LIMITS.pageTitleChars),
    content: capText(extracted.text, MAX_TEXT_CHARS),
    truncated: extracted.text.length > MAX_TEXT_CHARS,
  };
}

/**
 * Parse `POST https://api.fetch.tinyfish.ai` → `{ results: [...], errors: [...] }`.
 *
 * Lỗi TỪNG URL nằm trong `errors[]` kèm HTTP 200 (không phải status lỗi), nên
 * `results` rỗng vẫn là một phản hồi "thành công" — phải tự kiểm.
 * Tách khỏi hàm gọi mạng để test được không cần fetch thật.
 */
export function parseTinyfishFetchJson(text: string): { title: string; content: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const results = (json as { results?: Array<Record<string, unknown>> })?.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = results[0];
  /* format mặc định là markdown → `text` là string. Với format 'json' nó là
     object; ta không yêu cầu format đó nhưng vẫn phòng để không crash. */
  const body = typeof first?.text === 'string' ? first.text.trim() : '';
  if (!body) return null;
  const title = typeof first?.title === 'string' ? first.title.trim() : '';
  return { title, content: body };
}

/**
 * Đọc trang qua TinyFish Fetch API — render JavaScript rồi trả markdown sạch.
 * Miễn phí ở mọi mức ví, rate limit công bố 150 url/phút.
 *
 * `ttl: 0` để lấy bản LIVE: mặc định họ có thể trả cache bất kỳ tuổi nào, mà
 * lượt này xảy ra vì người dùng/model đang cần nội dung thật của trang.
 *
 * Trả null khi không có key hoặc thất bại — caller rơi xuống lưới kế tiếp.
 */
async function fetchViaTinyfish(targetUrl: string): Promise<ReadablePage | null> {
  const key = (process.env.TINYFISH_API_KEY ?? '').trim();
  if (!key) return null;
  try {
    const res = await fetch('https://api.fetch.tinyfish.ai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-Key': key,
      },
      body: JSON.stringify({ urls: [targetUrl], format: 'markdown', ttl: 0 }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const parsed = parseTinyfishFetchJson(await readTextCapped(res, MAX_PAGE_BYTES));
    if (!parsed) return null;

    return {
      url: targetUrl.slice(0, WEB_LIMITS.hitUrlChars),
      title: capText(parsed.title, WEB_LIMITS.pageTitleChars),
      content: capText(parsed.content, MAX_TEXT_CHARS),
      truncated: parsed.content.length > MAX_TEXT_CHARS,
    };
  } catch {
    return null;
  }
}

/**
 * Đọc trang qua Jina Reader (`https://r.jina.ai/<url>`) — dịch vụ công khai
 * KHÔNG cần API key, trả về markdown đã render (chạy được JS).
 *
 * Chỉ dùng làm FALLBACK khi bộ trích tại chỗ trả rỗng: nó chậm hơn nhiều và
 * đẩy URL người dùng qua bên thứ ba, nên không đặt ở đường chính.
 * Endpoint search của Jina (`s.jina.ai`) CẦN key nên không dùng.
 *
 * Trả null khi thất bại — caller giữ nguyên lỗi gốc.
 */
async function fetchViaJinaReader(targetUrl: string): Promise<ReadablePage | null> {
  try {
    const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers: { Accept: 'text/plain', 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const md = await readTextCapped(res, MAX_PAGE_BYTES);
    if (!md.trim()) return null;

    /* Định dạng trả về: "Title: …\n\nURL Source: …\n\nMarkdown Content:\n…" */
    const title = /^Title:\s*(.+)$/m.exec(md)?.[1]?.trim() ?? '';
    const bodyStart = md.indexOf('Markdown Content:');
    const body = (bodyStart >= 0 ? md.slice(bodyStart + 'Markdown Content:'.length) : md).trim();
    if (!body) return null;

    return {
      url: targetUrl.slice(0, WEB_LIMITS.hitUrlChars),
      title: capText(title, WEB_LIMITS.pageTitleChars),
      content: capText(body, MAX_TEXT_CHARS),
      truncated: body.length > MAX_TEXT_CHARS,
    };
  } catch {
    return null;
  }
}
