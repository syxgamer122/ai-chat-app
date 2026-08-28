/**
 * Typed client cho Koda desktop bridge (`window.koda`).
 *
 * Renderer KHÔNG bao giờ gọi window.koda trực tiếp — đi qua module này để:
 * - feature-detect an toàn (SSR/web: trả null, caller rẽ nhánh về FSA API)
 * - có type một chỗ, preload và main tự do refactor nội bộ
 * - normalize lỗi Electron (string) thành Error chuẩn cho catch phía app
 *
 * Giai đoạn 2: chỉ là cầu. Giai đoạn 3 sẽ bọc thành FsDeps adapter cho
 * lib/fs-access.ts + tool shell_run/git_* trong agent-tools.
 */

/* ------------------------------------------------------------------ */
/* Kiểu dữ liệu — mirror payload của electron/ipc.cjs                  */
/* ------------------------------------------------------------------ */

export interface KodaFsEntry {
  name: string;
  kind: 'file' | 'directory';
  size: number;
  mtimeMs: number;
}

export interface KodaFsStat {
  exists: boolean;
  kind?: 'file' | 'directory';
  size?: number;
  mtimeMs?: number;
}

export interface KodaRunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface KodaSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface KodaSearchOptions {
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface KodaGitStatusEntry {
  x: string;
  y: string;
  path: string;
  origPath?: string;
}

export interface KodaGitStatus {
  branch: string | null;
  entries: KodaGitStatusEntry[];
}

export interface KodaBridge {
  desktop: true;
  platform: string;
  electron: string;
  workspace: {
    get(): Promise<{ path: string | null }>;
    select(): Promise<{ path?: string; cancelled?: boolean }>;
    set(path: string): Promise<{ path: string }>;
    /** Có thể thiếu nếu renderer mới hơn main (app chưa restart) — caller phải check. */
    clear?(): Promise<{ ok: true }>;
  };
  fs: {
    list(relPath?: string): Promise<KodaFsEntry[]>;
    read(relPath: string): Promise<{ content: string; size: number }>;
    /** Có thể thiếu nếu renderer mới hơn main (app chưa restart) — caller phải check. */
    readImage?(relPath: string): Promise<{ mimeType: string; base64: string; size: number }>;
    write(relPath: string, content: string): Promise<{ size: number }>;
    delete(relPath: string): Promise<void>;
    stat(relPath: string): Promise<KodaFsStat>;
    search(opts: { query: string } & KodaSearchOptions): Promise<KodaSearchMatch[]>;
  };
  shell: {
    run(opts: { command: string; cwd?: string; timeoutMs?: number }): Promise<KodaRunResult>;
  };
  git: {
    status(): Promise<KodaGitStatus>;
    diff(opts?: { relPath?: string; staged?: boolean }): Promise<string>;
    log(opts?: { limit?: number }): Promise<string>;
    add(relPaths: string[]): Promise<{ ok: true }>;
    commit(message: string): Promise<{ ok: true; output: string }>;
  };
}

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    koda?: KodaBridge;
  }
}

/** true khi app đang chạy trong Koda desktop shell (Electron). */
export function isKodaDesktop(): boolean {
  return typeof window !== 'undefined' && window.koda?.desktop === true;
}

/** Bridge hoặc null — caller web không cần check typeof window nữa. */
export function kodaDesktop(): KodaBridge | null {
  if (typeof window === 'undefined') return null;
  return window.koda?.desktop === true ? window.koda : null;
}

/** Bắt buộc desktop — ném lỗi rõ ràng thay vì undefined đi tiếp. */
export function requireKodaDesktop(): KodaBridge {
  const bridge = kodaDesktop();
  if (!bridge) {
    throw new Error('Tính năng này chỉ khả dụng trong Koda desktop (Electron).');
  }
  return bridge;
}
