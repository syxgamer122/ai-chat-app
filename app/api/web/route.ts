import { z } from 'zod';
import {
  checkSameOrigin,
  checkRateLimit,
  rateLimitIdentity,
  timingSafeEqual,
  verifyAccessAuth,
} from '@/lib/security';
import {
  WebOpError,
  capHits,
  fetchReadablePage,
  searchWeb,
} from '@/lib/web-backend';
import { WEB_LIMITS } from '@/lib/web-context';

/**
 * POST /api/web — proxy tìm kiếm + đọc trang cho tính năng "Tìm kiếm web".
 *
 * Vì sao là route riêng chứ không để client gọi thẳng DuckDuckGo: CORS chặn
 * mọi request trình duyệt tới công cụ tìm kiếm; và đọc trang bất kỳ bắt buộc
 * phải đi server để né mixed-content + SSRF được kiểm soát tại một chỗ.
 *
 * Toàn bộ cơ chế fetch/search sống ở lib/web-backend — cùng đường ống với
 * các agentic tools trong /api/chat, sửa một chỗ chạy cả hai.
 *
 * Runtime nodejs (mặc định) — edge đã bị Next 16 deprecate, không thêm nợ mới.
 */

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 32 * 1024;

const BodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('search'),
    query: z.string().min(1).max(WEB_LIMITS.queryChars),
    count: z.number().int().min(1).max(WEB_LIMITS.maxHits).optional(),
  }),
  z.object({
    op: z.literal('fetch'),
    url: z.string().min(1).max(WEB_LIMITS.hitUrlChars),
  }),
]);

function newRequestId(): string {
  try {
    return globalThis.crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

function jsonError(requestId: string, status: number, code: string, error: string) {
  return Response.json({ error, code, requestId }, { status });
}

async function readJsonWithLimit(req: Request, maxBytes: number): Promise<unknown> {
  if (!req.body) throw new Error('Empty request body.');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        overflow = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (overflow) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (overflow) throw new RangeError('PAYLOAD_TOO_LARGE');
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

export async function POST(req: Request) {
  const requestId = newRequestId();

  try {
    /* --- Same-Origin --- */
    if (!checkSameOrigin(req)) {
      return jsonError(requestId, 403, 'ORIGIN_FORBIDDEN', 'Truy cập bị từ chối: Origin không được phép.');
    }

    /* --- Rate limit TRƯỚC auth để đoán sai mã cũng tốn quota. Một lượt gửi
       bật web tốn ~3 call (1 search + ≤2 fetch) nên hạn mức rộng hơn chat. --- */
    const rl = checkRateLimit(`web:${rateLimitIdentity(req)}`, 90, 60_000);
    if (!rl.ok) {
      return Response.json(
        { error: 'Bạn đang tra cứu web quá nhanh.', code: 'RATE_LIMITED', requestId },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      );
    }

    /* --- Access code: nhận cả Authorization Bearer lẫn x-access-code
       (client useChat gửi header x-access-code, không phải Bearer). --- */
    const auth = verifyAccessAuth(req);
    if (!auth.ok) {
      const expected = (process.env.ACCESS_CODE ?? '').trim();
      const alt = req.headers.get('x-access-code')?.trim() ?? '';
      if (!(expected && alt && timingSafeEqual(alt, expected))) {
        return jsonError(requestId, auth.status ?? 401, 'UNAUTHORIZED', auth.error ?? 'Unauthorized');
      }
    }

    /* --- Body --- */
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > MAX_BODY_BYTES) {
      return jsonError(requestId, 413, 'PAYLOAD_TOO_LARGE', 'Payload vượt giới hạn 32KB.');
    }
    let jsonBody: unknown;
    try {
      jsonBody = await readJsonWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonError(requestId, 413, 'PAYLOAD_TOO_LARGE', 'Payload vượt giới hạn 32KB.');
      }
      return jsonError(requestId, 400, 'BAD_JSON', 'JSON payload không hợp lệ.');
    }

    const parsed = BodySchema.safeParse(jsonBody);
    if (!parsed.success) {
      return jsonError(requestId, 400, 'BAD_SCHEMA', 'Cấu trúc dữ liệu không hợp lệ.');
    }

    /* --- op: search --- */
    if (parsed.data.op === 'search') {
      const count = parsed.data.count ?? WEB_LIMITS.maxHits;
      try {
        const { hits } = await searchWeb(parsed.data.query);
        return Response.json({
          results: capHits(hits, count),
          requestId,
        });
      } catch (e) {
        console.warn(`[web:${requestId}] search hết.engine: ${e instanceof Error ? e.message : e}`);
        return Response.json(
          {
            results: [],
            error: 'Không tra cứu được công cụ tìm kiếm lúc này.',
            code: 'SEARCH_UNAVAILABLE',
            requestId,
          },
          { status: 502 },
        );
      }
    }

    /* --- op: fetch --- */
    try {
      const page = await fetchReadablePage(parsed.data.url);
      return Response.json({
        url: page.url,
        title: page.title,
        content: page.content,
        truncated: page.truncated,
        requestId,
      });
    } catch (e) {
      if (e instanceof WebOpError) {
        return jsonError(requestId, e.status, e.code, e.message);
      }
      if (e instanceof Error && e.name === 'TimeoutError') {
        return jsonError(requestId, 504, 'WEB_UPSTREAM_TIMEOUT', 'Tải trang quá 12 giây, đã hủy.');
      }
      console.warn(`[web:${requestId}] fetch lỗi:`, e instanceof Error ? e.message : e);
      return jsonError(requestId, 502, 'WEB_FETCH_FAILED', 'Không tải được trang này.');
    }
  } catch (err) {
    console.error(`[web:${requestId}] unexpected:`, err instanceof Error ? err.message : err);
    return jsonError(requestId, 500, 'INTERNAL', 'Lỗi không xác định ở /api/web.');
  }
}
