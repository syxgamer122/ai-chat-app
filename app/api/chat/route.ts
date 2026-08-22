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
  classifyUpstreamStatus,
  type UpstreamScope,
} from '@/lib/api-keys';
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID, getModelConfig } from '@/lib/models';
import { checkRateLimit, getClientIp, checkSameOrigin, verifyAccessAuth } from '@/lib/security';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const STREAM_BUDGET_MS = 270_000;
const IDLE_TIMEOUT_MS = 60_000;
const HEARTBEAT_MS = 10_000;
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;

/** Bật CHAT_DEBUG_ERRORS=1 để lộ body lỗi gốc của upstream ra client (chỉ dùng khi debug). */
const DEBUG_ERRORS = ['1', 'true', 'yes'].includes(
  (process.env.CHAT_DEBUG_ERRORS ?? '').trim().toLowerCase(),
);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function newRequestId(): string {
  try {
    return globalThis.crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

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

const SUSPECT_TOKEN = /^(?:undefined|null|NaN|\[object Object\])$/;
const SECRET_REGEX = /\b(sk|sk-proj|sk-ant|Bearer)\s*[:=]?\s*[A-Za-z0-9_\-]{4,}/gi;

function redact(text: string): string {
  return text.replace(SECRET_REGEX, '[redacted]');
}

function rawMessageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as any).message === 'string') return (e as any).message;
  return '';
}

function sanitizeErrorMessage(e: unknown): string {
  const cleaned = redact(rawMessageOf(e)).trim().slice(0, 500);
  return cleaned || 'Lỗi không xác định từ AI Provider.';
}

function getStatusCode(e: unknown): number | undefined {
  if (APICallError.isInstance(e)) return e.statusCode;
  if (e && typeof e === 'object') {
    const anyErr = e as any;
    for (const candidate of [anyErr.statusCode, anyErr.status, anyErr?.response?.status, anyErr?.data?.error?.status]) {
      if (typeof candidate === 'number') return candidate;
    }
    if (anyErr.cause) return getStatusCode(anyErr.cause);
  }
  return undefined;
}

function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

interface UpstreamDiagnosis {
  status?: number;
  scope: UpstreamScope;
  code: string;
  userMessage: string;
  devLog: string;
  stopFailover: boolean;
}

/**
 * Biến một lỗi provider mơ hồ ("Forbidden") thành chẩn đoán đầy đủ:
 * status + host upstream + body gốc + cf-ray + gợi ý nguyên nhân.
 */
function diagnoseUpstreamError(e: unknown, ctx: { requestId: string; model: string; keyLabel: string }): UpstreamDiagnosis {
  const status = getStatusCode(e);
  const scope = classifyUpstreamStatus(status);

  let url: string | undefined;
  let body: string | undefined;
  let cfRay: string | undefined;
  let upstreamServer: string | undefined;

  if (APICallError.isInstance(e)) {
    url = e.url;
    body = typeof e.responseBody === 'string' ? e.responseBody : undefined;
    const headers = (e.responseHeaders ?? {}) as Record<string, string>;
    cfRay = headers['cf-ray'];
    upstreamServer = headers['server'];
  }

  const upstreamHost = hostOf(url) ?? hostOf(process.env.OPENAI_BASE_URL) ?? 'api.openai.com';
  const bodySnippet = body ? redact(body).replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const looksLikeCloudflare =
    Boolean(cfRay) ||
    /cloudflare|attention required|just a moment|error code: 1020/i.test(`${bodySnippet} ${upstreamServer ?? ''}`);

  let code = `UPSTREAM_${status ?? 'NETWORK'}`;
  let userMessage: string;

  switch (status) {
    case 401:
      code = 'UPSTREAM_AUTH_401';
      userMessage =
        `AI Provider từ chối API Key (401 Unauthorized) tại ${upstreamHost}. ` +
        'Key sai, đã bị thu hồi, hoặc không hợp lệ với OPENAI_BASE_URL đang cấu hình.';
      break;
    case 402:
      code = 'UPSTREAM_PAYMENT_402';
      userMessage = `Tài khoản upstream tại ${upstreamHost} đã hết credit / hết hạn thanh toán (402).`;
      break;
    case 403:
      code = looksLikeCloudflare ? 'UPSTREAM_WAF_403' : 'UPSTREAM_FORBIDDEN_403';
      userMessage = looksLikeCloudflare
        ? `Cloudflare/WAF của ${upstreamHost} chặn request từ IP của Vercel (403).` +
          (cfRay ? ` cf-ray=${cfRay}.` : '') +
          ' Cần whitelist IP Vercel, tắt bot-fight-mode cho endpoint API, hoặc đổi sang base URL khác.'
        : `AI Provider trả về 403 Forbidden tại ${upstreamHost} cho model '${ctx.model}'. ` +
          `Nguyên nhân thường gặp: key ${ctx.keyLabel} bị khóa, hoặc key không được cấp quyền dùng model này.`;
      break;
    case 404:
      code = 'UPSTREAM_MODEL_404';
      userMessage = `Model '${ctx.model}' không tồn tại hoặc không được cấp quyền trên ${upstreamHost} (404).`;
      break;
    case 400:
    case 422:
      code = `UPSTREAM_BAD_REQUEST_${status}`;
      userMessage = `Yêu cầu gửi lên AI Provider không hợp lệ (${status}). Đổi key cũng không giải quyết được.`;
      break;
    case 429:
      code = 'UPSTREAM_RATE_LIMIT_429';
      userMessage = `Key ${ctx.keyLabel} đang bị giới hạn tốc độ / hết quota (429) tại ${upstreamHost}.`;
      break;
    default:
      if (status && status >= 500) {
        code = `UPSTREAM_SERVER_${status}`;
        userMessage = `AI Provider ${upstreamHost} đang gặp sự cố (${status}). Vui lòng thử lại sau ít phút.`;
      } else if (status === undefined) {
        code = 'UPSTREAM_NETWORK';
        userMessage = `Không kết nối được tới AI Provider ${upstreamHost}: ${sanitizeErrorMessage(e)}`;
      } else {
        userMessage = `AI Provider ${upstreamHost} trả về lỗi ${status}: ${sanitizeErrorMessage(e)}`;
      }
  }

  if (DEBUG_ERRORS && bodySnippet) {
    userMessage += ` | upstream body: ${bodySnippet}`;
  }

  const devLog = [
    `[req:${ctx.requestId}]`,
    `[${code}]`,
    `key=${ctx.keyLabel}`,
    `model=${ctx.model}`,
    `host=${upstreamHost}`,
    status ? `status=${status}` : 'status=none',
    cfRay ? `cf-ray=${cfRay}` : '',
    bodySnippet ? `body=${bodySnippet}` : `msg=${sanitizeErrorMessage(e)}`,
  ]
    .filter(Boolean)
    .join(' ');

  return { status, scope, code, userMessage, devLog, stopFailover: scope === 'request' };
}

/** Lỗi mang sẵn thông điệp thân thiện để onError trả thẳng cho client. */
class ChatUpstreamError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly requestId: string,
  ) {
    super(message);
    this.name = 'ChatUpstreamError';
  }
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
/* Schemas                                                             */
/* ------------------------------------------------------------------ */

const AttachmentSchema = z.object({
  name: z.string().max(255).optional(),
  contentType: z.string().max(128).optional(),
  url: z.string().max(6_000_000).optional(),
});

const MessageSchema = z.object({
  id: z.string().max(128).optional(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.union([z.string().max(200_000), z.array(z.record(z.string(), z.unknown())).max(100)]),
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
    const mergeable = last && last.role === cur.role && (cur.role === 'user' || cur.role === 'assistant');
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
        throw new Response(JSON.stringify({ error: 'Dữ liệu tin nhắn vượt quá giới hạn 4.5MB.' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' },
        });
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
/* Route                                                               */
/* ------------------------------------------------------------------ */

export async function POST(req: Request) {
  const requestId = newRequestId();

  try {
    /* --- Tầng 1: Same-Origin (log đầy đủ lý do, không còn "Forbidden" mù mờ) --- */
    const originCheck = checkSameOrigin(req);
    if (!originCheck.allowed) {
      console.warn(
        `[req:${requestId}][SECURITY_${originCheck.code}] ${originCheck.reason}`,
        JSON.stringify(originCheck.debug),
      );
      return Response.json(
        {
          error: `Truy cập bị từ chối: ${originCheck.reason}`,
          code: originCheck.code,
          requestId,
        },
        { status: 403, headers: { 'X-Request-Id': requestId } },
      );
    }

    /* --- Tầng 2: Access code --- */
    const auth = verifyAccessAuth(req);
    if (!auth.authorized) {
      console.warn(`[req:${requestId}][${auth.code}] ${auth.reason}`);
      return Response.json(
        { error: auth.reason, code: auth.code, requestId },
        { status: 401, headers: { 'X-Request-Id': requestId } },
      );
    }

    /* --- BYOK + rate limit --- */
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
        { error: `Bạn đang gửi tin nhắn quá nhanh. Vui lòng thử lại sau ${resetInSec} giây.`, code: 'RATE_LIMITED', requestId },
        { status: 429, headers: { 'Retry-After': String(resetInSec), 'X-Request-Id': requestId } },
      );
    }

    /* --- Body --- */
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > MAX_BODY_BYTES) {
      return Response.json({ error: 'Dữ liệu tin nhắn vượt quá giới hạn 4.5MB.', code: 'PAYLOAD_TOO_LARGE' }, { status: 413 });
    }

    let jsonBody: unknown;
    try {
      jsonBody = await readJsonWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof Response) return error;
      return Response.json(
        { error: 'JSON payload không hợp lệ hoặc vượt quá kích thước cho phép.', code: 'BAD_JSON' },
        { status: 400 },
      );
    }

    const parsed = BodySchema.safeParse(jsonBody);
    if (!parsed.success) {
      return Response.json(
        { error: 'Cấu trúc dữ liệu không hợp lệ.', code: 'BAD_SCHEMA', details: parsed.error.issues },
        { status: 400 },
      );
    }

    const { messages, model, temperature, system } = parsed.data;

    const selectedModelId = model ?? DEFAULT_MODEL_ID;
    if (!ALLOWED_MODEL_IDS.has(selectedModelId)) {
      return Response.json({ error: `Model '${selectedModelId}' không được hỗ trợ.`, code: 'MODEL_NOT_ALLOWED' }, { status: 400 });
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
        { error: 'Dữ liệu tin nhắn hoặc file đính kèm không đúng định dạng.', code: 'BAD_MESSAGES' },
        { status: 400 },
      );
    }

    if (!core.length) {
      return Response.json({ error: 'Không có nội dung tin nhắn để gửi.', code: 'EMPTY_MESSAGES' }, { status: 400 });
    }

    const candidateKeys = customKey ? [customKey] : getKeyCandidates().slice(0, 3);
    if (!candidateKeys.length) {
      return Response.json(
        {
          error:
            'Chưa cấu hình OPENAI_API_KEYS (hoặc OPENAI_API_KEY) trên môi trường Vercel. Hãy thêm biến môi trường và redeploy.',
          code: 'NO_API_KEY_CONFIGURED',
          requestId,
        },
        { status: 503, headers: { 'Retry-After': '60', 'X-Request-Id': requestId } },
      );
    }

    const upstreamHost = hostOf(process.env.OPENAI_BASE_URL) ?? 'api.openai.com';
    console.info(
      `[req:${requestId}] start model=${targetModel} upstream=${upstreamHost} keys=${candidateKeys.length} origin=${originCheck.code}`,
    );

    return createDataStreamResponse({
      headers: {
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': requestId,
        Connection: 'keep-alive',
      },
      execute: async (dataStream) => {
        let lastDiagnosis: UpstreamDiagnosis | undefined;
        let heldSuspect = '';
        let emittedChars = 0;

        const writeText = (raw: unknown, channel: 'text' | 'reasoning' = 'text') => {
          const delta = extractDelta(raw);
          if (!delta) return;

          if (heldSuspect) {
            dataStream.write(formatDataStreamPart(channel, heldSuspect));
            emittedChars += heldSuspect.length;
            heldSuspect = '';
          }

          if (SUSPECT_TOKEN.test(delta.trim()) && delta.trim() === delta) {
            heldSuspect = delta;
            return;
          }

          dataStream.write(formatDataStreamPart(channel, delta));
          emittedChars += delta.length;
        };

        const dropHeldSuspect = () => {
          heldSuspect = '';
        };

        const writeAnnotation = (payload: Record<string, unknown>) => {
          dataStream.write(formatDataStreamPart('message_annotations', [{ requestId, ...payload } as any]));
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
          const keyLabel = getKeyLabel(selectedKey);
          const diagCtx = { requestId, model: targetModel, keyLabel };

          const guard = new AbortController();
          let abortCause: 'budget' | 'idle' | null = null;
          let lastEventAt = Date.now();

          const budgetTimer = setTimeout(() => {
            abortCause = 'budget';
            guard.abort();
          }, STREAM_BUDGET_MS);

          const heartbeat = setInterval(() => {
            if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
              abortCause = 'idle';
              guard.abort();
              return;
            }
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
              // Một số proxy đứng sau Cloudflare chặn request thiếu User-Agent.
              headers: { 'User-Agent': 'quyettamvmo-chat/1.0 (+vercel)' },
            });

            const abortSignal = combineAbortSignals(req.signal, guard.signal);

            const result = streamText({
              model: openai(targetModel),
              messages: core,
              system: system?.trim() ? system : undefined,
              abortSignal,
              maxRetries: 2,
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
                      message: 'Câu trả lời đã đạt giới hạn token của model. Bấm "Viết tiếp" để AI tiếp tục.',
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

                  default:
                    break;
                }
              }
            } catch (streamErr) {
              try {
                await reader.cancel();
              } catch {
                /* noop */
              }
              dropHeldSuspect();

              if (req.signal.aborted && !abortCause) {
                writeFinish('other', usage);
                return;
              }

              if (abortCause) {
                const msg =
                  abortCause === 'budget'
                    ? 'Phiên trả lời đã chạm giới hạn thời gian của server. Nội dung có thể chưa hoàn chỉnh — bấm "Viết tiếp".'
                    : 'AI Provider ngừng gửi dữ liệu quá lâu. Nội dung có thể chưa hoàn chỉnh — bấm "Viết tiếp".';
                writeAnnotation({ type: 'finish', finishReason: 'length', truncated: true, message: msg });
                dataStream.write(
                  formatDataStreamPart('data', [{ type: 'generation-error', message: msg, recoverable: true }]),
                );
                writeFinish('length', usage);
                return;
              }

              const diag = diagnoseUpstreamError(streamErr, diagCtx);
              lastDiagnosis = diag;
              markKeyFailure(selectedKey, diag.status, diag.scope);
              console.warn(`[Failover:stream] ${diag.devLog}`);

              if (emittedChars > 0) {
                const msg = `Kết nối AI bị gián đoạn giữa chừng: ${diag.userMessage} (mã ${diag.code}, req ${requestId})`;
                writeAnnotation({ type: 'error', code: diag.code, finishReason: 'error', truncated: true, message: msg });
                dataStream.write(
                  formatDataStreamPart('data', [{ type: 'generation-error', message: msg, recoverable: true }]),
                );
                dataStream.write(formatDataStreamPart('error', msg));
                writeFinish('error', usage);
                return;
              }

              if (diag.stopFailover) {
                throw new ChatUpstreamError(diag.userMessage, diag.code, requestId);
              }
            } finally {
              try {
                reader.releaseLock();
              } catch {
                /* noop */
              }
            }
          } catch (initErr) {
            if (initErr instanceof ChatUpstreamError) throw initErr;
            if (req.signal.aborted && !abortCause) return;

            const diag = diagnoseUpstreamError(initErr, diagCtx);
            lastDiagnosis = diag;
            markKeyFailure(selectedKey, diag.status, diag.scope);
            console.warn(`[Failover:init] ${diag.devLog}`);

            if (diag.stopFailover) {
              throw new ChatUpstreamError(diag.userMessage, diag.code, requestId);
            }
          } finally {
            cleanup();
          }
        }

        /* Tất cả key đều thất bại */
        const finalMessage = lastDiagnosis
          ? `${lastDiagnosis.userMessage} (đã thử ${candidateKeys.length} API Key, mã ${lastDiagnosis.code}, req ${requestId})`
          : `Toàn bộ ${candidateKeys.length} API Key khả dụng đều không thể hoàn thành yêu cầu. (req ${requestId})`;

        console.error(`[req:${requestId}][ALL_KEYS_FAILED] ${lastDiagnosis?.devLog ?? 'no diagnosis'}`);
        writeAnnotation({ type: 'error', code: lastDiagnosis?.code ?? 'ALL_KEYS_FAILED', message: finalMessage });
        throw new ChatUpstreamError(finalMessage, lastDiagnosis?.code ?? 'ALL_KEYS_FAILED', requestId);
      },

      /* Thông điệp cuối cùng client nhận được — không bao giờ còn là "Forbidden" trống trơn. */
      onError: (error) => {
        if (error instanceof ChatUpstreamError) return error.message;
        const diag = diagnoseUpstreamError(error, { requestId, model: '(unknown)', keyLabel: '(unknown)' });
        console.error(`[req:${requestId}][STREAM_ONERROR] ${diag.devLog}`);
        return `${diag.userMessage} (mã ${diag.code}, req ${requestId})`;
      },
    });
  } catch (error: any) {
    console.error(`[req:${requestId}][FATAL] ${sanitizeErrorMessage(error)}`);
    return Response.json(
      { error: sanitizeErrorMessage(error), code: 'INTERNAL_ERROR', requestId },
      { status: 500, headers: { 'X-Request-Id': requestId } },
    );
  }
}
