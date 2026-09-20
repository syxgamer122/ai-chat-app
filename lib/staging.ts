/**
 * Staging Diff Sandbox — bộ đệm thay đổi của agent TRƯỚC KHI chạm đĩa.
 *
 * Mô hình "cumulative diff review sandbox" về mô hình
 * client-side của Vyen:
 *  - fs_edit/fs_write KHÔNG ghi đĩa — ghi vào overlay (bộ đệm trong RAM).
 *  - fs_read ĐỌC OVERLAY TRƯỚC, đĩa sau — agent tự thấy kết quả sửa của mình,
 *    tránh doom-loop "sửa rồi đọc lại vẫn cũ".
 *  - User review cả batch: Apply tất cả (checkpoint → ghi đĩa) hoặc Reject
 *    (chỉ xóa overlay — ĐĨA CHƯA BAO GIỜ BỊ ĐỤNG, không cần restore).
 *
 * Thuần function, không Dexie/React — test được trong node như phần còn lại
 * của lib/. Persist do caller đảm nhiệm (kv table) qua serialize/parse.
 */

import { lineDiff, type DiffLine } from '@/lib/naive-diff';
import { normalizePathKey } from '@/lib/path-utils';

/** Chuẩn hóa path — delegate to shared utility. Re-export cho backward compat. */
const normalizeStagingPath = normalizePathKey;
export { normalizeStagingPath };

/**
 * Tính mã băm SHA-256 cho chuỗi nội dung văn bản.
 * Chạy được cả trong Browser (Web Crypto) và Node.js.
 */
export async function computeSha256(content: string | null): Promise<string | null> {
  if (content === null) return null;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const data = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  try {
    const nodeCrypto = await import('node:crypto');
    return nodeCrypto.createHash('sha256').update(content, 'utf8').digest('hex');
  } catch {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }
}

/**
 * Kiểm tra xem hash SHA-256 của file trên đĩa hiện tại có khớp với baseHash đã ghi nhận trước đó hay không.
 * Giúp ngăn chặn TOCTOU (Time-of-Check to Time-of-Use) race conditions khi ghi đĩa hoặc apply diffs.
 */
export async function verifyDiskHash(
  currentDiskContent: string | null,
  expectedBaseHash: string | null | undefined,
): Promise<{ matches: boolean; currentHash: string | null }> {
  const currentHash = await computeSha256(currentDiskContent);
  if (expectedBaseHash === undefined) {
    return { matches: true, currentHash };
  }
  return { matches: currentHash === expectedBaseHash, currentHash };
}

export interface StagedFile {
  /**
   * Path NGUYÊN VĂN từ tool call — dùng để GHI ĐĨA + hiển thị. FS trên
   * Linux/macOS phân biệt hoa thường: ghi bằng path đã lowercase sẽ tạo file
   * MỚI (readme.md) thay vì sửa file thật (README.md). Khoá record trong
   * store là path đã qua normalizeStagingPath, KHÔNG phải field này.
   */
  path: string;
  /**
   * Nội dung đĩa TẠI THỜI ĐIỂM STAGE ĐẦU TIÊN — dùng cho diff hiển thị.
   * null = file MỚI (chưa tồn tại trên đĩa lúc stage).
   * Stage lần 2+ giữ nguyên original đầu tiên: diff luôn so với đĩa gốc.
   */
  original: string | null;
  /** Nội dung đã stage (kết quả tích lũy mọi lần sửa). */
  content: string;
  stagedAt: number;
  /** SHA-256 hash của original trên đĩa tại thời điểm stage đầu tiên (null nếu file mới). */
  baseHash?: string | null;
}

/** Key của record = path đã chuẩn hóa (normalizeStagingPath). Plain object để
 *  serialize JSON được. Value giữ path NGUYÊN VĂN để apply ghi đĩa đúng file. */
export type StagingStore = Record<string, StagedFile>;

export function emptyStagingStore(): StagingStore {
  return {};
}

export function stagingCount(store: StagingStore): number {
  return Object.keys(store).length;
}

/**
 * Đưa nội dung mới vào staging. Nếu file đã staged từ trước: GIỮ `original`
 * và `path` của lần đầu (diff so với đĩa gốc; path đầu tiên là path model
 * dùng đọc được file trên đĩa — đúng case nhất), cập nhật content.
 * Record được đặt dưới key = normalizeStagingPath(path) để các lần stage
 * khác hoa thường/prefix dồn về MỘT record, nhưng `path` giữ nguyên văn.
 * Trả store mới (immutable — caller là React state/ref dễ quản lý).
 */
export function stageFile(
  store: StagingStore,
  path: string,
  diskOriginal: string | null,
  content: string,
  baseHash?: string | null,
): StagingStore {
  const key = normalizeStagingPath(path);
  const existing = store[key];
  return {
    ...store,
    [key]: {
      path: existing ? existing.path : path,
      original: existing ? existing.original : diskOriginal,
      content,
      stagedAt: Date.now(),
      baseHash: existing?.baseHash !== undefined ? existing.baseHash : (baseHash !== undefined ? baseHash : null),
    },
  };
}

/** Bỏ một file khỏi staging (reject từng file). Đĩa không bị đụng.
 *  Chấp nhận CẢ path nguyên văn lẫn path đã chuẩn hóa — normalizeStagingPath
 *  đưa hai dạng về cùng một key. */
export function unstageFile(store: StagingStore, path: string): StagingStore {
  const key = normalizeStagingPath(path);
  if (!(key in store)) return store;
  const next = { ...store };
  delete next[key];
  return next;
}

export function clearStaging(_store: StagingStore): StagingStore {
  return {};
}

/** Thống kê ± dòng cho một file staged. */
export function stagedFileDiff(file: StagedFile): DiffLine[] {
  return lineDiff(file.original ?? '', file.content);
}

export interface StagingStats {
  files: number;
  addedLines: number;
  removedLines: number;
  newFiles: number;
}

/** Tổng hợp ± dòng toàn batch — hiển thị trên badge/panel. */
export function stagingStats(store: StagingStore): StagingStats {
  let addedLines = 0;
  let removedLines = 0;
  let newFiles = 0;
  for (const file of Object.values(store)) {
    if (file.original === null) newFiles += 1;
    for (const line of lineDiff(file.original ?? '', file.content)) {
      if (line.type === 'add') addedLines += 1;
      else if (line.type === 'del') removedLines += 1;
    }
  }
  return {
    files: stagingCount(store),
    addedLines,
    removedLines,
    newFiles,
  };
}

/* ------------------------------------------------------------------ */
/* Persist — serialize vào Dexie kv                                    */
/* ------------------------------------------------------------------ */

const MAX_STAGED_FILES = 50;
const MAX_STAGED_FILE_CHARS = 400_000;

/**
 * Serialize để lưu kv. Trần 50 file / 400k ký tự mỗi file — chặn một lượt
 * agent điên cuồng nhồi cả repo vào IndexedDB. Vượt trần → file bị bỏ, caller
 * thấy count lệch là biết.
 */
export function serializeStaging(store: StagingStore): string {
  const entries = Object.values(store)
    .filter((f) => f.content.length <= MAX_STAGED_FILE_CHARS)
    .slice(0, MAX_STAGED_FILES);
  return JSON.stringify(entries);
}

/** Parse từ kv. JSON rác / sai shape → store rỗng (an toàn hơn ném). */
export function parseStaging(raw: unknown): StagingStore {
  if (typeof raw !== 'string') return {};
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!Array.isArray(entries)) return {};
  const out: StagingStore = {};
  for (const e of entries) {
    const f = e as Partial<StagedFile>;
    if (typeof f?.path !== 'string' || !f.path) continue;
    if (typeof f?.content !== 'string') continue;
    if (f.original !== null && typeof f.original !== 'string') continue;
    // Key MUST be the normalized path (same invariant as stageFile/unstageFile).
    // Re-keying by the raw path made restored overlays invisible to fs_read/fs_edit
    // and allowed a duplicate record to be created for the same file.
    out[normalizeStagingPath(f.path)] = {
      path: f.path,
      original: f.original ?? null,
      content: f.content,
      stagedAt: typeof f.stagedAt === 'number' ? f.stagedAt : Date.now(),
      baseHash: typeof f.baseHash === 'string' ? f.baseHash : (f.baseHash === null ? null : undefined),
    };
  }
  return out;
}

/** Key lưu kv. Staging là tài nguyên WORKSPACE-LEVEL (một workspace active). */
export const STAGING_KV_KEY = 'staging:current';
