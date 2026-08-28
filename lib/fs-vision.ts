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
 * thành data URL → POST /api/vision (server giữ GEMINI_API_KEY) → nhận bản
 * mô tả text → trả về cho model như kết quả tool. Mọi thất bại đều trả object
 * lỗi mạch lạc (không ném ra ngoài) để model đọc được lý do và báo user tử tế.
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

const VISION_TIMEOUT_MS = 35_000;

type VisionApiResponse = { ok: true; description: string } | { ok: false; error: string } | null;

async function callVisionApi(
  dataUrl: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; description: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), VISION_TIMEOUT_MS);
  try {
    const res = await fetchImpl('/api/vision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
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
): Promise<WorkspaceImageToolResult> {
  let image: WorkspaceImageData;
  try {
    image = await readImage(rel);
  } catch (e) {
    return { error: e instanceof Error ? e.message : `Không đọc được ảnh "${rel}".` };
  }
  const r = await callVisionApi(image.dataUrl, fetchImpl);
  if (!r.ok) {
    return { path: image.path, kind: 'image', size: image.size, error: r.error };
  }
  return { path: image.path, kind: 'image', size: image.size, description: r.description };
}
