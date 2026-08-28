/**
 * Staging Diff Sandbox — bộ đệm thay đổi của agent TRƯỚC KHI chạm đĩa.
 *
 * Port mô hình "cumulative diff review sandbox" của Plandex (MIT) về mô hình
 * client-side của KODA:
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

export interface StagedFile {
  /** Path đã chuẩn hóa — khóa của record. */
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
}

/** Key = path đã chuẩn hóa. Plain object để serialize JSON được. */
export type StagingStore = Record<string, StagedFile>;

export function emptyStagingStore(): StagingStore {
  return {};
}

export function stagingCount(store: StagingStore): number {
  return Object.keys(store).length;
}

/**
 * Đưa nội dung mới vào staging. Nếu file đã staged từ trước: GIỮ `original`
 * của lần đầu (diff so với đĩa gốc), cập nhật content.
 * Trả store mới (immutable — caller là React state/ref dễ quản lý).
 */
export function stageFile(
  store: StagingStore,
  path: string,
  diskOriginal: string | null,
  content: string,
): StagingStore {
  const key = normalizeStagingPath(path);
  const existing = store[key];
  return {
    ...store,
    [key]: {
      path: key,
      original: existing ? existing.original : diskOriginal,
      content,
      stagedAt: Date.now(),
    },
  };
}

/** Bỏ một file khỏi staging (reject từng file). Đĩa không bị đụng. */
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
    out[f.path] = {
      path: f.path,
      original: f.original ?? null,
      content: f.content,
      stagedAt: typeof f.stagedAt === 'number' ? f.stagedAt : Date.now(),
    };
  }
  return out;
}

/** Key lưu kv. Staging là tài nguyên WORKSPACE-LEVEL (một workspace active). */
export const STAGING_KV_KEY = 'staging:current';
