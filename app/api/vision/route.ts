/**
 * POST /api/vision — mô tả MỘT ảnh data-URL bằng Gemini vision.
 *
 * Phục vụ agent coding: khi fs_read trúng file ảnh trong workspace, client
 * đọc bytes thành data URL rồi gọi route này để lấy bản mô tả text thay cho
 * nội dung nhị phân. Key Gemini chỉ tồn tại phía server (env) nên client
 * không thể tự gọi — đi qua đây là bắt buộc.
 *
 * An toàn: cùng chuẩn security với /api/title (same-origin, rate limit,
 * access auth) + trần payload chặt (ảnh inline Gemini giới hạn ~20MB/request,
 * chặn ở mức thấp hơn nhiều vì fs_read chỉ cần "nhìn" ảnh, không phải xử lý
 * nguyên bản chất lượng cao).
 */

import { z } from 'zod';
import { describeImageDataUrl } from '@/lib/vision-bridge';
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

  const geminiApiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (!geminiApiKey) {
    return fail('Máy chủ chưa cấu hình GEMINI_API_KEY — không mô tả được ảnh.', 503);
  }

  try {
    const description = await describeImageDataUrl(parsed.data.dataUrl, {
      apiKey: geminiApiKey,
      geminiModel: process.env.GEMINI_VISION_MODEL || undefined,
      // Nhận req.signal để client hủy (agent bị stop) thì dừng gọi Gemini.
      fetchImpl: ((input, init) =>
        fetch(input, { ...init, signal: init?.signal ?? req.signal })) as typeof fetch,
    });
    if (!description) return fail('Gemini không trả được mô tả cho ảnh này.', 502);
    return Response.json({ ok: true as const, description }, { headers: { ...NO_STORE, ...rateLimitHeaders(limit) } });
  } catch {
    return fail('Lỗi khi gọi Gemini vision.', 502);
  }
}
