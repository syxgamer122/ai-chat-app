/**
 * Cầu nối fs_read → vision cho ảnh TRONG workspace đã kết nối.
 *
 * Vấn đề gốc (lỗi người dùng thật gặp): agent gọi fs_read("image.png"),
 * bytes PNG bị decode thành text rác rồi gửi cho model → model bịa ra
 * "ERROR: Cannot read "image.png" (this model does not support image input)".
 * Guard từ chối file nhị phân đã chặn chỗ đó, nhưng người dùng muốn AI
 * "nhìn thấy" ảnh chứ không chỉ nhận lời từ chối.
 *
 * Luồng: client đọc bytes ảnh (web: File System Access; desktop: IPC base64)
 * thành data URL → POST /api/vision (provider active BYOK, headers do caller
 * truyền) → nhận bản mô tả text → trả về cho model như kết quả tool. Mọi thất
 * bại đều trả object lỗi mạch lạc (không ném ra ngoài) để model đọc được lý
 * do và báo user tử tế.
 */

/** Đuôi ảnh chấp nhận cho luồng vision — mirror IMAGE_VISION_EXT_RE của lib/fs-access.ts. */
export const IMAGE_VISION_EXT_RE = /\.(png|jpe?g|webp|heic|heif)$/i;

export function isImagePath(relPath: string): boolean {
  const name = relPath.split(/[\\/]/).pop() ?? '';
  return IMAGE_VISION_EXT_RE.test(name);
}

export interface WorkspaceImageData {
  path: string;
  dataUrl: string;
  size: number;
}

/** Đọc ảnh workspace thành data URL — phía caller chọn desktop hoặc web reader. */
export type WorkspaceImageReader = (relPath: string) => Promise<WorkspaceImageData>;

export interface WorkspaceImageToolResult {
  path?: string;
  kind?: 'image';
  size?: number;
  description?: string;
  error?: string;
}

/**
 * Tùy chọn cho lượt gọi /api/vision. File này KHÔNG import store/zustand —
 * caller (UI) tự lấy headers provider + model vision từ state rồi truyền
 * xuống, giữ module thuần để test và chạy được ở mọi ngữ cảnh renderer.
 */
export interface VisionCallOpts {
  /** Headers BYOK (x-api-key, x-api-base...) — /api/vision cần để gọi provider active. */
  headers?: Record<string, string>;
  /** Model vision client chọn từ danh sách model của provider — route yêu cầu bắt buộc. */
  model?: string;
}

const VISION_TIMEOUT_MS = 35_000;

type VisionApiResponse = { ok: true; description: string } | { ok: false; error: string } | null;

async function callVisionApi(
  dataUrl: string,
  fetchImpl: typeof fetch,
  opts?: VisionCallOpts,
): Promise<{ ok: true; description: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), VISION_TIMEOUT_MS);
  try {
    const res = await fetchImpl('/api/vision', {
      method: 'POST',
      // Gắn headers provider + model vision: /api/vision chỉ mô tả ảnh bằng
      // provider active của người dùng — thiếu là 400/503 từ route.
      headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
      body: JSON.stringify({ dataUrl, ...(opts?.model ? { model: opts.model } : {}) }),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as VisionApiResponse;
    if (!json) return { ok: false, error: `Không đọc được phản hồi từ /api/vision (HTTP ${res.status}).` };
    if (json.ok && typeof json.description === 'string' && json.description.trim()) {
      return { ok: true, description: json.description };
    }
    return {
      ok: false,
      error: (!json.ok && json.error) || `Không mô tả được ảnh (HTTP ${res.status}).`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Lỗi gọi /api/vision: ${msg}`.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trả về object JSON-able cho tool result của fs_read trên file ảnh.
 * Luôn resolve — lỗi được nhét vào field `error` kèm hướng dẫn.
 */
export async function describeWorkspaceImage(
  rel: string,
  readImage: WorkspaceImageReader,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
  opts?: VisionCallOpts,
): Promise<WorkspaceImageToolResult> {
  let image: WorkspaceImageData;
  try {
    image = await readImage(rel);
  } catch (e) {
    return { error: e instanceof Error ? e.message : `Không đọc được ảnh "${rel}".` };
  }
  const r = await callVisionApi(image.dataUrl, fetchImpl, opts);
  if (!r.ok) {
    return { path: image.path, kind: 'image', size: image.size, error: r.error };
  }
  return { path: image.path, kind: 'image', size: image.size, description: r.description };
}

/**
 * Mô tả MỘT data URL ảnh — dùng cho ảnh do tool MCP trả về (không có rel
 * path trong workspace). Đặt tên khác `describeImageDataUrl` của
 * lib/vision-bridge.ts (bản server-side, chữ ký khác) để không nhầm lẫn.
 * Throw khi /api/vision lỗi để caller (lib/mcp/image-content) tự hóa lỗi
 * thành khối text ghi chú.
 *
 * LƯU Ý chữ ký: tham số 2 là fetchImpl (test), KHÔNG khớp McpImageDescriber
 * của lib/mcp/image-content (tham số 2 là mimeType) — caller PHẢI bọc lambda
 * khi truyền làm describer.
 */
export async function describeMcpImage(
  dataUrl: string,
  fetchImpl: typeof fetch = fetch.bind(globalThis),
  opts?: VisionCallOpts,
): Promise<string> {
  const r = await callVisionApi(dataUrl, fetchImpl, opts);
  if (!r.ok) throw new Error(r.error);
  return r.description;
}
