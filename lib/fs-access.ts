/**
 * Tầng File System Access API cho agent coding trong trình duyệt.
 *
 * Nguyên tắc bảo mật của spike này:
 * - Quyền giới hạn trong MỘT thư mục user TỰ CHỌN qua picker (mode readwrite)
 * - Handle persist vào IndexedDB (db.kv) để phiên sau khỏi chọn lại; nhưng
 *   quyền trình duyệt vẫn có thể bị thu hồi → mọi op trả lỗi rõ ràng kèm
 *   hướng dẫn nối lại thay vì treo
 * - Path tuyệt đối bị cấm: chỉ đường dẫn tương đối trong workspace, chặn '..'
 * - fs_write KHÔNG tự ghi: caller (chat-interface) phải chạy diff-confirm rồi
 *   mới gọi hàm ghi — tách bạch để test được và khó lạm dụng
 *
 * Các hàm op nhận root handle qua tham số (deps injection) để unit test với
 * fake handle mà không đụng API thật của trình duyệt.
 */

import { db } from '@/lib/db';

const KV_KEY = 'agent_workspace_root';
/** Thư mục luôn bỏ qua khi quét — đủ cho spike, chưa cần parse .gitignore đầy đủ. */
export const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.vercel',
]);

const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm|mov|mp3|wav|zip|gz|tar|rar|7z|pdf|docx?|xlsx?|pptx?|exe|dll|so|dylib|wasm|node|lock-bin)$/i;

/* ------------------------------------------------------------------ */
/* Kiểu cấu trúc tối thiểu — fake được trong test                      */
/* ------------------------------------------------------------------ */

export interface FsFileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

export interface FsDirHandleLike {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<FsFileHandleLike | FsDirHandleLike>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FsDirHandleLike>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FsFileHandleLike>;
}

export interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface FsWriteCapableFile extends FsFileHandleLike {
  createWritable(opts?: { keepExistingData?: boolean }): Promise<WritableLike>;
}

export interface FsDeps {
  root: FsDirHandleLike;
  /** Ghi file cần khả năng createWritable — tách kiểu để fake đơn giản. */
  writable?: boolean;
}

/* ------------------------------------------------------------------ */
/* Quản lý handle + quyền                                              */
/* ------------------------------------------------------------------ */

type AnyWin = Window & {
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FsDirHandleLike>;
};

let cachedRoot: FsDirHandleLike | null = null;
let cachedName: string | null = null;

export function getWorkspaceInfo(): { connected: boolean; name: string | null } {
  return { connected: cachedRoot !== null, name: cachedName };
}

/** Mở picker (PHẢI gọi từ user gesture — click nút). Lưu handle vào kv. */
export async function pickWorkspaceRoot(): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const picker = (typeof window !== 'undefined' ? (window as AnyWin).showDirectoryPicker : undefined);
  if (!picker) {
    return { ok: false, error: 'Trình duyệt không hỗ trợ File System Access API (cần Chrome/Edge).' };
  }
  try {
    const handle = await picker({ mode: 'readwrite', id: 'koda-workspace' });
    cachedRoot = handle;
    cachedName = handle.name;
    await db.kv.put({ key: KV_KEY, value: handle });
    return { ok: true, name: handle.name };
  } catch (e) {
    // User hủy picker là chuyện thường — báo nhẹ, không coi là lỗi hệ thống.
    const msg = e instanceof Error && e.name === 'AbortError' ? 'Đã hủy chọn thư mục.' : sanitizeFsError(e);
    return { ok: false, error: msg };
  }
}

/**
 * Khôi phục handle từ phiên trước. Quyền 'prompt' nghĩa là trình duyệt yêu
 * cầu user gesture để cấp lại — trả ok:true nhưng connected=false để UI hiện
 * nút "cấp quyền lại" thay vì âm thầm lỗi giữa lúc agent đang chạy.
 */
export async function restoreWorkspaceRoot(): Promise<{ ok: boolean; needsGesture: boolean }> {
  try {
    const entry = await db.kv.get(KV_KEY);
    const handle = entry?.value as FsDirHandleLike | undefined;
    if (!handle || handle.kind !== 'directory') return { ok: false, needsGesture: false };
    cachedRoot = handle;
    cachedName = handle.name;
    let perm: PermissionState | 'unknown' = 'unknown';
    try {
      perm = await (handle as unknown as { queryPermission(o: { mode: string }): Promise<PermissionState> }).queryPermission({ mode: 'readwrite' });
    } catch {
      /* queryPermission không có ở một số môi trường — coi như cần gesture. */
    }
    return { ok: true, needsGesture: perm === 'prompt' };
  } catch {
    return { ok: false, needsGesture: false };
  }
}

/** Lấy root đã kết nối cho các tool call; chưa có/quyền chưa cấp → lỗi mạch lạc. */
export async function requireWorkspace(): Promise<{ ok: true; deps: FsDeps } | { ok: false; error: string }> {
  if (!cachedRoot) {
    const restored = await restoreWorkspaceRoot();
    if (!restored.ok || restored.needsGesture || !cachedRoot) {
      return {
        ok: false,
        error:
          'Chưa kết nối thư mục làm việc hoặc quyền đã hết. Bấm nút 📁 trên composer để chọn/cấp quyền lại.',
      };
    }
  }
  return { ok: true, deps: { root: cachedRoot, writable: true } };
}

function sanitizeFsError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return msg.replace(/\b(sk|key)[\w-]*\s*[:=]\s*\S+/gi, '[redacted]').slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* Path an toàn                                                        */
/* ------------------------------------------------------------------ */

/**
 * Chuẩn hóa đường dẫn tương đối. Trả null khi nguy hiểm: tuyệt đối, chứa '..',
 * drive letter, backdot trá hình. Dấu `\` chuẩn hóa thành `/`.
 */
export function normalizeRelPath(raw: string): string | null {
  if (!raw) return '';
  let p = String(raw).replace(/\\/g, '/').trim();
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('//')) return null;
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  const segs = p.split('/').filter((s) => s.length > 0);
  if (segs.some((s) => s === '.' )) return segs.filter((s) => s !== '.').join('/') || '';
  if (p.split('/').includes('..')) return null;
  return segs.join('/');
}

/* ------------------------------------------------------------------ */
/* Ops                                                                 */
/* ------------------------------------------------------------------ */

async function resolveDir(deps: FsDeps, relPath: string, create: boolean): Promise<FsDirHandleLike> {
  let dir = deps.root;
  for (const seg of relPath.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

export interface FsEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
}

/** Liệt kê MỘT cấp thư mục — agent đi từng bước thay vì quét cả cây. */
export async function fsList(deps: FsDeps, relPath: string): Promise<FsEntry[]> {
  const dir = await resolveDir(deps, relPath, false);
  const out: FsEntry[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') {
      let size: number | undefined;
      try {
        size = (await (entry as FsFileHandleLike).getFile()).size;
      } catch {
        /* file biến mất giữa chừng — bỏ qua size */
      }
      out.push({ name: entry.name, type: 'file', size });
    } else {
      out.push({ name: entry.name, type: 'dir' });
    }
  }
  return out.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
}

export interface FsReadResult {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
}

const MAX_READ_CHARS = 24_000;

/** Đọc file text; trần ký tự chống nuốt cả file build vào context. */
export async function fsRead(
  deps: FsDeps,
  rawPath: string,
  maxChars: number = MAX_READ_CHARS,
): Promise<FsReadResult> {
  const path = normalizeRelPath(rawPath);
  if (path === null) throw new Error(`Đường dẫn không hợp lệ: "${rawPath}"`);
  const segs = path.split('/').filter(Boolean);
  const fileName = segs.pop();
  if (!fileName) throw new Error('Thiếu tên file.');
  const dir = await resolveDir(deps, segs.join('/'), false);
  const handle = await dir.getFileHandle(fileName);
  const file = await handle.getFile();
  const text = await file.text();
  return {
    path,
    content: text.slice(0, maxChars),
    truncated: text.length > maxChars,
    size: file.size,
  };
}

/** Ghi file (create hoặc đè). Caller chịu trách nhiệm đã có xác nhận diff. */
export async function fsWrite(
  deps: FsDeps,
  rawPath: string,
  content: string,
): Promise<{ path: string; bytes: number; created: boolean }> {
  const path = normalizeRelPath(rawPath);
  if (path === null) throw new Error(`Đường dẫn không hợp lệ: "${rawPath}"`);
  if (!path) throw new Error('Thiếu tên file.');
  const segs = path.split('/').filter(Boolean);
  const fileName = segs.pop();
  if (!fileName) throw new Error('Thiếu tên file.');

  const dir = await resolveDir(deps, segs.join('/'), true);
  let created = false;
  try {
    await dir.getFileHandle(fileName); // tồn tại?
  } catch {
    created = true;
  }
  const handle = (await dir.getFileHandle(fileName, { create: true })) as FsWriteCapableFile;
  const writable = await handle.createWritable({ keepExistingData: false });
  await writable.write(content);
  await writable.close();
  return { path, bytes: content.length, created };
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchOptions {
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
  /** Ngân sách thời gian ms — quét lớn phải biết dừng. */
  timeBudgetMs?: number;
}

/**
 * Tìm chuỗi/regex trong toàn bộ file text của workspace (đệ quy có ignore).
 * Không có ripgrep-WASM trong spike — scanner JS thẳng với trần thời gian.
 */
export async function fsSearch(
  deps: FsDeps,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchMatch[]> {
  if (!query.trim()) return [];
  const { isRegex = false, caseSensitive = false, maxResults = 30, timeBudgetMs = 4000 } = opts;
  let matcher: (line: string) => boolean;
  if (isRegex) {
    const re = new RegExp(query, caseSensitive ? '' : 'i');
    matcher = (line) => re.test(line);
  } else {
    const needle = caseSensitive ? query : query.toLowerCase();
    matcher = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  const deadline = Date.now() + timeBudgetMs;
  const results: SearchMatch[] = [];
  let scannedFiles = 0;
  const MAX_FILES = 600;

  const walk = async (dir: FsDirHandleLike, prefix: string): Promise<void> => {
    if (results.length >= maxResults || scannedFiles >= MAX_FILES || Date.now() > deadline) return;
    for await (const entry of dir.values()) {
      if (results.length >= maxResults || scannedFiles >= MAX_FILES || Date.now() > deadline) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          await walk(entry as FsDirHandleLike, rel);
        }
        continue;
      }
      if (BINARY_EXT_RE.test(entry.name)) continue;
      scannedFiles += 1;
      try {
        const file = await (entry as FsFileHandleLike).getFile();
        if (file.size > 512_000) continue; // file quá lớn bỏ qua
        const text = await file.text();
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matcher(lines[i])) {
            results.push({
              path: rel,
              line: i + 1,
              text: lines[i].trim().slice(0, 200),
            });
            if (results.length >= maxResults) return;
          }
        }
      } catch {
        /* file đọc lỗi (khóa/encoding) — bỏ qua im lặng */
      }
    }
  };

  await walk(deps.root, '');
  return results;
}
