/**
 * Điều phối tra cứu web phía client cho tính năng "Tìm kiếm web".
 *
 * Luồng một lượt gửi bật web:
 *  1. search(query) qua /api/web → tối đa 5 nguồn (title + url + snippet).
 *  2. Nếu người dùng DÁN URL trực tiếp vào tin nhắn → fetch nội dung các URL đó
 *     (ưu tiên hơn kết quả tìm kiếm — ý định của họ là đọc trang đấy).
 *  3. Không dán URL gì thì fetch nội dung top-2 nguồn tìm kiếm.
 * Kết quả gói thành WebContextPayload, gửi kèm body của /api/chat (webContext).
 *
 * Thất bại ở bất kỳ bước nào KHÔNG chặn việc gửi tin nhắn — chỉ trả payload
 * thiếu phần tương ứng; caller tự quyết tiếp tục hay báo notice.
 */

import { useAppStore } from '@/lib/store';
import type { WebContextPayload, WebPageExtract, WebSearchHit } from '@/lib/web-context';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PASTED_URLS = 2;
const MAX_AUTO_FETCH = 2;

/** Gom access-code/provider key giống useChat để đi qua cùng tầng xác thực. */
function authHeaders(): Record<string, string> {
  const s = useAppStore.getState();
  const headers: Record<string, string> = {};
  if (s.settings.accessCode) headers['x-access-code'] = s.settings.accessCode;
  const p = s.activeProvider;
  if (p?.baseUrl) {
    headers['x-api-base'] = p.baseUrl;
    if (p.apiKey) headers['x-api-key'] = p.apiKey;
  } else if (s.settings.apiKey) {
    headers['x-api-key'] = s.settings.apiKey;
  }
  return headers;
}

export class WebSearchClientError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'WebSearchClientError';
  }
}

async function postWeb(body: unknown): Promise<Response | null> {
  try {
    return await fetch('/api/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

export async function searchWeb(query: string, count?: number): Promise<WebSearchHit[]> {
  const res = await postWeb({ op: 'search', query, ...(count ? { count } : {}) });
  if (!res) {
    throw new WebSearchClientError('Không kết nối được dịch vụ tra cứu web.', 'NETWORK');
  }
  const j = (await res.json().catch(() => null)) as
    | { results?: WebSearchHit[]; error?: string; code?: string }
    | null;
  if (!res.ok) {
    throw new WebSearchClientError(
      j?.error || 'Dịch vụ tra cứu web hiện không khả dụng.',
      j?.code,
    );
  }
  if (!j) {
    throw new WebSearchClientError('Phản hồi tra cứu web không hợp lệ.', 'BAD_RESPONSE');
  }
  return Array.isArray(j?.results) ? j.results : [];
}

export async function fetchPage(url: string): Promise<WebPageExtract | null> {
  const res = await postWeb({ op: 'fetch', url });
  if (!res || !res.ok) return null;
  const j = (await res.json().catch(() => null)) as Omit<WebPageExtract, never> | null;
  if (!j || typeof j.url !== 'string' || typeof j.content !== 'string') return null;
  return { url: j.url, title: j.title ?? '', content: j.content };
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

/** Trích URL người dùng dán trong tin nhắn, cắt dấu câu đuôi câu. */
export function extractPastedUrls(text: string, selfHost: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  const out: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?)\]]+$/, '');
    let host = '';
    try {
      host = new URL(cleaned).hostname;
    } catch {
      continue;
    }
    if (!host || host === selfHost) continue;
    if (out.includes(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= MAX_PASTED_URLS) break;
  }
  return out;
}

/**
 * Điểm vào chính: gọi trước handleSubmit khi toggle web đang bật.
 * Trả null khi không thu được gì đáng gửi (search hỏng + không có URL).
 */
export async function gatherWebContext(messageText: string): Promise<WebContextPayload | null> {
  const query = messageText.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!query) return null;

  const [searchOutcome, pastedOutcome] = await Promise.allSettled([
    searchWeb(query),
    Promise.resolve(
      typeof location !== 'undefined'
        ? extractPastedUrls(messageText, location.host)
        : [],
    ),
  ]);
  const hits =
    searchOutcome.status === 'fulfilled'
      ? searchOutcome.value
      : [];
  const pastedUrls = pastedOutcome.status === 'fulfilled' ? pastedOutcome.value : [];

  if (hits.length === 0 && pastedUrls.length === 0 && searchOutcome.status === 'rejected') {
    throw searchOutcome.reason instanceof Error
      ? searchOutcome.reason
      : new WebSearchClientError('Tra cứu web thất bại.', 'SEARCH_FAILED');
  }

  // Trang cần đọc nguyên văn: URL dán trực tiếp ưu tiên, sau đó mới tới
  // top kết quả tìm kiếm. Tổng cộng vẫn ≤ 2 trang để giữ ngân sách context.
  let pageUrls = pastedUrls.slice(0, MAX_AUTO_FETCH);
  if (pageUrls.length === 0) {
    pageUrls = hits.map((h) => h.url).slice(0, MAX_AUTO_FETCH);
  }

  const settled = await Promise.allSettled(pageUrls.map((u) => fetchPage(u)));
  const pages = settled
    .flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []))
    .filter((p) => p.content.trim().length > 0);

  if (hits.length === 0 && pages.length === 0) return null;
  return { query, hits, pages };
}
