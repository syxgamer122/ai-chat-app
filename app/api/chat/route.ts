import { createOpenAI } from '@ai-sdk/openai';
import {
  convertToCoreMessages,
  streamText,
  createDataStreamResponse,
  formatDataStreamPart,
  APICallError,
  type CoreMessage,
} from 'ai';
import { z } from 'zod';
import { getKeyCandidates, markKeyFailure, markKeySuccess, getKeyLabel } from '@/lib/api-keys';
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID } from '@/lib/models';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

export const runtime = 'edge';
export const maxDuration = 60;

const MAX_BODY_BYTES = 4.5 * 1024 * 1024; // 4.5MB Vercel platform limit

const BodySchema = z.object({
  messages: z.array(z.any()).min(1).max(500),
  model: z.string().min(1).max(64).optional(),
  temperature: z.number().min(0).max(2).optional(),
  system: z.string().max(8000).optional(),
});

const REASONING_MODELS = new Set([
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.5',
  'o1',
  'o1-mini',
  'o1-preview',
  'o3-mini',
]);

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

function normalize(messages: CoreMessage[]): CoreMessage[] {
  const cleaned = messages.filter((m) => {
    const parts = toParts(m.content) as any[];
    return parts.some((p) => p.type !== 'text' || (p.text ?? '').trim().length > 0);
  });
  const firstUser = cleaned.findIndex((m) => m.role === 'user');
  if (firstUser === -1) return [];
  return firstUser === 0 ? cleaned : cleaned.slice(firstUser);
}

export async function POST(req: Request) {
  try {
    const customKey = req.headers.get('x-api-key')?.trim();

    if (!customKey) {
      const clientIp = getClientIp(req);
      const { allowed, resetInSec } = checkRateLimit(clientIp, 30, 60_000);
      if (!allowed) {
        return Response.json(
          { error: `Bạn đang gửi tin nhắn quá nhanh. Vui lòng thử lại sau ${resetInSec} giây.` },
          { status: 429, headers: { 'Retry-After': String(resetInSec) } },
        );
      }
    }

    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > MAX_BODY_BYTES) {
      return Response.json({ error: 'Dữ liệu tin nhắn vượt quá giới hạn 10MB.' }, { status: 413 });
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

    const targetModel = model ?? DEFAULT_MODEL_ID;
    if (!ALLOWED_MODEL_IDS.has(targetModel)) {
      return Response.json(
        { error: `Model '${targetModel}' không được hỗ trợ. Vui lòng chọn model trong danh sách.` },
        { status: 400 },
      );
    }

    const isReasoning = REASONING_MODELS.has(targetModel);

    // Tự động cắt context để giữ lại 50 tin nhắn gần nhất (tránh vượt token budget)
    const contextMessages = messages.slice(-50);

    let core: CoreMessage[];
    try {
      core = mergeSameRole(normalize(convertToCoreMessages(contextMessages as any)));
    } catch {
      return Response.json(
        { error: 'Dữ liệu tin nhắn hoặc file đính kèm không đúng định dạng.' },
        { status: 400 },
      );
    }

    if (!core.length) {
      return Response.json({ error: 'Không có nội dung tin nhắn để gửi.' }, { status: 400 });
    }

    const candidateKeys = customKey ? [customKey] : getKeyCandidates().slice(0, 3);

    if (!candidateKeys.length) {
      return Response.json(
        { error: 'Toàn bộ API Key của hệ thống đang tạm ngưng hoặc chưa được cấu hình. Vui lòng kiểm tra lại biến môi trường OPENAI_API_KEYS.' },
        { status: 503, headers: { 'Retry-After': '60' } },
      );
    }

    const isAbort = (e: unknown) =>
      (e as any)?.name === 'AbortError' || (e as any)?.code === 'ERR_CANCELED' || req.signal.aborted;

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

            // Reasoning models không chấp nhận temperature != 1 hoặc max_tokens
            const result = streamText({
              model: openai(targetModel),
              messages: core,
              system: system?.trim() ? system : undefined,
              abortSignal: req.signal,
              ...(isReasoning
                ? {}
                : {
                    temperature: Math.min(2, Math.max(0, temperature ?? 0.7)),
                    maxTokens: 4096,
                  }),
            });

            const reader = result.fullStream.getReader();
            let emitted = false;

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  markKeySuccess(selectedKey);
                  return;
                }

                if (value.type === 'error') {
                  throw value.error;
                }

                if (value.type === 'text-delta') {
                  emitted = true;
                  dataStream.write(formatDataStreamPart('text', value.textDelta));
                } else if (value.type === 'reasoning') {
                  emitted = true;
                  dataStream.write(formatDataStreamPart('reasoning', value.textDelta));
                } else if (value.type === 'source') {
                  emitted = true;
                  dataStream.write(formatDataStreamPart('source', value.source));
                }
              }
            } catch (streamErr) {
              void reader.cancel();
              if (isAbort(streamErr)) return;
              lastError = streamErr;
              markKeyFailure(selectedKey, getStatusCode(streamErr));
              console.warn(`[Failover] ${getKeyLabel(selectedKey)}:`, sanitizeErrorMessage(streamErr));
              // Nếu đã stream một phần nội dung ra client thì không thể đổi key giữa chừng
              if (emitted) {
                throw streamErr;
              }
            }
          } catch (initErr) {
            if (isAbort(initErr)) return;
            lastError = initErr;
            markKeyFailure(selectedKey, getStatusCode(initErr));
            console.warn(`[Failover init] ${getKeyLabel(selectedKey)}:`, sanitizeErrorMessage(initErr));
          }
        }

        throw lastError;
      },
      onError: sanitizeErrorMessage, // Đổi từ getErrorMessage -> onError để hiển thị lỗi thật từ provider ra UI
    });
  } catch (error: any) {
    console.error('Chat API Fatal Error:', sanitizeErrorMessage(error));
    return Response.json(
      { error: sanitizeErrorMessage(error) },
      { status: 500 },
    );
  }
}
