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

/**
 * QUAN TRỌNG: chuyển từ 'edge' sang 'nodejs'.
 * - Edge KHÔNG áp dụng maxDuration, phải trả byte đầu trong 25s, stream tối đa 300s.
 * - Node runtime (fluid compute) cho phép tới 300s trên Hobby và truyền huỷ request đúng cách.
 */
export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

// Ngân sách stream phải NHỎ HƠN maxDuration để còn kịp ghi part kết thúc.
const STREAM_BUDGET_MS = 270_000;
// Không nhận được event nào trong khoảng này => coi như provider treo.
const IDLE_TIMEOUT_MS = 60_000;
// Nhịp giữ kết nối khi model đang "suy nghĩ" (chống proxy đóng connection idle).
const HEARTBEAT_MS = 10_000;

const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Helpers an toàn kiểu — chốt chặn số 1 cho lỗi "undefined"           */
/* ------------------------------------------------------------------ */

/** Trích text từ mọi biến thể event của AI SDK, luôn trả về string. */
function extractDelta(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part === null || part === undefined) return '';
  if (typeof part === 'object') {
    const p = part as Record<string, unknown>;
    for (const key of ['textDelta', 'text', 'delta', 'reasoning']) {
      const v = p[key];
      if (typeof v === 'string') return v;
    }
  }
  return '';
}

/** Chuỗi rác mà proxy hay sinh ra khi content rỗng. */
const SUSPECT_TOKEN = /^(?:undefined|null|NaN|\[object Object\])$/;

const SECRET_REGEX = /\b(sk|sk-proj|sk-ant|Bearer)\s*[:=]?\s*[A-Za-z0-9_\-]{4,}/gi;

function sanitizeErrorMessage(e: unknown): string {
  const raw =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : e && typeof e === 'object' && typeof (e as any).message === 'string'
          ? (e as any).message
          : '';
  const cleaned = raw.replace(SECRET_REGEX, '[redacted]').trim().slice(0, 500);
  // KHÔNG bao giờ trả chuỗi rỗng/undefined ra data stream.
  return cleaned || 'Lỗi không xác định từ AI Provider.';
}

function getStatusCode(e: unknown): number | undefined {
  if (APICallError.isInstance(e)) return e.statusCode;
  if (typeof e === 'object' && e !== null && 'status' in e && typeof (e as any).status === 'number') {
    return (e as any).status;
  }
  return undefined;
}

function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const valid = signals.filter(Boolean) as AbortSignal[];
  if (typeof (AbortSignal as any).any === 'function') return (AbortSignal as any).any(valid);

  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  for (const sig of valid) {
    if (sig.aborted) {
      onAbort();
      break;
    }
    sig.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

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
  if (!req.body) throw new Error('Empty request body.');

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
          { status: 413, headers: { 'Content-Type': 'application/json' } },
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

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

export async function POST(req: Request) {
  try {
    if (!verifySameOrigin(req)) {
      return Response.json(
        { error: 'Truy cập bị từ chối do nguồn gốc yêu cầu (Origin) không hợp lệ.' },
        { status: 403 },
      );
    }

    const auth = verifyAccessAuth(req);
    if (!auth.authorized) {
      return Response.json({ error: auth.reason || 'Unauthorized' }, { status: 401 });
    }

    const rawCustomKey = req.headers.get('x-api-key')?.trim();
    const customKey =
      rawCustomKey &&
      rawCustomKey.length >= 10 &&
      rawCustomKey.length <= 256 &&
      /^[A-Za-z0-9_.\-]+$/.test(rawCustomKey)
        ? rawCustomKey
        : undefined;

    const clientIp = getClientIp(req);
    const rateLimitCap = customKey ? 60 : 20;
    const rateKey = `${customKey ? 'byok' : 'pool'}:${clientIp}`;

    const { allowed, resetInSec } = await checkRateLimit(rateKey, rateLimitCap, 60_000);
    if (!allowed) {
      return Response.json(
        { error: `Bạn đang gửi tin nhắn quá nhanh. Vui lòng thử lại sau ${resetInSec} giây.` },
        { status: 429, headers: { 'Retry-After': String(resetInSec) } },
      );
    }

    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > MAX_BODY_BYTES) {
      return Response.json({ error: 'Dữ liệu tin nhắn vượt quá giới hạn 4.5MB.' }, { status: 413 });
    }

    let jsonBody: unknown;
    try {
      jsonBody = await readJsonWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof Response) return error;
      return Response.json(
        { error: 'JSON payload không hợp lệ hoặc vượt quá kích thước cho phép.' },
        { status: 400 },
      );
    }

    const parsed = BodySchema.safeParse(jsonBody);
    if (!parsed.success) {
      return Response.json(
        { error: 'Cấu trúc dữ liệu không hợp lệ.', details: parsed.error.issues },
        { status: 400 },
      );
    }

    const { messages, model, temperature, system } = parsed.data;

    const selectedModelId = model ?? DEFAULT_MODEL_ID;
    if (!ALLOWED_MODEL_IDS.has(selectedModelId)) {
      return Response.json(
        { error: `Model '${selectedModelId}' không được hỗ trợ.` },
        { status: 400 },
      );
    }

    const modelConfig = getModelConfig(selectedModelId);
    const targetModel = modelConfig.providerModel;
    const contextMessages = messages.slice(-50);

    const sanitizedContextMessages = contextMessages.map((msg) => {
      if (!msg.experimental_attachments?.length) return msg;
      return {
        ...msg,
        experimental_attachments: msg.experimental_attachments.filter((att) => {
          const url = att.url ?? '';
          return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:');
        }),
      };
    });

    let core: CoreMessage[];
    try {
      core = mergeSameRole(normalize(convertToCoreMessages(sanitizedContextMessages as any)));
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
        { error: 'Toàn bộ API Key của hệ thống đang tạm ngưng hoặc chưa được cấu hình.' },
        { status: 503, headers: { 'Retry-After': '60' } },
      );
    }

    return createDataStreamResponse({
      headers: {
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      },
      execute: async (dataStream) => {
        let lastError: unknown;

        /* ---------- Bộ ghi text có kiểm soát ---------- */
        let heldSuspect = '';   // giữ lại chunk nghi vấn ("undefined") tới khi có chunk sau
        let emittedChars = 0;

        const writeText = (raw: unknown, channel: 'text' | 'reasoning' = 'text') => {
          const delta = extractDelta(raw);
          if (!delta) return; // chặn '' | undefined | null ngay tại nguồn

          if (heldSuspect) {
            dataStream.write(formatDataStreamPart(channel, heldSuspect));
            emittedChars += heldSuspect.length;
            heldSuspect = '';
          }

          // Nếu chunk là đúng một token rác đứng riêng, giữ lại: chỉ ghi khi còn nội dung sau nó.
          if (SUSPECT_TOKEN.test(delta.trim()) && delta.trim() === delta) {
            heldSuspect = delta;
            return;
          }

          dataStream.write(formatDataStreamPart(channel, delta));
          emittedChars += delta.length;
        };

        const dropHeldSuspect = () => {
          heldSuspect = ''; // token rác ở cuối stream => loại bỏ hoàn toàn
        };

        const writeAnnotation = (payload: Record<string, unknown>) => {
          dataStream.write(formatDataStreamPart('message_annotations', [payload as any]));
        };

        const writeFinish = (
          finishReason: 'stop' | 'length' | 'error' | 'other' | 'content-filter' | 'tool-calls',
          usage?: { promptTokens: number; completionTokens: number },
        ) => {
          dataStream.write(
            formatDataStreamPart('finish_step', {
              finishReason,
              usage: usage ?? { promptTokens: 0, completionTokens: 0 },
              isContinued: false,
            }),
          );
          dataStream.write(
            formatDataStreamPart('finish_message', {
              finishReason,
              usage: usage ?? { promptTokens: 0, completionTokens: 0 },
            }),
          );
        };

        for (const selectedKey of candidateKeys) {
          // Watchdog riêng cho từng lần thử key
          const guard = new AbortController();
          let abortCause: 'budget' | 'idle' | null = null;
          let lastEventAt = Date.now();

          const budgetTimer = setTimeout(() => {
            abortCause = 'budget';
            guard.abort();
          }, STREAM_BUDGET_MS);

          const heartbeat = setInterval(() => {
            const idleFor = Date.now() - lastEventAt;
            if (idleFor > IDLE_TIMEOUT_MS) {
              abortCause = 'idle';
              guard.abort();
              return;
            }
            // ping giữ kết nối; client lọc bỏ part này
            try {
              dataStream.write(formatDataStreamPart('data', [{ type: 'ping', t: Date.now() }]));
            } catch {
              /* stream đã đóng */
            }
          }, HEARTBEAT_MS);

          const cleanup = () => {
            clearTimeout(budgetTimer);
            clearInterval(heartbeat);
          };

          try {
            const openai = createOpenAI({
              apiKey: selectedKey,
              baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
            });

            const abortSignal = combineAbortSignals(req.signal, guard.signal);

            const result = streamText({
              model: openai(targetModel),
              messages: core,
              system: system?.trim() ? system : undefined,
              abortSignal,
              maxRetries: 2,
              // Token đầu ra lấy theo cấu hình từng model (không hard-code 4096 nữa)
              ...(modelConfig.maxTokens ? { maxTokens: modelConfig.maxTokens } : {}),
              ...(modelConfig.supportsTemperature === false
                ? {}
                : { temperature: Math.min(2, Math.max(0, temperature ?? 0.7)) }),
            });

            const reader = result.fullStream.getReader();
            let finishReason: string | undefined;
            let usage: { promptTokens: number; completionTokens: number } | undefined;

            try {
              while (true) {
                const { done, value } = await reader.read();
                lastEventAt = Date.now();

                if (done) {
                  dropHeldSuspect();
                  markKeySuccess(selectedKey);

                  if (finishReason === 'length') {
                    writeAnnotation({
                      type: 'finish',
                      finishReason: 'length',
                      truncated: true,
                      message:
                        'Câu trả lời đã đạt giới hạn token của model. Bấm "Viết tiếp" để AI tiếp tục.',
                    });
                  } else {
                    writeAnnotation({ type: 'finish', finishReason: finishReason ?? 'stop', truncated: false });
                  }
                  writeFinish((finishReason as any) ?? 'stop', usage);
                  return;
                }

                switch (value.type) {
                  case 'text-delta':
                    writeText(value, 'text');
                    break;

                  // v4 dùng 'reasoning'; một số bản dùng 'reasoning-delta'
                  case 'reasoning':
                  case 'reasoning-delta' as any:
                    writeText(value, 'reasoning');
                    break;

                  case 'source':
                    if (value.source) dataStream.write(formatDataStreamPart('source', value.source));
                    break;

                  case 'error':
                    throw value.error ?? new Error('Provider trả về error part rỗng.');

                  case 'finish':
                    finishReason = (value as any).finishReason;
                    if ((value as any).usage) {
                      usage = {
                        promptTokens: (value as any).usage.promptTokens ?? 0,
                        completionTokens: (value as any).usage.completionTokens ?? 0,
                      };
                    }
                    break;

                  case 'step-finish':
                  case 'step-start':
                  default:
                    break;
                }
              }
            } catch (streamErr) {
              try {
                await reader.cancel();
              } catch {
                /* reader đã đóng */
              }

              dropHeldSuspect();

              // Người dùng bấm Stop: kết thúc êm, KHÔNG coi là lỗi.
              const userAborted = req.signal.aborted && !abortCause;
              if (userAborted) {
                writeFinish('other', usage);
                return;
              }

              // Timeout của chúng ta: phải báo cho client, tuyệt đối không return im lặng.
              if (abortCause) {
                const msg =
                  abortCause === 'budget'
                    ? 'Phiên trả lời đã chạm giới hạn thời gian của server. Nội dung có thể chưa hoàn chỉnh — bấm "Viết tiếp".'
                    : 'AI Provider ngừng gửi dữ liệu quá lâu. Nội dung có thể chưa hoàn chỉnh — bấm "Viết tiếp".';
                writeAnnotation({ type: 'finish', finishReason: 'length', truncated: true, message: msg });
                dataStream.write(
                  formatDataStreamPart('data', [
                    { type: 'generation-error', message: msg, recoverable: true },
                  ]),
                );
                writeFinish('length', usage);
                return;
              }

              lastError = streamErr;
              const status = getStatusCode(streamErr);
              markKeyFailure(selectedKey, status);
              console.warn(`[Failover] ${getKeyLabel(selectedKey)}:`, sanitizeErrorMessage(streamErr));

              if (emittedChars > 0) {
                const msg = 'Kết nối AI bị gián đoạn giữa chừng. Bạn có thể bấm Tạo lại hoặc Viết tiếp.';
                writeAnnotation({ type: 'finish', finishReason: 'error', truncated: true, message: msg });
                dataStream.write(
                  formatDataStreamPart('data', [
                    { type: 'generation-error', message: msg, recoverable: true },
                  ]),
                );
                dataStream.write(formatDataStreamPart('error', sanitizeErrorMessage(streamErr)));
                writeFinish('error', usage);
                return;
              }

              if (isPermanentClientError(status)) throw streamErr;
            } finally {
              try {
                reader.releaseLock();
              } catch {
                /* đã tự giải phóng */
              }
            }
          } catch (initErr) {
            if (req.signal.aborted && !abortCause) return;
            lastError = initErr;
            const status = getStatusCode(initErr);
            markKeyFailure(selectedKey, status);
            console.warn(`[Failover init] ${getKeyLabel(selectedKey)}:`, sanitizeErrorMessage(initErr));
            if (isPermanentClientError(status)) throw initErr;
          } finally {
            cleanup();
          }
        }

        if (lastError instanceof Error) throw lastError;
        throw new Error('Toàn bộ API Key khả dụng đều không thể hoàn thành yêu cầu.');
      },
      onError: sanitizeErrorMessage,
    });
  } catch (error: any) {
    console.error('Chat API Fatal Error:', sanitizeErrorMessage(error));
    return Response.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
