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
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID, getModelConfig, resolveProviderModelChain } from '@/lib/models';
import { checkRateLimit, getClientIp, checkSameOrigin, verifyAccessAuth } from '@/lib/security';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const STREAM_BUDGET_MS = 270_000;
const IDLE_TIMEOUT_MS = 60_000;
const HEARTBEAT_MS = 10_000;
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;
const MAX_FAILOVER_KEYS = 3;

const DEBUG_ERRORS = ['1', 'true', 'yes'].includes(
  (process.env.CHAT_DEBUG_ERRORS ?? '').trim().toLowerCase(),
);

/* -------------------------------------------------------------------------- */
/* Helpers chung                                                              */
/* -------------------------------------------------------------------------- */

function newRequestId(): string {
  try {
    return globalThis.crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

/** Response JSON luôn kèm requestId — sửa A10. */
function jsonError(
  requestId: string,
  status: number,
  code: string,
  error: string,
  extra?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  return Response.json(
    { error, code, requestId, ...extra },
    { status, headers: { 'X-Request-Id': requestId, ...headers } },
  );
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

/**
 * Sửa A7: chỉ coi `undefined` và `[object Object]` là artifact.
 * `null` / `NaN` là nội dung hợp lệ trong ngữ cảnh lập trình.
 * So khớp sau khi trim để bắt được cả " undefined" (dạng phổ biến nhất).
 */
const HARD_ARTIFACT = /^(?:undefined|\[object Object\])$/;

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
    for (const candidate of [
      anyErr.statusCode,
      anyErr.status,
      anyErr?.response?.status,
      anyErr?.data?.error?.status,
    ]) {
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

/* -------------------------------------------------------------------------- */
/* Abort: phân loại nguyên nhân — sửa A2, A5                                  */
/* -------------------------------------------------------------------------- */

type AbortKind = 'client' | 'budget' | 'idle';

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = (e as any).name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if ((e as any).cause) return isAbortError((e as any).cause);
  return false;
}

/** Sửa A4: trả về cả hàm dispose để tháo listener sau mỗi attempt. */
function linkAbortSignals(
  ...signals: (AbortSignal | undefined)[]
): { signal: AbortSignal; dispose: () => void } {
  const valid = signals.filter(Boolean) as AbortSignal[];
  const controller = new AbortController();
  const onAbort = (ev: Event) => {
    if (controller.signal.aborted) return;
    controller.abort((ev.target as AbortSignal | null)?.reason);
  };

  for (const sig of valid) {
    if (sig.aborted) {
      if (!controller.signal.aborted) controller.abort(sig.reason);
      break;
    }
    sig.addEventListener('abort', onAbort);
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const sig of valid) sig.removeEventListener('abort', onAbort);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Chẩn đoán upstream                                                          */
/* -------------------------------------------------------------------------- */

interface UpstreamDiagnosis {
  status?: number;
  scope: UpstreamScope;
  code: string;
  userMessage: string;
  devLog: string;
  stopFailover: boolean;
  /** true = lỗi của key, nên markKeyFailure. false = lỗi của ta hoặc của request. */
  blameKey: boolean;
}

function diagnoseUpstreamError(
  e: unknown,
  ctx: { requestId: string; model: string; keyLabel: string },
): UpstreamDiagnosis {
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
    /cloudflare|attention required|just a moment|error code: 1020/i.test(
      `${bodySnippet} ${upstreamServer ?? ''}`,
    );

  let code = `UPSTREAM_${status ?? 'NETWORK'}`;
  let userMessage: string;
  let blameKey = true;

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
      // WAF chặn theo IP của Vercel → đổi key vô ích, nhưng cũng không phải lỗi key.
      blameKey = !looksLikeCloudflare;
      userMessage = looksLikeCloudflare
        ? `Cloudflare/WAF của ${upstreamHost} chặn request từ IP của Vercel (403).` +
          (cfRay ? ` cf-ray=${cfRay}.` : '') +
          ' Cần whitelist IP Vercel, tắt bot-fight-mode cho endpoint API, hoặc đổi sang base URL khác.'
        : `AI Provider trả về 403 Forbidden tại ${upstreamHost} cho model '${ctx.model}'. ` +
          `Nguyên nhân thường gặp: key ${ctx.keyLabel} bị khóa, hoặc key không được cấp quyền dùng model này.`;
      break;
    case 404:
      code = 'UPSTREAM_MODEL_404';
      // Model không tồn tại trên gateway → đổi key không giúp gì.
      blameKey = false;
      userMessage = `Model '${ctx.model}' không tồn tại hoặc không được cấp quyền trên ${upstreamHost} (404).`;
      break;
    case 400:
    case 422:
      code = `UPSTREAM_BAD_REQUEST_${status}`;
      blameKey = false;
      userMessage = `Yêu cầu gửi lên AI Provider không hợp lệ (${status}). Đổi key cũng không giải quyết được.`;
      break;
    case 429:
      code = 'UPSTREAM_RATE_LIMIT_429';
      userMessage = `Key ${ctx.keyLabel} đang bị giới hạn tốc độ / hết quota (429) tại ${upstreamHost}.`;
      break;
    default:
      if (status && status >= 500) {
        code = `UPSTREAM_SERVER_${status}`;
        blameKey = false;
        userMessage = `AI Provider ${upstreamHost} đang gặp sự cố (${status}). Vui lòng thử lại sau ít phút.`;
      } else if (status === undefined) {
        code = 'UPSTREAM_NETWORK';
        blameKey = false;
        userMessage = `Không kết nối được tới AI Provider ${upstreamHost}: ${sanitizeErrorMessage(e)}`;
      } else {
        userMessage = `AI Provider ${upstreamHost} trả về lỗi ${status}: ${sanitizeErrorMessage(e)}`;
      }
  }

  if (DEBUG_ERRORS && bodySnippet) userMessage += ` | upstream body: ${bodySnippet}`;

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

  // 403-WAF và 5xx: vẫn nên thử key khác (có thể route khác IP / retry may mắn).
  const stopFailover = scope === 'request' || status === 404;

  return { status, scope, code, userMessage, devLog, stopFailover, blameKey };
}

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

/* -------------------------------------------------------------------------- */
/* Schema & chuẩn hoá message                                                  */
/* -------------------------------------------------------------------------- */

const ALLOWED_ATTACHMENT_PREFIXES = ['image/', 'application/pdf', 'text/'];

const AttachmentSchema = z.object({
  name: z.string().max(255).optional(),
  contentType: z.string().max(128).optional(),
  url: z.string().max(MAX_BODY_BYTES).optional(),
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
  // Gộp mọi system message rải rác về đầu — một số gateway 400 nếu system nằm giữa.
  const systems = cleaned.filter((m) => m.role === 'system');
  const rest = cleaned.filter((m) => m.role !== 'system');
  const firstUser = rest.findIndex((m) => m.role === 'user');
  if (firstUser === -1) return [];
  return [...systems, ...rest.slice(firstUser)];
}

/** Sửa A9: cancel body khi vượt hạn thay vì chỉ releaseLock. */
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
    /* --- Tầng 1: Same-Origin --- */
    if (!checkSameOrigin(req as any)) {
      console.warn(`[req:${requestId}][SECURITY_ORIGIN_FORBIDDEN] Origin không được phép.`);
      return jsonError(requestId, 403, 'ORIGIN_FORBIDDEN', 'Truy cập bị từ chối: Origin không được phép.');
    }

    /* --- Tầng 2: Access code --- */
    const auth = verifyAccessAuth(req as any);
    if (!auth.ok) {
      console.warn(`[req:${requestId}][AUTH_UNAUTHORIZED] ${auth.error}`);
      return jsonError(requestId, auth.status ?? 401, 'UNAUTHORIZED', auth.error ?? 'Unauthorized');
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

    const clientIp = getClientIp(req as any);
    const rateKey = `${customKey ? 'byok' : 'pool'}:${clientIp}`;
    const rl = checkRateLimit(rateKey, customKey ? 60 : 20, 60_000);
    if (!rl.ok) {
      return jsonError(
        requestId,
        429,
        'RATE_LIMITED',
        `Bạn đang gửi tin nhắn quá nhanh. Vui lòng thử lại sau ${rl.retryAfterSec} giây.`,
        undefined,
        { 'Retry-After': String(rl.retryAfterSec) },
      );
    }

    /* --- Body --- */
    const contentLength = Number(req.headers.get('content-length') || '0');
    if (contentLength > MAX_BODY_BYTES) {
      return jsonError(requestId, 413, 'PAYLOAD_TOO_LARGE', 'Dữ liệu tin nhắn vượt quá giới hạn 4.5MB.');
    }

    let jsonBody: unknown;
    try {
      jsonBody = await readJsonWithLimit(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonError(requestId, 413, 'PAYLOAD_TOO_LARGE', 'Dữ liệu tin nhắn vượt quá giới hạn 4.5MB.');
      }
      return jsonError(requestId, 400, 'BAD_JSON', 'JSON payload không hợp lệ.');
    }

    const parsed = BodySchema.safeParse(jsonBody);
    if (!parsed.success) {
      return jsonError(requestId, 400, 'BAD_SCHEMA', 'Cấu trúc dữ liệu không hợp lệ.', {
        details: parsed.error.issues,
      });
    }

    const { messages, model, temperature, system } = parsed.data;

    const selectedModelId = model ?? DEFAULT_MODEL_ID;
    if (!ALLOWED_MODEL_IDS.has(selectedModelId)) {
      return jsonError(
        requestId,
        400,
        'MODEL_NOT_ALLOWED',
        `Model '${selectedModelId}' không được hỗ trợ.`,
      );
    }

    /* Sửa A11: tôn trọng capability của model. */
    const modelConfig = getModelConfig(selectedModelId);
    const modelChain = resolveProviderModelChain(modelConfig);
    const targetModel = modelConfig.providerModel;
    const contextMessages = messages.slice(-50);

    const sanitizedContextMessages = contextMessages.map((msg) => {
      if (!msg.experimental_attachments?.length) return msg;
      return {
        ...msg,
        experimental_attachments: msg.experimental_attachments.filter((att) => {
          const url = att.url ?? '';
          const schemeOk =
            url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:');
          if (!schemeOk) return false;
          const ct = att.contentType ?? '';
          // data: URL không rõ mime rất dễ làm provider trả 400 → chặn sớm.
          if (url.startsWith('data:') && !ALLOWED_ATTACHMENT_PREFIXES.some((p) => ct.startsWith(p))) {
            return false;
          }
          return true;
        }),
      };
    });

    let core: CoreMessage[];
    try {
      core = mergeSameRole(normalize(convertToCoreMessages(sanitizedContextMessages as any)));
    } catch {
      return jsonError(
        requestId,
        400,
        'BAD_MESSAGES',
        'Dữ liệu tin nhắn hoặc file đính kèm không đúng định dạng.',
      );
    }

    const candidateResult = customKey ? { keys: [customKey] } : getKeyCandidates();
    const candidateKeys = candidateResult.keys.slice(0, MAX_FAILOVER_KEYS);
    if (!candidateKeys.length) {
      const retrySec = Math.max(1, Math.ceil((candidateResult.retryAfterMs ?? 60_000) / 1000));
      return jsonError(
        requestId,
        503,
        'NO_API_KEY_CONFIGURED',
        'Toàn bộ API Key đang trong thời gian nghỉ / chờ xử lý. Vui lòng thử lại sau ít phút.',
        undefined,
        { 'Retry-After': String(retrySec) },
      );
    }

    const upstreamHost = hostOf(process.env.OPENAI_BASE_URL) ?? 'api.openai.com';
    console.info(
      `[req:${requestId}] start model=${targetModel} upstream=${upstreamHost} keys=${candidateKeys.length}`,
    );

    return createDataStreamResponse({
      headers: {
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': requestId,
        Connection: 'keep-alive',
      },
      execute: async (dataStream) => {
        let heldSuspect = '';
        let emittedChars = 0;
        let usage: { promptTokens: number; completionTokens: number } | undefined;
        let heartbeat: ReturnType<typeof setInterval> | null = null;

        const writeAnnotation = (payload: Record<string, unknown>) => {
          dataStream.write(
            formatDataStreamPart('message_annotations', [{ requestId, ...payload } as any]),
          );
        };

        /* Sửa A3: heartbeat 10s, chỉ chạy trong giai đoạn chưa có token nào.
           Tự tắt ngay khi byte text đầu tiên được gửi đi. */
        const startHeartbeat = () => {
          if (heartbeat) return;
          heartbeat = setInterval(() => {
            if (emittedChars > 0) {
              if (heartbeat) clearInterval(heartbeat);
              heartbeat = null;
              return;
            }
            writeAnnotation({ hb: Date.now() });
          }, HEARTBEAT_MS);
        };
        const stopHeartbeat = () => {
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
        };

        const writeText = (raw: unknown, channel: 'text' | 'reasoning' = 'text') => {
          const delta = extractDelta(raw);
          if (!delta) return;

          if (heldSuspect) {
            dataStream.write(formatDataStreamPart(channel, heldSuspect));
            emittedChars += heldSuspect.length;
            heldSuspect = '';
          }

          // Sửa A7: so khớp trên bản trim (bắt được " undefined"), chỉ với artifact thật.
          if (HARD_ARTIFACT.test(delta.trim())) {
            heldSuspect = delta;
            return;
          }

          dataStream.write(formatDataStreamPart(channel, delta));
          emittedChars += delta.length;
          stopHeartbeat();
        };

        const writeFinish = (
          finishReason: 'stop' | 'length' | 'error' | 'other' | 'content-filter' | 'tool-calls',
        ) => {
          heldSuspect = ''; // artifact ở cuối stream: bỏ.
          dataStream.write(
            formatDataStreamPart('finish_message', {
              finishReason,
              usage: usage ?? { promptTokens: 0, completionTokens: 0 },
            }),
          );
        };

        try {
          for (let attempt = 0; attempt < candidateKeys.length; attempt++) {
            const apiKey = candidateKeys[attempt];
            const keyLabel = getKeyLabel(apiKey);
            const openai = createOpenAI({
              apiKey,
              baseURL: process.env.OPENAI_BASE_URL || undefined,
            });

            for (const targetModel of modelChain) {
              let abortKind: AbortKind | null = null;
              const budgetController = new AbortController();
              const budgetTimer = setTimeout(() => {
                abortKind = 'budget';
                budgetController.abort(new Error('Vượt quá ngân sách thời gian stream (270s).'));
              }, STREAM_BUDGET_MS);

              let idleTimer: ReturnType<typeof setTimeout> | null = null;
              const clearIdle = () => {
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = null;
              };
              const resetIdleTimer = () => {
                clearIdle();
                idleTimer = setTimeout(() => {
                  abortKind = 'idle';
                  budgetController.abort(
                    new Error('AI Provider không phản hồi token mới trong 60 giây.'),
                  );
                }, IDLE_TIMEOUT_MS);
              };

              const link = linkAbortSignals(req.signal, budgetController.signal);

              try {
                writeAnnotation({
                  attempt: attempt + 1,
                  totalAttempts: candidateKeys.length,
                  key: keyLabel,
                  model: targetModel,
                });
                startHeartbeat();

                const result = streamText({
                  model: openai(targetModel),
                  messages: core,
                  ...(modelConfig.supportsTemperature === false
                    ? {}
                    : { temperature: temperature ?? 0.7 }),
                  ...(modelConfig.maxOutputTokens ? { maxTokens: modelConfig.maxOutputTokens } : {}),
                  system:
                    system ??
                    'Bạn là một trợ lý AI thông minh, hữu ích và chính xác. Trả lời bằng tiếng Việt trừ khi được yêu cầu ngôn ngữ khác.',
                  abortSignal: link.signal,
                });

                resetIdleTimer();

                let streamError: unknown = null;
                let finishReason: string | undefined;

                for await (const part of (result as any).fullStream) {
                  resetIdleTimer();
                  switch (part.type) {
                    case 'text-delta':
                      writeText(part.textDelta, 'text');
                      break;
                    case 'reasoning':
                    case 'reasoning-delta':
                      writeText(part.textDelta ?? part.delta, 'reasoning');
                      break;
                    case 'error':
                      streamError = part.error;
                      break;
                    case 'finish':
                    case 'step-finish':
                      if (part.usage) {
                        usage = {
                          promptTokens: part.usage.promptTokens ?? 0,
                          completionTokens: part.usage.completionTokens ?? 0,
                        };
                      }
                      if (typeof part.finishReason === 'string') finishReason = part.finishReason;
                      break;
                    default:
                      break;
                  }
                  if (streamError) break;
                }

                clearIdle();
                clearTimeout(budgetTimer);

                if (streamError) throw streamError;

                markKeySuccess(apiKey);
                writeFinish(finishReason === 'length' ? 'length' : 'stop');
                return;
              } catch (e: any) {
                clearIdle();
                clearTimeout(budgetTimer);

                if (req.signal.aborted) {
                  markKeySuccess(apiKey);
                  writeFinish(emittedChars > 0 ? 'stop' : 'other');
                  return;
                }

                const status = (e as any)?.status ?? (e as any)?.statusCode;
                const msg = String(e?.message ?? '').toLowerCase();
                const is404 = status === 404 || msg.includes('model_not_found') || msg.includes('does not exist');

                /**
                 * Nếu 404 và chưa emit ký tự nào, thử model tiếp theo trong chain
                 * mà KHÔNG phạt key. Riêng model cuối của key cuối thì rơi vào
                 * đường chẩn đoán bên dưới để người dùng nhận được lỗi rõ ràng —
                 * tránh kết thúc stream âm thầm với bong bóng trống.
                 */
                const isLastModelInChain = targetModel === modelChain[modelChain.length - 1];
                const isLastKeyAttempt = attempt === candidateKeys.length - 1;
                if (is404 && emittedChars === 0 && !(isLastModelInChain && isLastKeyAttempt)) {
                  console.warn(`[req:${requestId}] Model "${targetModel}" 404 trên ${upstreamHost} -> thử model tiếp theo trong chain.`);
                  continue;
                }

                if (abortKind && isAbortError(e)) {
                  const isIdle = abortKind === 'idle';
                  if (isIdle) markKeyFailure(apiKey, undefined);
                  const code = isIdle ? 'STREAM_IDLE_TIMEOUT' : 'STREAM_BUDGET_EXCEEDED';
                  const diagMsg = isIdle
                    ? `AI Provider ${upstreamHost} ngừng gửi token trong 60 giây, phiên stream đã bị hủy.`
                    : 'Phản hồi vượt quá ngân sách 270 giây của Edge Function và đã bị cắt.';
                  console.error(`[req:${requestId}][${code}] key=${keyLabel} model=${targetModel}`);
                  writeAnnotation({ error: code });
                  throw new ChatUpstreamError(diagMsg, code, requestId);
                }

                const diagnosis = diagnoseUpstreamError(e, { requestId, model: targetModel, keyLabel });
                console.error(diagnosis.devLog);

                if (diagnosis.blameKey) markKeyFailure(apiKey, diagnosis.status);

                const isLast = attempt === candidateKeys.length - 1;
                if (emittedChars > 0 || diagnosis.stopFailover || isLast) {
                  writeAnnotation({ error: diagnosis.code });
                  throw new ChatUpstreamError(diagnosis.userMessage, diagnosis.code, requestId);
                }
                break;
              } finally {
                link.dispose();
              }
            }
          }
        } finally {
          stopHeartbeat();
        }
      },
      onError: (err) => {
        if (err instanceof ChatUpstreamError) return `${err.message} [${err.code}#${err.requestId}]`;
        return `Đã xảy ra lỗi khi tạo phản hồi: ${sanitizeErrorMessage(err)} [req:${requestId}]`;
      },
    });
  } catch (err) {
    return jsonError(requestId, 500, 'INTERNAL', sanitizeErrorMessage(err));
  }
}