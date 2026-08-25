import { z } from 'zod';
import { extractText, getDocumentProxy } from 'unpdf';
import {
  checkSameOrigin,
  checkRateLimit,
  rateLimitIdentity,
  timingSafeEqual,
  verifyAccessAuth,
} from '@/lib/security';

/**
 * POST /api/pdf — trích text từ file PDF (data URL) cho tính năng "chat với
 * PDF". Client đọc file thành data URL rồi POST lên đây; server trả về văn bản
 * đã trích để gửi kèm body /api/chat (pdfContexts).
 *
 * Vì sao là route riêng: pdf.js cần worker + font data — chạy server một chỗ
 * gọn hơn bundle vào client ~1MB JS; đồng thời kiểm soát trần kích thước/tỷ lệ
 * ký tự tại một cửa như /api/web.
 */

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 9 * 1024 * 1024; // PDF base64 ≤ ~6.7MB binary
const MAX_PDF_PAGES = 60;
const MAX_TEXT_CHARS = 30_000;

const BodySchema = z.object({
  /** Data URL `data:application/pdf;base64,...` — client FileReader sinh ra. */
  dataUrl: z.string().max(MAX_BODY_BYTES),
  name: z.string().max(200).optional(),
});

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

export async function POST(req: Request) {
  const requestId = newRequestId();

  try {
    if (!checkSameOrigin(req)) {
      return jsonError(requestId, 403, 'ORIGIN_FORBIDDEN', 'Truy cập bị từ chối.');
    }

    const rl = checkRateLimit(`pdf:${rateLimitIdentity(req)}`, 20, 60_000);
    if (!rl.ok) {
      return Response.json(
        { error: 'Bạn đang xử lý PDF quá nhanh.', code: 'RATE_LIMITED', requestId },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      );
    }

    const auth = verifyAccessAuth(req);
    if (!auth.ok) {
      const expected = (process.env.ACCESS_CODE ?? '').trim();
      const alt = req.headers.get('x-access-code')?.trim() ?? '';
      if (!(expected && alt && timingSafeEqual(alt, expected))) {
        return jsonError(requestId, auth.status ?? 401, 'UNAUTHORIZED', auth.error ?? 'Unauthorized');
      }
    }

    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > MAX_BODY_BYTES) {
      return jsonError(requestId, 413, 'PAYLOAD_TOO_LARGE', 'PDF vượt giới hạn ~6MB.');
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError(requestId, 400, 'BAD_JSON', 'JSON payload không hợp lệ.');
    }

    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(requestId, 400, 'BAD_SCHEMA', 'Cấu trúc dữ liệu không hợp lệ.');
    }

    const m = /^data:(application\/pdf);base64,([A-Za-z0-9+/=\s]+)$/i.exec(parsed.data.dataUrl);
    if (!m) {
      return jsonError(requestId, 415, 'UNSUPPORTED_TYPE', 'Chỉ hỗ trợ file PDF.');
    }

    const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return jsonError(requestId, 400, 'NOT_PDF', 'File không phải PDF hợp lệ.');
    }

    // unpdf bọc pdf.js bản serverless: không cần worker thủ công.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PDF_PAGES) {
      return jsonError(
        requestId,
        413,
        'TOO_MANY_PAGES',
        `PDF dài ${pdf.numPages} trang — giới hạn ${MAX_PDF_PAGES} trang.`,
      );
    }

    const { text } = await extractText(pdf, { mergePages: true });
    const merged = (Array.isArray(text) ? text.join('\n\n') : String(text ?? '')).trim();

    if (!merged || merged.replace(/\s/g, '').length < 20) {
      return jsonError(
        requestId,
        422,
        'NO_TEXT_LAYER',
        'PDF không có lớp chữ (có thể là file scan ảnh) — cần OCR mới đọc được.',
      );
    }

    const truncated = merged.length > MAX_TEXT_CHARS;
    return Response.json({
      name: parsed.data.name?.slice(0, 200) ?? '',
      pages: pdf.numPages,
      content: truncated ? merged.slice(0, MAX_TEXT_CHARS) : merged,
      truncated,
      requestId,
    });
  } catch (err) {
    console.error(`[pdf:${requestId}] unexpected:`, err instanceof Error ? err.message : err);
    return jsonError(requestId, 500, 'INTERNAL', 'Không xử lý được PDF này.');
  }
}
