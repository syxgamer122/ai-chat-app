/**
 * POST /api/vision — mô tả MỘT ảnh data-URL bằng model vision của PROVIDER
 * ACTIVE của người dùng (gateway tương thích OpenAI).
 *
 * Phục vụ agent coding: khi fs_read trúng file ảnh trong workspace, client
 * đọc bytes thành data URL rồi gọi route này để lấy bản mô tả text thay cho
 * nội dung nhị phân. BYOK như mọi route LLM khác: client gắn headers
 * `x-api-key` + `x-api-base` (provider active) và gửi `model` vision trong
 * body — server KHÔNG giữ riêng key vision nào nữa.
 *
 * An toàn: cùng chuẩn security với /api/title (same-origin, rate limit,
 * access auth) + trần payload chặt (chặn ở mức thấp vì fs_read chỉ cần
 * "nhìn" ảnh, không phải xử lý nguyên bản chất lượng cao).
 */

import { z } from 'zod';
import { describeImageDataUrl } from '@/lib/vision-bridge';
import { ACTIVE_MODEL_BODY_FIELD } from '@/lib/aux-llm-chain';
import { validateProviderBaseUrl } from '@/lib/provider-url';
import { sharedFreeBudget, acquireUpstreamSlot } from '@/lib/upstream-queue';
import {
  checkRateLimit,
  rateLimitHeaders,
  rateLimitIdentity,
  verifySameOrigin,
  verifyAccessAuth,
} from '@/lib/security';

export const runtime = 'nodejs';

const NO_STORE = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, max-age=0',
} as const;

/** Trần base64 của data URL (~6MB) → ảnh gốc ~4.5MB. */
const MAX_DATA_URL_CHARS = 6_400_000;

const VisionSchema = z.object({
  dataUrl: z
    .string()
    .min(24)
    .max(MAX_DATA_URL_CHARS)
    .regex(/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/),
  /* Model vision client chọn từ danh sách model của provider. Dùng field dùng
     chung với title/compact/orchestrate (cùng regex + trần 120) — model rác bị
     `.catch(undefined)` biến thành "thiếu model", nên client nhận đúng lời
     khuyên "hãy chọn model xem được ảnh" thay vì `bad_request` mơ hồ. */
  model: ACTIVE_MODEL_BODY_FIELD,
});

async function readJsonWithLimit(req: Request, maxBytes: number): Promise<unknown> {
  if (!req.body) throw new Error('Empty request body.');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Payload too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

function fail(error: string, status: number, extraHeaders?: Record<string, string>) {
  return Response.json({ ok: false as const, error }, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

export async function POST(req: Request) {
  if (!verifySameOrigin(req)) return fail('forbidden', 403);

  const limit = checkRateLimit(`vision:${rateLimitIdentity(req)}`, 20, 60_000);
  if (!limit.ok) {
    return fail('rate_limited', 429, rateLimitHeaders(limit));
  }
  const auth = verifyAccessAuth(req);
  if (!auth.ok) return fail('unauthorized', 401);

  let json: unknown;
  try {
    json = await readJsonWithLimit(req, MAX_DATA_URL_CHARS + 65_536);
  } catch {
    return fail('bad_request', 400);
  }
  const parsed = VisionSchema.safeParse(json);
  if (!parsed.success) return fail('bad_request', 400);

  // Server không đoán được model nào của gateway xem được ảnh — client PHẢI
  // chọn (từ danh sách model provider). Thiếu thì hướng dẫn rõ, đừng để
  // provider trả lỗi mơ hồ "model not found" gây khó hiểu.
  if (!parsed.data.model) {
    return fail(
      'Thiếu model vision — hãy chọn một model hỗ trợ xem ảnh của Nhà cung cấp đang bật rồi thử lại.',
      400,
    );
  }

  /* BYOK: đọc headers provider active như /api/title (không dùng getKeyCandidates
     — vision không có provider active thì 503, không rơi về pool key server). */
  const rawCustomKey = req.headers.get('x-api-key')?.trim();
  const rawProviderBase = req.headers.get('x-api-base')?.trim() || undefined;
  const providerBaseCheck = rawProviderBase
    ? validateProviderBaseUrl(rawProviderBase)
    : undefined;
  /* Base CÓ nhưng sai định dạng → 400 như /api/compact và /api/orchestrate.
     Bỏ qua im lặng là lỗi BẢO MẬT: providerBase thành undefined nhưng key của
     người dùng vẫn được gửi tới OPENAI_BASE_URL (hoặc api.openai.com) — tức
     một host KHÁC ý định của họ. */
  if (providerBaseCheck && !providerBaseCheck.ok) {
    return fail(`Địa chỉ Nhà cung cấp không hợp lệ: ${providerBaseCheck.error}`, 400);
  }
  const providerBase = providerBaseCheck?.ok ? providerBaseCheck.url : undefined;
  const customKey =
    rawCustomKey && rawCustomKey.length <= 256 && /^[\x21-\x7E]+$/.test(rawCustomKey)
      ? rawCustomKey
      : undefined;

  // Chưa cấu hình provider nào (không key lẫn không base) → 503: route này
  // không có nguồn mô tả ảnh nào khác để fallback.
  if (!providerBase && !customKey) {
    return fail(
      'Chưa cấu hình Nhà cung cấp (provider) — hãy vào Cài đặt để thêm địa chỉ và API key của provider.',
      503,
    );
  }

  const upstreamBase = providerBase ?? process.env.OPENAI_BASE_URL;
  /* Gateway free ngân sách CHUNG theo IP server: mô tả ảnh phải xếp hàng
     giống /api/chat và /api/compact. Bỏ qua hàng đợi ở đây là nhảy hàng —
     một lượt fs_read trúng ảnh sẽ đẩy lượt chat của người khác vào 429.
     Xếp hàng đặt SAU mọi lớp kiểm tra: chiếm slot rồi mới phát hiện request
     rác là ném ngân sách của người khác đi.
     Ghi chú: describeImageDataUrl có thể retry tới 3 lượt fetch nhưng chỉ
     chiếm 1 slot — chấp nhận như /api/chat (một request retry nội bộ). */
  if (upstreamBase && sharedFreeBudget(upstreamBase)) {
    const slot = await acquireUpstreamSlot(upstreamBase);
    if (!slot.ok) {
      return fail(
        `Gateway đang đông (giới hạn chung của nhà cung cấp free) — thử lại sau ~${slot.retryAfterSec} giây nhé.`,
        429,
        { 'Retry-After': String(slot.retryAfterSec) },
      );
    }
  }

  try {
    const description = await describeImageDataUrl(parsed.data.dataUrl, {
      // Provider khai base nhưng không kèm key → vẫn thử với key ảo (giống
      // /api/title): gateway không cần key thì chạy được, cần key thì trả 401
      // và mô tả thành null — client nhận lỗi rõ ràng.
      apiKey: customKey ?? 'provider-no-key',
      baseUrl: upstreamBase,
      model: parsed.data.model,
      // Nhận req.signal để client hủy (agent bị stop) thì dừng gọi provider.
      // generateText luôn đính kèm signal timeout của lượt gọi trong init.signal
      // nên phải GHÉP hai signal (AbortSignal.any) thay vì chọn một bên.
      fetchImpl: ((input, init) => {
        const inner = init?.signal;
        const merged = inner ? AbortSignal.any([inner, req.signal]) : req.signal;
        return fetch(input, { ...init, signal: merged });
      }) as typeof fetch,
    });
    if (!description) {
      return fail(
        'Nhà cung cấp không trả được mô tả cho ảnh này (model không hỗ trợ ảnh, định dạng không đọc được, hoặc API key sai).',
        502,
      );
    }
    return Response.json(
      { ok: true as const, description },
      { headers: { ...NO_STORE, ...rateLimitHeaders(limit) } },
    );
  } catch {
    return fail('Lỗi khi gọi model vision của Nhà cung cấp.', 502);
  }
}
