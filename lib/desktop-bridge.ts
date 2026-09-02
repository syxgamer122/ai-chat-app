/**
 * Typed client cho Vyen desktop bridge (`window.vyen`).
 *
 * Renderer KHÔNG bao giờ gọi window.vyen trực tiếp — đi qua module này để:
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

export interface VyenFsEntry {
  name: string;
  kind: 'file' | 'directory';
  size: number;
  mtimeMs: number;
}

export interface VyenFsStat {
  exists: boolean;
  kind?: 'file' | 'directory';
  size?: number;
  mtimeMs?: number;
}

export interface VyenRunResult {
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

export interface VyenSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface VyenSearchOptions {
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface VyenGitStatusEntry {
  x: string;
  y: string;
  path: string;
  origPath?: string;
}

export interface VyenGitStatus {
  branch: string | null;
  entries: VyenGitStatusEntry[];
}

/* ------------------------------------------------------------------ */
/* MCP — mirror payload của electron/mcp/ipc-handlers.cjs              */
/* ------------------------------------------------------------------ */

/** Trạng thái vòng đời của một MCP server. */
export type VyenMcpServerState = 'connected' | 'connecting' | 'disconnected' | 'error';

/**
 * Cấu hình MCP server do người dùng khai báo.
 * `id` bị khoá vào tập ký tự an toàn vì nó nằm trong tên tool mà model gọi.
 */
export type VyenMcpServerConfig =
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

export interface VyenMcpServerStatus {
  id: string;
  name: string;
  status: VyenMcpServerState;
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
export type VyenMcpToolInfo = McpToolInfo;

/** Một khối nội dung trong CallToolResult của MCP. */
export interface VyenMcpContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface VyenMcpCallResult {
  /** Mảng content nguyên vẹn từ MCP server. */
  content: VyenMcpContent[];
  /** true = tool CHẠY RỒI NHƯNG BÁO LỖI NGHIỆP VỤ (khác với lỗi giao thức). */
  isError: boolean;
  /** true = bị chặn bởi policy "luôn từ chối" hoặc người dùng bấm từ chối. */
  denied?: boolean;
}

export type VyenMcpPermissionDecision =
  | 'allow_once'
  | 'always_allow'
  | 'deny_once'
  | 'always_deny';

export interface VyenMcpApprovalRequest {
  id: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

export interface VyenBridge {
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
    list(relPath?: string): Promise<VyenFsEntry[]>;
    read(relPath: string): Promise<{ content: string; size: number }>;
    /** Có thể thiếu nếu renderer mới hơn main (app chưa restart) — caller phải check. */
    readImage?(relPath: string): Promise<{ mimeType: string; base64: string; size: number }>;
    write(relPath: string, content: string): Promise<{ size: number }>;
    delete(relPath: string): Promise<void>;
    stat(relPath: string): Promise<VyenFsStat>;
    search(opts: { query: string } & VyenSearchOptions): Promise<VyenSearchMatch[]>;
  };
  shell: {
    run(opts: { command: string; cwd?: string; timeoutMs?: number }): Promise<VyenRunResult>;
  };
  git: {
    status(): Promise<VyenGitStatus>;
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
    listServers(): Promise<VyenMcpServerStatus[]>;
    addServer(config: VyenMcpServerConfig): Promise<VyenMcpServerStatus>;
    removeServer(id: string): Promise<{ ok: true }>;
    reconnect(id: string): Promise<VyenMcpServerStatus>;
    updateConfig(servers: VyenMcpServerConfig[]): Promise<{ ok: true }>;
    listTools(): Promise<VyenMcpToolInfo[]>;
    callTool(
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<VyenMcpCallResult>;
    resolveApproval(approvalId: string, decision: VyenMcpPermissionDecision): Promise<{ ok: true }>;
    getPendingApprovals(): Promise<VyenMcpApprovalRequest[]>;
    getStatus(): Promise<{ servers: VyenMcpServerStatus[]; tools: number }>;
    onApprovalRequested(cb: (req: VyenMcpApprovalRequest) => void): () => void;
    onApprovalResolved(
      cb: (res: { id: string; decision: VyenMcpPermissionDecision; timedOut?: boolean }) => void,
    ): () => void;
    onServerStatus(cb: (status: VyenMcpServerStatus) => void): () => void;
  };
}

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    vyen?: VyenBridge;
  }
}

/** true khi app đang chạy trong Vyen desktop shell (Electron). */
export function isVyenDesktop(): boolean {
  return typeof window !== 'undefined' && window.vyen?.desktop === true;
}

/** Bridge hoặc null — caller web không cần check typeof window nữa. */
export function vyenDesktop(): VyenBridge | null {
  if (typeof window === 'undefined') return null;
  return window.vyen?.desktop === true ? window.vyen : null;
}

/** Bắt buộc desktop — ném lỗi rõ ràng thay vì undefined đi tiếp. */
export function requireVyenDesktop(): VyenBridge {
  const bridge = vyenDesktop();
  if (!bridge) {
    throw new Error('Tính năng này chỉ khả dụng trong Vyen desktop (Electron).');
  }
  return bridge;
}
