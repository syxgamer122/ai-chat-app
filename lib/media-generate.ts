/**
 * Sinh ảnh / video NGAY TRONG TRÌNH DUYỆT, gọi thẳng gateway.
 *
 * KHI NÀO đường này dùng được: chỉ với gateway (a) cho phép cross-origin từ
 * origin của trang, và (b) có API key nằm phía client (IndexedDB). Key trong
 * env của server không bao giờ được gửi ra browser.
 *
 * KHÔNG dùng được với crax: crax chỉ allowlist origin của chính site họ, mọi
 * request kèm header `Origin` (tức mọi fetch từ trình duyệt) đều bị trả
 * 403 "Origin not allowed" — đã kiểm chứng bằng request thật, cùng URL bỏ
 * `Origin` thì 200. crax cũng không đọc `Authorization`, nên không có key phía
 * client để bật đường này. Lượt media crax do đó đi qua /api/chat, và ở đó
 * vẫn kịp: video đo được 120-126s, dưới trần 300s của Vercel.
 *
 * Giữ lại module vì `originBlocked` là cơ chế fallback tự động: gateway nào
 * cho phép CORS + có key client thì hưởng lợi (không đụng giới hạn thời gian
 * của serverless), gateway nào chặn thì tự quay về đường server.
 */

import { validateProviderBaseUrl } from '@/lib/provider-url';
import { pumpSseLines } from '@/lib/sse';

export type MediaKind = 'image' | 'video';

export interface MediaRequest {
  kind: MediaKind;
  /** baseUrl chuẩn OpenAI, ví dụ https://gpt.crax.lol/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

export interface MediaResult {
  kind: MediaKind;
  url: string;
  /** Markdown để ghi vào nội dung tin nhắn assistant. */
  markdown: string;
}

export class MediaGenerationError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    /**
     * true = gateway từ chối chính *origin* của trang (allowlist phía gateway),
     * hoặc trình duyệt chặn vì CORS. Lượt này phải đi lại qua server proxy.
     */
    public readonly originBlocked = false,
  ) {
    super(message);
    this.name = 'MediaGenerationError';
  }
}

/**
 * Dùng CHUNG một chính sách baseUrl với server (`lib/provider-url.ts`).
 *
 * Trước đây hàm này tự kiểm tra và chỉ chặn non-https, nên một baseUrl trỏ vào
 * mạng nội bộ (`https://10.0.0.5/v1`, `https://nas.local/v1`) bị server từ chối
 * nhưng vẫn được browser gọi kèm `Authorization: Bearer <key>` — vừa SSRF từ
 * trình duyệt vào LAN của người dùng, vừa gửi key tới host tuỳ ý.
 */
function assertSafeBase(baseUrl: string): string {
  const check = validateProviderBaseUrl(baseUrl);
  if (!check.ok) throw new MediaGenerationError(check.error);
  if (!/^https:/i.test(check.url) && !/^http:\/\/localhost(?::\d+)?(?:\/|$)/i.test(check.url)) {
    throw new MediaGenerationError('Nhà cung cấp phải dùng https:// để gọi được từ trình duyệt.');
  }
  return check.url;
}

function mediaMarkdown(kind: MediaKind, model: string, url: string): string {
  // Ảnh: cú pháp image. Video: cú pháp link — markdown-renderer nhận diện
  // đuôi .mp4/.webm rồi render <video controls>.
  return kind === 'image' ? `![${model}](${url})` : `[${model}](${url})`;
}

async function errorFromResponse(res: Response): Promise<MediaGenerationError> {
  const raw = await res.text().catch(() => '');
  if (/^\s*(<!doctype|<html)/i.test(raw)) {
    return new MediaGenerationError(
      `Gateway trả về trang lỗi (${res.status}) — có thể đang quá tải, thử lại sau.`,
      res.status,
    );
  }
  let detail = raw.slice(0, 200);
  try {
    const j = JSON.parse(raw) as { error?: unknown };
    const e = j?.error;
    if (typeof e === 'string') detail = e;
    else if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
      detail = (e as { message: string }).message;
    }
  } catch {
    /* giữ raw */
  }

  /**
   * Gateway crax có allowlist origin: gọi từ domain lạ trả 403
   * "Origin not allowed" dù key hợp lệ. Đánh dấu để caller fallback qua server
   * (server không gửi Origin nên không bị chặn).
   */
  if (res.status === 403 && /origin/i.test(detail)) {
    return new MediaGenerationError(
      'Gateway không cho phép gọi trực tiếp từ tên miền này.',
      res.status,
      true,
    );
  }

  const hint =
    res.status === 401 || res.status === 403
      ? ' Kiểm tra lại API key của nhà cung cấp.'
      : res.status === 404
        ? ' Model này không có trên gateway.'
        : '';
  return new MediaGenerationError(
    `Tạo media thất bại (${res.status})${detail ? `: ${detail}` : ''}.${hint}`,
    res.status,
  );
}

/**
 * fetch + chuẩn hoá lỗi mạng. Trình duyệt chặn CORS chỉ ném TypeError
 * ("Failed to fetch") không kèm chi tiết — coi như origin bị chặn để caller
 * fallback qua server proxy thay vì báo lỗi cho người dùng.
 */
async function mediaFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new MediaGenerationError(
      'Không gọi được gateway trực tiếp từ trình duyệt (CORS hoặc mạng).',
      undefined,
      true,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Ảnh: POST /images/generations (đồng bộ, trả URL hoặc base64)         */
/* ------------------------------------------------------------------ */

async function generateImage(req: MediaRequest, base: string): Promise<MediaResult> {
  req.onProgress?.('Đang tạo ảnh…');
  const res = await mediaFetch(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({ model: req.model, prompt: req.prompt.slice(0, 4000), n: 1 }),
    signal: req.signal,
  });

  if (!res.ok) throw await errorFromResponse(res);

  const json = (await res.json().catch(() => null)) as {
    data?: Array<{ url?: unknown; b64_json?: unknown }>;
  } | null;
  const item = json?.data?.[0];
  const url =
    typeof item?.url === 'string'
      ? item.url
      : typeof item?.b64_json === 'string'
        ? `data:image/png;base64,${item.b64_json}`
        : null;

  if (!url) throw new MediaGenerationError('Gateway không trả về ảnh nào.');
  return { kind: 'image', url, markdown: mediaMarkdown('image', req.model, url) };
}

/* ------------------------------------------------------------------ */
/* Video: chat SSE, event {"type":"status"} rồi {"type":"video","url"}  */
/* ------------------------------------------------------------------ */

/** Đọc từng payload `data:` của một SSE stream (dùng chung với edge route). */
const pumpSse = (
  body: ReadableStream<Uint8Array>,
  onData: (raw: string) => void,
): Promise<void> => pumpSseLines(body, onData);

async function generateVideo(req: MediaRequest, base: string): Promise<MediaResult> {
  req.onProgress?.('Đang gửi yêu cầu tạo video…');
  const res = await mediaFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model,
      messages: [{ role: 'user', content: req.prompt.slice(0, 4000) }],
      stream: true,
    }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) throw await errorFromResponse(res);

  let url: string | null = null;
  let text = '';

  await pumpSse(res.body, (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const p = parsed as {
      type?: string;
      url?: unknown;
      text?: unknown;
      choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
    };

    if ((p.type === 'video' || p.type === 'image') && typeof p.url === 'string') {
      url = p.url;
    } else if (p.type === 'status' && typeof p.text === 'string') {
      req.onProgress?.(p.text);
    } else {
      const c = p.choices?.[0]?.delta?.content ?? p.choices?.[0]?.message?.content;
      if (typeof c === 'string') text += c;
    }
  });

  if (url) {
    return { kind: 'video', url, markdown: mediaMarkdown('video', req.model, url) };
  }

  // Một số gateway nhúng link ngay trong text thay vì event riêng.
  const found = /https?:\/\/\S+\.(?:mp4|webm)(?:\?\S*)?/i.exec(text)?.[0];
  if (found) {
    return { kind: 'video', url: found, markdown: mediaMarkdown('video', req.model, found) };
  }

  throw new MediaGenerationError(
    text.trim()
      ? `Gateway không trả về video. Phản hồi: ${text.trim().slice(0, 200)}`
      : 'Gateway không trả về video nào.',
  );
}

export async function generateMedia(req: MediaRequest): Promise<MediaResult> {
  if (!req.apiKey) {
    throw new MediaGenerationError(
      'Nhà cung cấp này chưa có API key ở phía trình duyệt — mở Cài đặt để dán key rồi thử lại.',
    );
  }
  if (!req.prompt.trim()) {
    throw new MediaGenerationError('Cần mô tả nội dung muốn tạo.');
  }
  const base = assertSafeBase(req.baseUrl);
  return req.kind === 'image' ? generateImage(req, base) : generateVideo(req, base);
}
