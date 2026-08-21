import { createOpenAI } from '@ai-sdk/openai';
import {
  convertToCoreMessages,
  streamText,
  createDataStreamResponse,
  APICallError,
  type CoreMessage,
} from 'ai';
import { z } from 'zod';
import { getKeyCandidates, markKeyFailure, markKeySuccess, getKeyLabel } from '@/lib/api-keys';
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID } from '@/lib/models';

export const runtime = 'edge';
export const maxDuration = 60;

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB limit

const BodySchema = z.object({
  messages: z.array(z.any()).min(1).max(200),
  model: z.string().min(1).max(64).optional(),
  temperature: z.number().min(0).max(2).optional(),
  system: z.string().max(8000).optional(),
});

const SECRET_REGEX = /\b(sk|sk-proj|sk-ant|Bearer)\s*[:=]?\s*[A-Za-z0-9_\-]{4,}/gi;

function sanitizeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? 'Lỗi từ AI Provider.');
  return raw.replace(SECRET_REGEX, '[redacted]').slice(0, 500);
}

function getStatusCode(e: unknown): number | undefined {
  if (APICallError.isInstance(e)) return e.statusCode;
  if (typeof e === 'object' && e !== null && 'status' in e && typeof (e as any).status === 'number') {
    return (e as any).status;
  }
  return undefined;
}

const toParts = (content: CoreMessage['content']) =>
  typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;

/** Gộp các message liên tiếp cùng role ở TẦNG PARTS -> không phá ảnh/file. */
function mergeSameRole(messages: CoreMessage[]): CoreMessage[] {
  return messages.reduce<CoreMessage[]>((acc, cur) => {
    const last = acc[acc.length - 1];
    const mergeable =
      last && last.role === cur.role && (cur.role === 'user' || cur.role === 'assistant');

    if (!mergeable) {
      acc.push({ ...cur });
      return acc;
    }

    (last as any).content = [
      ...(toParts(last.content) as any[]),
      { type: 'text', text: '\n\n' },
      ...(toParts(cur.content) as any[]),
    ];
    return acc;
  }, []);
}

/** Bỏ message rỗng và mọi message trước lượt user đầu tiên. */
function normalize(messages: CoreMessage[]): CoreMessage[] {
  const cleaned = messages.filter((m) => {
    const parts = toParts(m.content) as any[];
    return parts.some((p) => p.type !== 'text' || (p.text ?? '').trim().length > 0);
  });
  const firstUser = cleaned.findIndex((m) => m.role === 'user');
  return firstUser <= 0 ? cleaned : cleaned.slice(firstUser);
}

export async function POST(req: Request) {
  try {
    // 1. Kiểm tra kích thước payload
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > MAX_BODY_BYTES) {
      return Response.json({ error: 'Payload vượt quá giới hạn 10MB.' }, { status: 413 });
    }

    let jsonBody: unknown;
    try {
      jsonBody = await req.json();
    } catch {
      return Response.json({ error: 'JSON payload không hợp lệ.' }, { status: 400 });
    }

    const parsed = BodySchema.safeParse(jsonBody);
    if (!parsed.success) {
      return Response.json({ error: 'Cấu trúc dữ liệu không hợp lệ.', details: parsed.error.issues }, { status: 400 });
    }

    const { messages, model, temperature, system } = parsed.data;

    // 2. Kiểm tra Model hợp lệ
    const targetModel = model ?? DEFAULT_MODEL_ID;
    if (!ALLOWED_MODEL_IDS.has(targetModel)) {
      return Response.json(
        { error: `Model '${targetModel}' không được hỗ trợ. Vui lòng chọn model trong danh sách.` },
        { status: 400 },
      );
    }

    // 3. Convert CoreMessages an toàn
    let core: CoreMessage[];
    try {
      core = mergeSameRole(normalize(convertToCoreMessages(messages as any)));
    } catch (convErr) {
      return Response.json(
        { error: 'Dữ liệu tin nhắn hoặc file đính kèm không đúng định dạng.' },
        { status: 400 },
      );
    }

    if (!core.length) {
      return Response.json({ error: 'Không có nội dung tin nhắn để gửi.' }, { status: 400 });
    }

    // 4. Lấy danh sách key ứng viên (Ưu tiên Custom Key của user nếu có)
    const customKey = req.headers.get('x-api-key')?.trim();
    const candidateKeys = customKey ? [customKey] : getKeyCandidates().slice(0, 3);

    if (!candidateKeys.length) {
      return Response.json(
        { error: 'Toàn bộ API Key của hệ thống đang tạm ngưng hoặc chưa được cấu hình. Vui lòng thử lại sau ít phút.' },
        { status: 503, headers: { 'Retry-After': '60' } },
      );
    }

    // 5. Thực thi stream với cơ chế Server-side Failover & DataStream
    return createDataStreamResponse({
      headers: { 'Cache-Control': 'no-store, no-transform' },
      execute: async (dataStream) => {
        let lastError: unknown;

        for (const selectedKey of candidateKeys) {
          try {
            const openai = createOpenAI({
              apiKey: selectedKey,
              baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            });

            const result = streamText({
              model: openai(targetModel),
              messages: core,
              temperature: Math.min(2, Math.max(0, temperature ?? 0.7)),
              system: system?.trim() ? system : undefined,
              maxTokens: 4096,
              abortSignal: req.signal,
              onError: ({ error }) => {
                console.error(`[streamText ${getKeyLabel(selectedKey)}]`, sanitizeErrorMessage(error));
                markKeyFailure(selectedKey, getStatusCode(error));
              },
            });

            result.mergeIntoDataStream(dataStream);
            markKeySuccess(selectedKey);
            return; // Thành công bắt đầu stream -> kết thúc execute
          } catch (err) {
            lastError = err;
            console.warn(`[Failover] ${getKeyLabel(selectedKey)} gặp lỗi khởi tạo:`, sanitizeErrorMessage(err));
            markKeyFailure(selectedKey, getStatusCode(err));
          }
        }

        throw lastError;
      },
      getErrorMessage: sanitizeErrorMessage,
    });
  } catch (error: any) {
    console.error('Chat API Fatal Error:', sanitizeErrorMessage(error));
    return Response.json(
      { error: sanitizeErrorMessage(error) },
      { status: 500 },
    );
  }
}
