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
import {
  getKeyCandidates,
  markKeyFailure,
  markKeySuccess,
  getKeyLabel,
  isPermanentClientError,
} from '@/lib/api-keys';
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID, getModelConfig } from '@/lib/models';
import {
  checkRateLimit,
  getClientIp,
  verifySameOrigin,
  verifyAccessAuth,
} from '@/lib/security';

export const runtime = 'edge';
export const maxDuration = 120;

function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const validSignals = signals.filter(Boolean) as AbortSignal[];
  if (typeof (AbortSignal as any).any === 'function') {
    return (AbortSignal as any).any(validSignals);
  }

  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  for (const sig of validSignals) {
    if (sig.aborted) {
      onAbort();
      break;
    }
    sig.addEventListener('abort', onAbort, { once: true });
  }

  return controller.signal;
}

const MAX_BODY_BYTES = 4.5 * 1024 * 1024; // 4.5MB Vercel platform limit

const AttachmentSchema = z.object({
  name: z.string().max(255).optional(),
  contentType: z.string().max(128).optional(),
  url: z.string().max(6_000_000).optional(),
});

const MessageSchema = z.object({
  id: z.string().max(128).optional(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([
    z.string().max(200_000),
    z.array(z.record(z.string(), z.unknown())).max(100),
  ]),
  experimental_attachments: z.array(AttachmentSchema).max(4).optional(),
});

const BodySchema = z.object({
  id: z.string().max(256).optional(),
  messages: z.array(MessageSchema).min(1).max(100),
  model: z.string().min(1).max(64).optional(),
  temperature: z.number().min(0).max(2).optional(),
  system: z.string().max(8_000).optional(),
  data: z.unknown().optional(),
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

async function readJsonWithLimit(req: Request, maxBytes: number): Promise<unknown> {
  if (!req.body) {
    throw new Error('Empty request body.');
  }

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        throw new Response(
          JSON.stringify({ error: 'Dữ liệu tin nhắn vượt quá giới hạn 4.5MB.' }),
          {
            status: 413,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

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

export async function POST(req: Request) {
  try {
    // 1. Kiểm tra Same-Origin chống Open Proxy / Hotlinking từ bên ngoài
    if (!verifySameOrigin(req)) {
      return Response.json(
        { error: 'Truy cập bị từ chối do nguồn gốc yêu cầu (Origin) không hợp lệ.' },
        { status: 403 },
      );
    }

    // 2. Xác thực Mật khẩu bảo vệ (nếu máy chủ có cấu hình APP_ACCESS_PASSWORD)
    const auth = verifyAccessAuth(req);
    if (!auth.authorized) {
      return Response.json(
        { error: auth.reason || 'Unauthorized' },
        { status: 401 },
      );
    }

    // 3. Áp dụng Rate Limiting cho TẤT CẢ request (Kể cả có Custom Key cũng không được bypass hoàn toàn)
    const rawCustomKey = req.headers.get('x-api-key')?.trim();
    const customKey =
      rawCustomKey &&
      rawCustomKey.length >= 10 &&
      rawCustomKey.length <= 256 &&
      /^[A-Za-z0-9_.\-]+$/.test(rawCustomKey)
        ? rawCustomKey
        : undefined;

    const clientIp = getClientIp(req);
    const rateLimitCap = customKey ? 60 : 20; // 20 req/phút cho system pool, 60 req/phút cho BYOK
    const rateKey = `${customKey ? 'byok' : 'pool'}:${clientIp}`;

    const { allowed, resetInSec } = await checkRateLimit(rateKey, rateLimitCap, 60_000);
    if (!allowed) {
      return Response.json(
        { error: `Bạn đang gửi tin nhắn quá nhanh. Vui lòng thử lại sau ${resetInSec} giây.` },
        { status: 429, headers: { 'Retry-After': String(resetInSec) } },
      );
    }

    // 4. Kiểm tra và đọc stream payload có giới hạn byte nghiêm ngặt (chống chunked transfer bypass)
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > MAX_BODY_BYTES) {
      return Response.json({ error: 'Dữ liệu tin nhắn vượt quá giới hạn 4.5MB.' }, { status: 413 });
    }

    let jsonBody: unknown;
    try {
      jsonBody = await readJsonWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof Response) return error;
      return Response.json({ error: 'JSON payload không hợp lệ hoặc vượt quá kích thước cho phép.' }, { status: 400 });
    }

    const parsed = BodySchema.safeParse(jsonBody);
    if (!parsed.success) {
      return Response.json({ error: 'Cấu trúc dữ liệu không hợp lệ.', details: parsed.error.issues }, { status: 400 });
    }

    const { messages, model, temperature, system } = parsed.data;

    const selectedModelId = model ?? DEFAULT_MODEL_ID;
    if (!ALLOWED_MODEL_IDS.has(selectedModelId)) {
      return Response.json(
        { error: `Model '${selectedModelId}' không được hỗ trợ. Vui lòng chọn model trong danh sách.` },
        { status: 400 },
      );
    }

    const modelConfig = getModelConfig(selectedModelId);
    const targetModel = modelConfig.providerModel;
    const isReasoning = Boolean(modelConfig.isReasoning);
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

            const timeoutMs = isReasoning ? 110_000 : 55_000;
            const timeoutSignal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
            const abortSignal = combineAbortSignals(req.signal, timeoutSignal);

            const result = streamText({
              model: openai(targetModel),
              messages: core,
              system: system?.trim() ? system : undefined,
              abortSignal,
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

                switch (value.type) {
                  case 'text-delta':
                    emitted = true;
                    dataStream.write(formatDataStreamPart('text', value.textDelta));
                    break;

                  case 'reasoning':
                    emitted = true;
                    dataStream.write(formatDataStreamPart('reasoning', value.textDelta));
                    break;

                  case 'source':
                    emitted = true;
                    dataStream.write(formatDataStreamPart('source', value.source));
                    break;

                  case 'error':
                    throw value.error;

                  case 'finish':
                  case 'step-finish':
                    // Hoàn tất chu kỳ stream của step
                    break;

                  default:
                    // Bỏ qua an toàn các event khác (tool-call, metadata...) không làm crash stream
                    break;
                }
              }
            } catch (streamErr) {
              try {
                await reader.cancel();
              } catch {
                // Reader đã đóng hoặc provider đã abort
              }

              if (isAbort(streamErr)) return;
              lastError = streamErr;
              const status = getStatusCode(streamErr);
              markKeyFailure(selectedKey, status);
              console.warn(`[Failover] ${getKeyLabel(selectedKey)}:`, sanitizeErrorMessage(streamErr));

              if (emitted) {
                // Đã stream một phần nội dung: không đổi key giữa chừng.
                // Gửi data part có cấu trúc để client kết thúc stream êm đẹp và cho phép bấm Tạo lại.
                dataStream.write(
                  formatDataStreamPart('data', [
                    {
                      type: 'generation-error',
                      message: 'Kết nối AI bị gián đoạn giữa chừng. Bạn có thể bấm Tạo lại để sinh câu trả lời mới.',
                      recoverable: true,
                    },
                  ]),
                );
                dataStream.write(formatDataStreamPart('error', sanitizeErrorMessage(streamErr)));
                return;
              }

              // Nếu là lỗi vĩnh viễn từ client/params (400, 404, 422), ngắt ngay không thử key khác
              if (isPermanentClientError(status)) {
                throw streamErr;
              }
            } finally {
              try {
                reader.releaseLock();
              } catch {
                // Stream lock đã tự động được giải phóng
              }
            }
          } catch (initErr) {
            if (isAbort(initErr)) return;
            lastError = initErr;
            const status = getStatusCode(initErr);
            markKeyFailure(selectedKey, status);
            console.warn(`[Failover init] ${getKeyLabel(selectedKey)}:`, sanitizeErrorMessage(initErr));

            // Nếu là lỗi 400/404/422, ngắt ngay không thử key khác
            if (isPermanentClientError(status)) {
              throw initErr;
            }
          }
        }

        if (lastError instanceof Error) {
          throw lastError;
        }
        if (typeof lastError === 'string' && lastError.trim()) {
          throw new Error(lastError);
        }
        throw new Error('Toàn bộ API Key khả dụng đều không thể hoàn thành yêu cầu.');
      },
      onError: sanitizeErrorMessage,
    });
  } catch (error: any) {
    console.error('Chat API Fatal Error:', sanitizeErrorMessage(error));
    return Response.json(
      { error: sanitizeErrorMessage(error) },
      { status: 500 },
    );
  }
}
