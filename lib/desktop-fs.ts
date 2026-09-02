/**
 * Adapter filesystem cho Vyen desktop (Electron).
 * Mọi op đi qua window.vyen IPC bridge (electron/ipc.cjs),
 * giữ nguyên contract với lib/fs-access.ts để chat-interface
 * không phải fork logic diff/search.
 */
import { isVyenDesktop, vyenDesktop } from '@/lib/desktop-bridge';

// Mirror trần của lib/fs-access.ts — giữ đồng bộ để desktop không
// đọc được nhiều hơn web rồi làm phình context ở nơi khác.
const MAX_READ_CHARS = 24_000;
const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm|mov|mp3|wav|zip|gz|tar|rar|7z|pdf|docx?|xlsx?|pptx?|exe|dll|so|dylib|wasm|node|lock-bin)$/i;

export interface FsEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
}
export interface FsReadResult {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  startLine: number;
  endLine: number;
}
export interface FsReadOptions {
  maxChars?: number;
  startLine?: number;
  lineCount?: number;
}
export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

function requireBridge() {
  const b = vyenDesktop();
  if (!b) throw new Error('Vyen desktop bridge chưa sẵn sàng.');
  return b;
}

export function isDesktopAvailable(): boolean {
  return isVyenDesktop();
}

export async function desktopGetWorkspaceInfo(): Promise<{ connected: boolean; name: string | null }> {
  const b = requireBridge();
  const r = await b.workspace.get();
  if (!r.path) return { connected: false, name: null };
  // Lấy basename làm tên hiển thị (Windows: split cả \ và /)
  const name = r.path.split(/[\\/]/).filter(Boolean).pop() ?? r.path;
  return { connected: true, name };
}

export async function desktopPickWorkspaceRoot(): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const b = requireBridge();
  // Ưu tiên dialog native (vyen:workspace-select) nếu preload expose;
  // fallback về set() khi test/smoke dùng VYEN_WORKSPACE_ROOT.
  const k = b as unknown as { workspace: { select?: () => Promise<{ path?: string; cancelled?: boolean }> } };
  if (k.workspace.select) {
    const r = await k.workspace.select();
    if ((r as { cancelled?: boolean }).cancelled) return { ok: false, error: 'Đã hủy chọn thư mục.' };
    const p = (r as { path?: string }).path;
    if (p) {
      const name = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
      return { ok: true, name };
    }
  }
  // Fallback: yêu cầu đã có workspace (trường hợp set qua env)
  const info = await desktopGetWorkspaceInfo();
  if (info.connected) return { ok: true, name: info.name! };
  return { ok: false, error: 'Chưa chọn workspace.' };
}

export async function desktopDisconnectWorkspace(): Promise<{ connected: boolean; name: string | null }> {
  const b = requireBridge();
  if (typeof b.workspace.clear !== 'function') {
    throw new Error('Vyen desktop cần khởi động lại để hỗ trợ ngắt kết nối (main process cũ).');
  }
  await b.workspace.clear();
  return { connected: false, name: null };
}

export async function desktopRequireWorkspace(): Promise<{ ok: true } | { ok: false; error: string }> {
  const info = await desktopGetWorkspaceInfo();
  if (!info.connected) {
    return { ok: false, error: 'Chưa kết nối thư mục làm việc trong Vyen desktop. Bấm 📁 trên composer để chọn thư mục.' };
  }
  return { ok: true };
}

export async function desktopFsList(relPath: string): Promise<FsEntry[]> {
  const b = requireBridge();
  const entries = await b.fs.list(relPath ?? '');
  return entries
    .map((e) => ({ name: e.name, type: e.kind === 'directory' ? ('dir' as const) : ('file' as const), size: e.size }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

export async function desktopFsRead(rawPath: string, options: number | FsReadOptions = MAX_READ_CHARS): Promise<FsReadResult> {
  const b = requireBridge();
  if (BINARY_EXT_RE.test(rawPath.split('/').pop() ?? '')) {
    throw new Error(
      `"${rawPath}" là file nhị phân (ảnh/font/video/tài liệu nén), không đọc được bằng fs_read. ` +
        'Nếu cần xem ảnh, hãy yêu cầu người dùng đính kèm ảnh đó trực tiếp vào khung chat.',
    );
  }
  const r = await b.fs.read(rawPath);
  if (r.content.slice(0, 1024).includes('\u0000')) {
    throw new Error(`"${rawPath}" trông như file nhị phân (chứa byte NUL), không đọc được bằng fs_read.`);
  }
  const opts = typeof options === 'number' ? { maxChars: options } : options;
  const maxChars = opts.maxChars ?? MAX_READ_CHARS;
  const allLines = r.content.split('\n');
  const startIndex = Math.min(Math.max(0, Math.floor((opts.startLine ?? 1) - 1)), Math.max(0, allLines.length - 1));
  const endIndex = opts.lineCount ? Math.min(allLines.length, startIndex + Math.max(1, Math.floor(opts.lineCount))) : allLines.length;
  const selected = allLines.slice(startIndex, endIndex).join('\n');
  return {
    path: rawPath,
    content: selected.slice(0, maxChars),
    truncated: endIndex < allLines.length || selected.length > maxChars,
    size: r.size,
    startLine: startIndex + 1,
    endLine: endIndex,
  };
}

export interface DesktopImageReadResult {
  path: string;
  mimeType: string;
  dataUrl: string;
  size: number;
}

/** Đọc ảnh workspace thành data URL cho luồng vision — mirror fsReadImage web. */
export async function desktopFsReadImage(rawPath: string): Promise<DesktopImageReadResult> {
  const b = requireBridge();
  if (typeof b.fs.readImage !== 'function') {
    throw new Error('Vyen desktop cần khởi động lại để hỗ trợ đọc ảnh (main process cũ).');
  }
  const r = await b.fs.readImage(rawPath);
  return {
    path: rawPath,
    mimeType: r.mimeType,
    dataUrl: `data:${r.mimeType};base64,${r.base64}`,
    size: r.size,
  };
}

export async function desktopFsWrite(rawPath: string, content: string): Promise<{ path: string; bytes: number; created: boolean }> {
  const b = requireBridge();
  // Xác định created bằng stat trước khi ghi
  let created = true;
  try {
    const st = await b.fs.stat(rawPath);
    if (st.exists) created = false;
  } catch {
    // stat ném (chưa có file) → coi như created
  }
  const r = await b.fs.write(rawPath, content);
  return { path: rawPath, bytes: r.size, created };
}

export async function desktopFsDelete(rawPath: string): Promise<{ path: string }> {
  const b = requireBridge();
  await b.fs.delete(rawPath);
  return { path: rawPath };
}

export async function desktopFsSearch(
  query: string,
  opts: { isRegex?: boolean; caseSensitive?: boolean; maxResults?: number } = {},
): Promise<SearchMatch[]> {
  const b = requireBridge();
  return b.fs.search({ query, isRegex: opts.isRegex, caseSensitive: opts.caseSensitive, maxResults: opts.maxResults });
}

export async function desktopFsReadFull(
  rawPath: string,
): Promise<{ status: 'ok'; path: string; content: string } | { status: 'missing'; path: string } | { status: 'too-large'; path: string; size: number }> {
  const b = requireBridge();
  try {
    const st = await b.fs.stat(rawPath);
    if (!st.exists) return { status: 'missing', path: rawPath };
    if ((st.size ?? 0) > 512_000) return { status: 'too-large', path: rawPath, size: st.size! };
    const r = await b.fs.read(rawPath);
    return { status: 'ok', path: rawPath, content: r.content };
  } catch {
    return { status: 'missing', path: rawPath };
  }
}
