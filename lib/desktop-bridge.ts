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

import type { McpToolInfo } from '@/lib/mcp/tool-mapper';

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
  /** True khi output bị cắt bởi smart truncation (Goose-style). */
  truncated?: boolean;
  /** Đường dẫn temp file chứa full output (khi truncated). */
  savedTo?: string;
  /** Hướng dẫn LLM đọc full output từ temp file. */
  previewHint?: string;
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

/* ------------------------------------------------------------------ */
/* MCP — mirror payload của electron/mcp/ipc-handlers.cjs              */
/* ------------------------------------------------------------------ */

/** Trạng thái vòng đời của một MCP server. */
export type KodaMcpServerState = 'connected' | 'connecting' | 'disconnected' | 'error';

/**
 * Cấu hình MCP server do người dùng khai báo.
 * `id` bị khoá vào tập ký tự an toàn vì nó nằm trong tên tool mà model gọi.
 */
export type KodaMcpServerConfig =
  | {
      id: string;
      name: string;
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      autoApprove?: string[];
      timeoutSecs?: number;
    }
  | {
      id: string;
      name: string;
      transport: 'sse' | 'streamable-http';
      url: string;
      headers?: Record<string, string>;
      autoApprove?: string[];
      timeoutSecs?: number;
    };

export interface KodaMcpServerStatus {
  id: string;
  name: string;
  status: KodaMcpServerState;
  error?: string;
  toolCount: number;
  serverVersion?: string;
}

/**
 * Tool do MCP server công bố.
 * Alias của `McpToolInfo` (lib/mcp/tool-mapper) để một định dạng tool chỉ tồn
 * tại ở một nơi — `import type` nên không kéo runtime của tool-mapper vào
 * bundle của bridge.
 */
export type KodaMcpToolInfo = McpToolInfo;

/** Một khối nội dung trong CallToolResult của MCP. */
export interface KodaMcpContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface KodaMcpCallResult {
  /** Mảng content nguyên vẹn từ MCP server. */
  content: KodaMcpContent[];
  /** true = tool CHẠY RỒI NHƯNG BÁO LỖI NGHIỆP VỤ (khác với lỗi giao thức). */
  isError: boolean;
  /** true = bị chặn bởi policy "luôn từ chối" hoặc người dùng bấm từ chối. */
  denied?: boolean;
}

export type KodaMcpPermissionDecision =
  | 'allow_once'
  | 'always_allow'
  | 'deny_once'
  | 'always_deny';

export interface KodaMcpApprovalRequest {
  id: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
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
  /**
   * Có thể thiếu hoàn toàn khi app chạy trên web hoặc khi shell Electron cũ
   * hơn bản renderer — mọi caller PHẢI check trước khi dùng.
   */
  mcp?: {
    listServers(): Promise<KodaMcpServerStatus[]>;
    addServer(config: KodaMcpServerConfig): Promise<KodaMcpServerStatus>;
    removeServer(id: string): Promise<{ ok: true }>;
    reconnect(id: string): Promise<KodaMcpServerStatus>;
    updateConfig(servers: KodaMcpServerConfig[]): Promise<{ ok: true }>;
    listTools(): Promise<KodaMcpToolInfo[]>;
    callTool(
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<KodaMcpCallResult>;
    resolveApproval(approvalId: string, decision: KodaMcpPermissionDecision): Promise<{ ok: true }>;
    getPendingApprovals(): Promise<KodaMcpApprovalRequest[]>;
    getStatus(): Promise<{ servers: KodaMcpServerStatus[]; tools: number }>;
    onApprovalRequested(cb: (req: KodaMcpApprovalRequest) => void): () => void;
    onApprovalResolved(
      cb: (res: { id: string; decision: KodaMcpPermissionDecision; timedOut?: boolean }) => void,
    ): () => void;
    onServerStatus(cb: (status: KodaMcpServerStatus) => void): () => void;
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
