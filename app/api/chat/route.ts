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
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID, getModelConfig, mediaKindOf, resolveProviderModelChain } from '@/lib/models';
import { validateProviderBaseUrl, THINKING_LEVELS, supportsThinkingLevel } from '@/lib/provider-url';
import { acquireUpstreamSlot, sharedFreeBudget } from '@/lib/upstream-queue';
import { pumpSseLines } from '@/lib/sse';
import { checkRateLimit, getClientIp, checkSameOrigin, verifyAccessAuth } from '@/lib/security';

/**
 * Giữ nguyên edge runtime cho chat (không đổi sang nodejs trong phạm vi thay
 * đổi này — nodejs bị cắt cứng theo maxDuration, cần đo lại trước khi đổi).
 *
 * Tạo ảnh/video ĐI QUA route này với mọi gateway chặn cross-origin — crax trả
 * 403 cho bất kỳ request có header `Origin`, tức là mọi lời gọi từ trình duyệt,
 * nên đường "gọi thẳng từ client" (lib/media-generate.ts) không dùng được cho
 * crax và tự fallback về đây.
 *
 * Video vẫn kịp: đo thực tế crax `qwen-video-2.0-pro` xong trong 120-126s,
 * byte đầu < 1.7s — nằm trong trần 300s của Vercel (kể cả Hobby) và thoả điều
 * kiện edge "phải gửi byte đầu trong 25s để được stream tiếp".
 */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const STREAM_BUDGET_MS = 270_000;

/**
 * Ngân sách riêng cho model sinh video. Vercel cắt cứng function ở 300s
 * (Hobby: default = max = 300s; edge stream cũng 300s), nên đặt 290s để CHÍNH
 * ta kết thúc trước nền tảng và trả được thông báo tử tế — thay vì bị giết giữa
 * stream, người dùng thấy treo không rõ lý do.
 *
 * Đo thực tế trên crax `qwen-video-2.0-pro`: 120s và 126s cho 2 lần chạy,
 * first byte < 1.7s, khoảng cách event lớn nhất ~19s. Video thường nằm gọn
 * trong ngân sách; chỉ video nặng bất thường mới chạm trần.
 */
const VIDEO_BUDGET_MS = 290_000;
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

/* ------------------------------------------------------------------ */
/* Model tạo ảnh (qwen-image của crax v.v.)                            */
/* ------------------------------------------------------------------ */

/**
 * Gateway trả ảnh qua SSE đặc thù: event `{"type":"status"}` / `{"type":"image","url":...}`
 * không có `choices` — parser của AI SDK v4 reject (`Type validation failed`).
 * Với model ảnh, tự fetch và bóc tách tay rồi ghi URL ảnh vào stream dạng
 * markdown để client render inline.
 */
const IMAGE_MODEL_RE = /image|seedream|t2i|dall-e|dalle|flux|stable-diffusion|imggen|imagen|sdxl/i;

function isImageModel(modelId: string): boolean {
  const declared = mediaKindOf(modelId);
  if (declared) return declared === 'image';
  return IMAGE_MODEL_RE.test(modelId);
}

/** Model tạo video — crax lộ alias `qwen-video` qua chat SSE (event type:video). */
const VIDEO_MODEL_RE = /video|kling|seedance|sora|veo|hailuo|vidu|jimeng/i;

function isVideoModel(modelId: string): boolean {
  const declared = mediaKindOf(modelId);
  if (declared) return declared === 'video';
  return VIDEO_MODEL_RE.test(modelId);
}

function coreToOpenAiMessages(core: CoreMessage[]): Array<{ role: string; content: string }> {
  return core.map((m) => {
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : ''))
        .join('');
    }
    return { role: m.role, content: text };
  });
}

/**
 * Đọc từng payload `data:` từ một SSE stream.
 *
 * `onAlive` được gọi cho MỌI byte nhận được từ upstream, kể cả dòng comment
 * SSE (`: keepalive`) mà crax phát khi model còn đang xử lý. Idle-timer phải
 * reset theo tín hiệu này: tạo video có quãng chỉ toàn keepalive, nếu chỉ đếm
 * dòng `data:` thì stream đang sống vẫn bị coi là treo và bị abort oan.
 */
const pumpSseData = pumpSseLines;

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
  ctx: { requestId: string; model: string; keyLabel: string; providerBase?: string },
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

  // Lỗi network/timeout không có url phản hồi — dùng provider thật của request
  // thay vì env, tránh báo sai địa chỉ khi user đang gọi provider riêng.
  const upstreamHost =
    hostOf(url) ?? hostOf(ctx.providerBase) ?? hostOf(process.env.OPENAI_BASE_URL) ?? 'api.openai.com';
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
        (ctx.providerBase
          ? 'Key sai hoặc đã bị thu hồi — kiểm tra lại API Key của nhà cung cấp này.'
          : 'Key sai, đã bị thu hồi, hoặc không hợp lệ với OPENAI_BASE_URL đang cấu hình.');
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
  // 400 "Unknown model" (kiểu crax trả thay vì 404) vẫn cho thử model kế tiếp.
  const unknownModel400 = status === 400 && /unknown model/i.test(bodySnippet);
  const stopFailover = (scope === 'request' && !unknownModel400) || status === 404;

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
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
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

    /* --- BYOK + provider preset override (chỉ đọc header) --- */
    const rawCustomKey = req.headers.get('x-api-key')?.trim();

    const rawProviderBase = req.headers.get('x-api-base')?.trim() || undefined;
    const providerBaseCheck = rawProviderBase
      ? validateProviderBaseUrl(rawProviderBase)
      : undefined;
    if (providerBaseCheck && !providerBaseCheck.ok) {
      return jsonError(
        requestId,
        400,
        'BAD_PROVIDER_BASE',
        `Địa chỉ nhà cung cấp không hợp lệ: ${providerBaseCheck.error}`,
      );
    }
    const providerBase = providerBaseCheck?.ok ? providerBaseCheck.url : undefined;

    const customKey =
      rawCustomKey &&
      rawCustomKey.length <= 256 &&
      /^[\x21-\x7E]+$/.test(rawCustomKey)
        ? rawCustomKey
        : undefined;

    /* --- Tầng 2: Rate limit — PHẢI chạy trước verifyAccessAuth để mỗi lần
       đoán sai ACCESS_CODE cũng tốn quota, không thể brute-force miễn phí. --- */
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

    /* --- Tầng 3: Access code --- */
    const auth = verifyAccessAuth(req as any);
    if (!auth.ok) {
      console.warn(`[req:${requestId}][AUTH_UNAUTHORIZED] ${auth.error}`);
      return jsonError(requestId, auth.status ?? 401, 'UNAUTHORIZED', auth.error ?? 'Unauthorized');
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

    const { messages, model, temperature, system, thinkingLevel } = parsed.data;

    /* Mức suy luận chỉ có tác dụng trên gateway crax — gateway khác sẽ bỏ qua. */
    const effortBase = providerBase ?? process.env.OPENAI_BASE_URL ?? null;
    const reasoningEffort =
      thinkingLevel && supportsThinkingLevel(effortBase) ? thinkingLevel : null;

    const selectedModelId = model ?? DEFAULT_MODEL_ID;
    // Provider override: model do gateway của user định nghĩa (/v1/models),
    // cho phép ngoài danh sách built-in.
    if (!ALLOWED_MODEL_IDS.has(selectedModelId) && !providerBase) {
      return jsonError(
        requestId,
        400,
        'MODEL_NOT_ALLOWED',
        `Model '${selectedModelId}' không được hỗ trợ.`,
      );
    }
    // Chấp nhận id dạng `vendor/model` (OpenRouter: `openai/gpt-4o`, `~anthropic/...`).
    if (providerBase && !/^[\w.\-:~/]{1,120}$/.test(selectedModelId)) {
      return jsonError(requestId, 400, 'MODEL_NOT_ALLOWED', `Model '${selectedModelId}' không hợp lệ.`);
    }

    /* Sửa A11: tôn trọng capability của model. Provider override dùng model
       thẳng tới gateway của user, không chạy chuỗi fallback built-in. */
    const baseConfig = getModelConfig(selectedModelId);
    const modelConfig = providerBase
      ? { ...baseConfig, providerModel: selectedModelId }
      : baseConfig;
    const modelChain = providerBase
      ? [selectedModelId]
      : resolveProviderModelChain(baseConfig);
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

    // Provider override: key thuộc về gateway của user, không dùng pool env.
    const candidateResult = providerBase
      ? { keys: [customKey ?? 'provider-no-key'] }
      : customKey
        ? { keys: [customKey] }
        : getKeyCandidates();
    const candidateKeys = candidateResult.keys.slice(0, MAX_FAILOVER_KEYS);

    /* Gateway free dùng chung (crax/Kilgore): ngân sách theo IP server là
       CHUNG cho toàn bộ user — xếp hàng để tổng luôn trong ngưỡng công bố. */
    const queueBase =
      sharedFreeBudget(providerBase) && providerBase
        ? providerBase
        : sharedFreeBudget(process.env.OPENAI_BASE_URL)
          ? (process.env.OPENAI_BASE_URL as string)
          : null;
    if (queueBase) {
      const slot = await acquireUpstreamSlot(queueBase);
      if (!slot.ok) {
        return jsonError(
          requestId,
          429,
          'PROVIDER_BUSY',
          `Nhà cung cấp free đang đông (giới hạn chung). Thử lại sau ~${slot.retryAfterSec} giây nhé.`,
          undefined,
          { 'Retry-After': String(slot.retryAfterSec) },
        );
      }
    }
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

    const upstreamHost =
      hostOf(providerBase) ?? hostOf(process.env.OPENAI_BASE_URL) ?? 'api.openai.com';
    console.info(
      `[req:${requestId}] start model=${targetModel} upstream=${providerBase ? hostOf(providerBase) ?? providerBase : upstreamHost} keys=${candidateKeys.length}`,
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
              // Một số gateway (crax, Kilgore) không trả usage — ước lượng
              // token vào từ độ dài context để thống kê vẫn có dữ liệu.
              usage:
                usage && (usage.promptTokens || usage.completionTokens)
                  ? usage
                  : {
                      promptTokens: Math.ceil(JSON.stringify(contextMessages).length / 4),
                      completionTokens: 0,
                    },
            }),
          );
        };

        try {
          for (let attempt = 0; attempt < candidateKeys.length; attempt++) {
            const apiKey = candidateKeys[attempt];
            const keyLabel = getKeyLabel(apiKey);
            const openai = createOpenAI({
              apiKey,
              baseURL: providerBase ?? (process.env.OPENAI_BASE_URL || undefined),
            });

            for (let modelIndex = 0; modelIndex < modelChain.length; modelIndex++) {
              const targetModel = modelChain[modelIndex];
              let abortKind: AbortKind | null = null;
              // Tạo video cần vài phút — nới ngân sách riêng cho model video,
              // nhưng vẫn dưới trần 300s của nền tảng (xem VIDEO_BUDGET_MS).
              const budgetMs = isVideoModel(targetModel) ? VIDEO_BUDGET_MS : STREAM_BUDGET_MS;
              const budgetController = new AbortController();
              const budgetTimer = setTimeout(() => {
                abortKind = 'budget';
                budgetController.abort(
                  new Error(`Vượt quá ngân sách thời gian stream (${Math.round(budgetMs / 1000)}s).`),
                );
              }, budgetMs);

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

                /* Model media:
                   - Ảnh: ưu tiên /v1/images/generations chuẩn OpenAI (crax,
                     Kilgore đều hỗ trợ, trả URL); nếu gateway không có endpoint
                     này thì fallback qua chat SSE như trước.
                   - Video: chat SSE (crax `qwen-video` — event type:video). */
                if (isImageModel(targetModel) || isVideoModel(targetModel)) {
                  const base =
                    providerBase ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
                  const lastUser =
                    [...coreToOpenAiMessages(core)].reverse().find((m) => m.role === 'user')
                      ?.content ?? '';

                  const emitMedia = (kind: 'image' | 'video', url: string) => {
                    // Ảnh: markdown img. Video: markdown link (component `a`
                    // của renderer nhận diện .mp4/.webm và render <video>).
                    // Dùng cú pháp markdown tường minh cho cả hai để không phụ
                    // thuộc autolink — URL media có query `?key=<JWT>` rất dài.
                    if (kind === 'image') writeText(`\n\n![${targetModel}](${url})\n`);
                    else writeText(`\n\n[${targetModel}](${url})\n`);
                  };

                  if (isImageModel(targetModel)) {
                    try {
                      const imgRes = await fetch(`${base}/images/generations`, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${apiKey}`,
                        },
                        body: JSON.stringify({
                          model: targetModel,
                          prompt: lastUser.slice(0, 4000),
                          n: 1,
                        }),
                        signal: link.signal,
                      });
                      resetIdleTimer();
                      if (imgRes.ok) {
                        const j = (await imgRes.json().catch(() => null)) as {
                          data?: Array<{ url?: unknown; b64_json?: unknown }>;
                        } | null;
                        const item = j?.data?.[0];
                        const url =
                          typeof item?.url === 'string'
                            ? item.url
                            : typeof item?.b64_json === 'string'
                              ? `data:image/png;base64,${item.b64_json}`
                              : null;
                        if (url) {
                          emitMedia('image', url);
                          markKeySuccess(apiKey);
                          writeFinish('stop');
                          return;
                        }
                      }
                      // 404/501 (endpoint chưa có) hoặc data rỗng → fallback SSE.
                    } catch (e) {
                      if (e instanceof ChatUpstreamError || isAbortError(e)) throw e;
                      // lỗi mạng images API → thử đường chat SSE bên dưới.
                    }
                  }

                  const res = await fetch(`${base}/chat/completions`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                      model: targetModel,
                      messages: coreToOpenAiMessages(core),
                      stream: true,
                    }),
                    signal: link.signal,
                  });
                  if (!res.ok || !res.body) {
                    const bodyText = await res.text().catch(() => '');
                    // Trang lỗi HTML của gateway/CDN — không đem HTML vào message.
                    const detail = /^\s*(!doctype|<html)/i.test(bodyText)
                      ? 'gateway đang quá tải, thử lại sau.'
                      : redact(bodyText).slice(0, 200);
                    throw new ChatUpstreamError(
                      `Không tạo được media tại ${hostOf(base) ?? base} (${res.status}): ${detail}`,
                      `MEDIA_UPSTREAM_${res.status ?? 'ERROR'}`,
                      requestId,
                    );
                  }
                  resetIdleTimer();
                  let got = false;
                  await pumpSseData(res.body, (raw) => {
                    if (raw === '[DONE]') return;
                    let j: unknown;
                    try {
                      j = JSON.parse(raw);
                    } catch {
                      return;
                    }
                    resetIdleTimer();
                    const p = j as {
                      type?: string;
                      url?: unknown;
                      text?: unknown;
                      choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
                    };
                    if (p.type === 'image' && typeof p.url === 'string') {
                      got = true;
                      emitMedia('image', p.url);
                    } else if (p.type === 'video' && typeof p.url === 'string') {
                      got = true;
                      emitMedia('video', p.url);
                    } else if (p.type === 'status' && typeof p.text === 'string') {
                      // tiến trình tạo media — hiển thị như dòng suy luận.
                      writeText(`${p.text}\n`, 'reasoning');
                    } else {
                      const c = p.choices?.[0]?.delta?.content ?? p.choices?.[0]?.message?.content;
                      if (typeof c === 'string' && c) {
                        got = true;
                        writeText(c);
                      }
                    }
                  },
                  // Keepalive/comment line cũng là dấu hiệu upstream còn sống.
                  resetIdleTimer);
                  if (!got) writeText('_(Nhà cung cấp không trả về media nào)_');
                  markKeySuccess(apiKey);
                  writeFinish('stop');
                  return;
                }

                const result = streamText({
                  model: openai(targetModel),
                  messages: core,
                  ...(modelConfig.supportsTemperature === false
                    ? {}
                    : { temperature: temperature ?? 0.7 }),
                  ...(modelConfig.maxOutputTokens ? { maxTokens: modelConfig.maxOutputTokens } : {}),
                  ...(reasoningEffort
                    ? { providerOptions: { openai: { reasoningEffort } } }
                    : {}),
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
                /**
                 * Gateway đôi khi trả 200 + stream KHÔNG có token nào (crax
                 * lúc quá tải, model reasoning chỉ nhả reasoning bị gateway
                 * nuốt...). Kết thúc 'stop' im lặng ở đây = bong bóng rỗng
                 * không lời giải thích cho người dùng — báo EMPTY_RESPONSE
                 * để client hiện cảnh báo và gợi ý tạo lại.
                 */
                if (emittedChars === 0) {
                  console.warn(`[req:${requestId}] Stream kết thúc không có nội dung (model=${targetModel}).`);
                  writeAnnotation({ error: 'EMPTY_RESPONSE' });
                  writeFinish('other');
                  return;
                }
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
                  const budgetSec = Math.round(budgetMs / 1000);
                  /* Thông báo phải khớp ngân sách THỰC của lượt này: model video
                     dùng VIDEO_BUDGET_MS, không phải 270s như model chat. Video
                     chạm trần là do prompt nặng — gợi ý cách xử lý thay vì chỉ
                     báo lỗi kỹ thuật. */
                  const diagMsg = isIdle
                    ? `AI Provider ${upstreamHost} ngừng gửi token trong 60 giây, phiên stream đã bị hủy.`
                    : isVideoModel(targetModel)
                      ? `Video chưa xong trong ${budgetSec} giây — vượt giới hạn thời gian của nền tảng. Thử mô tả ngắn/đơn giản hơn, hoặc tạo lại.`
                      : `Phản hồi vượt quá ngân sách ${budgetSec} giây của Edge Function và đã bị cắt.`;
                  console.error(`[req:${requestId}][${code}] key=${keyLabel} model=${targetModel}`);
                  writeAnnotation({ error: code });
                  throw new ChatUpstreamError(diagMsg, code, requestId);
                }

                const diagnosis = diagnoseUpstreamError(e, {
                  requestId,
                  model: targetModel,
                  keyLabel,
                  providerBase,
                });
                console.error(diagnosis.devLog);

                if (diagnosis.blameKey) markKeyFailure(apiKey, diagnosis.status);

                // Chỉ dừng hẳn khi đã hết cả model lẫn key để thử.
                const isLast =
                  attempt === candidateKeys.length - 1 && modelIndex === modelChain.length - 1;
                if (emittedChars > 0 || diagnosis.stopFailover || isLast) {
                  writeAnnotation({ error: diagnosis.code });
                  throw new ChatUpstreamError(diagnosis.userMessage, diagnosis.code, requestId);
                }

                /**
                 * Lỗi KHÔNG phải của key (400 "unknown model", 4xx đặc thù model)
                 * mà đổi key cũng vô ích: thử MODEL kế tiếp trong chain trước.
                 * Đây là đường sống còn của model mặc định trên crax — crax đặt
                 * tên bằng gạch (`gpt-5-6-sol`) và trả 400 cho bản chấm
                 * (`gpt-5.6-sol`); phải rơi xuống biến thể gạch ngay sau đó thay
                 * vì `break` sang key khác rồi kết thúc stream với bong bóng trống.
                 */
                if (!diagnosis.blameKey && modelIndex < modelChain.length - 1) {
                  continue;
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