/**
 * Vision bridge — model KHÔNG hỗ trợ ảnh vẫn "đọc" được ảnh đính kèm.
 *
 * Vấn đề: route /api/chat gửi attachment đi bất kể model có nhìn được không
 * (config `supportsImages: false` của DeepSeek V3/R1, MiniMax, o1-mini...).
 * Model chữ nhận image part sẽ trả 400 hoặc bỏ qua im lặng — người dùng thấy
 * "nó không thấy ảnh của mình".
 *
 * Giải pháp (port ý tưởng từ opencode-vision-bridge): trước khi gọi upstream,
 * ảnh (data URL) được gửi cho Gemini free kèm prompt "mô tả chi tiết + chép
 * nguyên văn mọi chữ", phần ảnh trong message được THAY bằng bản mô tả text.
 * Model biết nhìn ảnh không bị động vào. Gemini lỗi/hết quota/thiếu key →
 * giữ nguyên attachment (trở về hành vi cũ), không bao giờ làm hỏng tin nhắn.
 *
 * Cache mô tả theo SHA-256 của ảnh: cùng một ảnh gửi lại (vd tin nhắn sau
 * trong cùng hội thoại) không gọi Gemini lần nữa — tiết kiệm quota free tier.
 */

/**
 * Model Gemini dùng để mô tả — bản flash-LITE: hạng rẻ nhất, không "think"
 * (không đốt output token cho suy nghĩ) và free-tier rộng nhất, dư sức đọc
 * chữ/mô tả ảnh. Đã verify với key mới: 2.5-flash bị khóa ("no longer
 * available to new users"), 3.5-flash-lite thì OK. Khi Google khai tử tiếp,
 * đổi tại đây hoặc set env GEMINI_VISION_MODEL mà không cần sửa code.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

export const VISION_BRIDGE_PROMPT =
  'You are describing images for a text-only AI assistant that cannot see ' +
  'pixels. Describe each image exhaustively but concisely: overall type ' +
  '(screenshot, photo, diagram, chart, document...), layout, key objects and ' +
  'their relationships. Transcribe ALL text VERBATIM — every label, error ' +
  'message, code line and number, preserving reading order. If the image ' +
  'contains a question or a task, state it explicitly.';

export interface BridgeableAttachment {
  name?: string;
  contentType?: string;
  url?: string;
}

export interface BridgeableMessage {
  role: string;
  /** Schema của route cho phép string | mảng parts — chỉ bridge message dạng string. */
  content: unknown;
  experimental_attachments?: BridgeableAttachment[];
}

interface ImagePayload {
  mimeType: string;
  base64: string;
}

/**
 * Chỉ nhận data URL base64 (`data:image/...;base64,...`) — hình thức client
 * lưu blob trong IndexedDB và gửi lên route. Ảnh http(s) remote không bridge
 * được ở đây (Gemini REST cần file API riêng cho URL) nên giữ nguyên.
 */
export function extractImageDataUrl(url: string): ImagePayload | null {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url ?? '');
  if (!m) return null;
  return { mimeType: m[1].toLowerCase(), base64: m[2].replace(/\s+/g, '') };
}

/** Bridge chỉ chạy cho model chữ thuần; model media (tạo ảnh/video) bỏ qua. */
export function shouldBridgeImages(model: {
  supportsImages: boolean;
  media?: unknown;
}): boolean {
  return model.supportsImages === false && !model.media;
}

export function buildGeminiPayload(images: ImagePayload[], prompt: string): unknown {
  return {
    contents: [
      {
        parts: [
          { text: prompt },
          ...images.map((img) => ({
            inline_data: { mime_type: img.mimeType, data: img.base64 },
          })),
        ],
      },
    ],
    // Model 3.x là thinking model: thought token trừ vào maxOutputTokens —
    // budget thấp quá sẽ trả text RỖNG (finishReason MAX_TOKENS).
    generationConfig: { temperature: 0.2, maxOutputTokens: 2_048 },
  };
}

/** Bóc text từ response `generateContent`; không có candidate hợp lệ → null. */
export function parseGeminiDescription(json: unknown): string | null {
  const candidates = (json as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const parts = (candidates[0] as { content?: { parts?: unknown } })?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .map((p) => (p && typeof p === 'object' ? (p as { text?: unknown }).text : undefined))
    .filter((t): t is string => typeof t === 'string')
    .join('')
    .trim();
  return text || null;
}

export function appendDescription(content: string, description: string): string {
  const block = `[Ảnh đính kèm — mô tả tự động cho model không xem được ảnh]\n${description}`;
  return content ? `${content}\n\n${block}` : block;
}

/* ------------------------------------------------------------------ */
/* Cache mô tả theo nội dung ảnh                                       */
/* ------------------------------------------------------------------ */

const DESC_CACHE_MAX = 64;
const descriptionCache = new Map<string, string>();

async function imageDigestKey(base64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ------------------------------------------------------------------ */
/* Gọi Gemini                                                          */
/* ------------------------------------------------------------------ */

const GEMINI_TIMEOUT_MS = 25_000;
const RETRY_DELAYS_MS = [0, 800, 2_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BridgeDeps {
  apiKey: string;
  geminiModel?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Gửi NHÓM ảnh trong một request (một mô tả cho cả nhóm — cùng cách plugin
 * gốc gom nhiều ảnh thành một call để tiết kiệm RPM). Trả null khi nên bỏ
 * qua: lỗi mạng, 4xx (trừ 429), response không đọc được, hoặc hết lượt retry.
 */
async function describeImageBatch(
  images: ImagePayload[],
  deps: BridgeDeps,
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const model = deps.geminiModel || DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt]) await sleep(RETRY_DELAYS_MS[attempt]);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('Gemini timeout')), GEMINI_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': deps.apiKey },
        body: JSON.stringify(buildGeminiPayload(images, VISION_BRIDGE_PROMPT)),
        signal: timeout.signal,
      });
      if (res.status === 429 || res.status >= 500) continue; // quá tải → thử lại
      if (!res.ok) return null;
      const json = (await res.json().catch(() => null)) as unknown;
      return parseGeminiDescription(json);
    } catch {
      continue; // lỗi mạng/timeout → retry; hết lượt thì thoát vòng
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Thay mọi ảnh data-URL trong messages bằng mô tả Gemini. Message không có
 * ảnh data-URL được giữ nguyên tham chiếu; có ảnh mà Gemini fail → giữ nguyên
 * message đó (không bridge nửa chừng). Không đổi gì khi không cần bridge.
 */
export async function bridgeImagesInMessages(
  messages: readonly BridgeableMessage[],
  deps: BridgeDeps,
): Promise<readonly BridgeableMessage[]> {
  const out: BridgeableMessage[] = [];
  let changed = false;

  for (const message of messages) {
    // Chỉ bridge message có content dạng string; dạng mảng parts (hiếm) giữ
    // nguyên để không đụng vào cấu trúc phần tử.
    if (typeof message.content !== 'string') {
      out.push(message);
      continue;
    }
    const atts = message.experimental_attachments ?? [];
    const imageSlots: number[] = [];
    const payloads: ImagePayload[] = [];
    atts.forEach((att, i) => {
      if (!att.contentType?.startsWith('image/')) return;
      const payload = extractImageDataUrl(att.url ?? '');
      if (!payload) return;
      imageSlots.push(i);
      payloads.push(payload);
    });

    if (!imageSlots.length) {
      out.push(message);
      continue;
    }

    const keys = await Promise.all(payloads.map((p) => imageDigestKey(p.base64)));
    const descriptions: (string | null)[] = keys.map((k) => descriptionCache.get(k) ?? null);
    const uncached = descriptions
      .map((d, i) => (d === null ? i : -1))
      .filter((i) => i >= 0);

    if (uncached.length) {
      const text = await describeImageBatch(
        uncached.map((i) => payloads[i]),
        deps,
      );
      if (text === null) {
        out.push(message); // Gemini hỏng → giữ message nguyên trạng
        continue;
      }
      for (const i of uncached) {
        descriptions[i] = text;
        if (descriptionCache.size >= DESC_CACHE_MAX) {
          descriptionCache.delete(descriptionCache.keys().next().value as string);
        }
        descriptionCache.set(keys[i], text);
      }
    }

    const block = descriptions
      .map((d, i) => (descriptions.length > 1 ? `[Ảnh ${i + 1}]\n${d}` : (d as string)))
      .join('\n\n');

    const remaining = atts.filter((_, i) => !imageSlots.includes(i));
    out.push({
      ...message,
      content: appendDescription(message.content, block),
      experimental_attachments: remaining.length ? remaining : undefined,
    });
    changed = true;
  }

  // Không bridge được message nào → trả nguyên mảng gốc (cùng tham chiếu),
  // đúng như hợp đồng: caller có thể so sánh === để biết "không có gì đổi".
  return changed ? out : messages;
}

/** Dùng cho test — xoá cache mô tả giữa các case. */
export function resetVisionBridgeCache(): void {
  descriptionCache.clear();
}
