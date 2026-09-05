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
/* Kiểu dữ liệu — mirror payload của lib/ipc.cjs                  */
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

/** Job lệnh shell chạy nền (bg_run) — meta do lib/bg-jobs.cjs ghi trên đĩa. */
export interface VyenBgJob {
  id: string;
  command: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  exitCode: number | null;
  startedAt: number;
  finishedAt?: number;
  pid?: number;
  note?: string;
  /** Đuôi log (tối đa ~2000 ký tự) — log đầy đủ ở file bg-jobs. */
  outputTail?: string;
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
/* MCP — mirror payload của lib/mcp/ipc-handlers.cjs              */
/* ------------------------------------------------------------------ */

/** Trạng thái vòng đời của một MCP server. */
export type VyenMcpServerState = 'connected' | 'connecting' | 'disconnected' | 'error';

/**
 * Cấu hình MCP server do người dùng khai báo.
 * `id` bị khoá vào tập ký tự an toàn vì nó nằm trong tên tool mà model gọi.
 */
export type VyenMcpExposeMode = 'full' | 'proxy';

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
      exposeMode?: VyenMcpExposeMode;
    }
  | {
      id: string;
      name: string;
      transport: 'sse' | 'streamable-http';
      url: string;
      headers?: Record<string, string>;
      autoApprove?: string[];
      timeoutSecs?: number;
      exposeMode?: VyenMcpExposeMode;
    };

export interface VyenMcpServerStatus {
  id: string;
  name: string;
  status: VyenMcpServerState;
  error?: string;
  toolCount: number;
  serverVersion?: string;
  /** Thiếu field trong config cũ = 'full'. */
  exposeMode?: VyenMcpExposeMode;
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

/* ------------------------------------------------------------------ */
/* LLM fetch proxy + secure vault (giai đoạn 2 — desktop tự chủ)        */
/* ------------------------------------------------------------------ */

export interface VyenLlmFetchOptions {
  /** URL http(s) tuyệt đối của gateway (vd https://host/v1/models). */
  url: string;
  method: 'GET' | 'POST';
  /** Chỉ accept/authorization/content-type được phép qua main. */
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * Response BUFFER toàn bộ (không stream qua IPC) — đủ cho JSON như
 * /v1/models và /images/generations; SSE để dành giai đoạn sau.
 */
export interface VyenLlmFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  truncated?: boolean;
}

/** Kho mã hoá opt-in (safeStorage của OS) — chỉ tồn tại trên desktop. */
export interface VyenSecureStoreApi {
  available(): Promise<{ available: boolean }>;
  get(key: string): Promise<{ value: string | null }>;
  set(key: string, value: string): Promise<{ ok: true }>;
  delete(key: string): Promise<{ ok: true }>;
}

export interface VyenDoctorReport {
  ok: boolean;
  nodeVersion: string;
  platform: string;
  arch: string;
  workspaceRoot: string;
  isGit: boolean;
  packageJsonExists: boolean;
  memory: { rssMb: number; heapUsedMb: number };
  registeredChannels: string[];
}

export interface VyenTeamworkArtifacts {
  ok: boolean;
  workspaceRoot: string;
  hasTeamwork: boolean;
  request: { exists: boolean; content?: string; mtime?: string };
  plan: { exists: boolean; content?: string; mtime?: string };
  progress: { exists: boolean; content?: string; mtime?: string };
}

export interface VyenSecurityAuditFinding {
  id: string;
  ruleId: string;
  cwe: string;
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  file: string;
  line: number;
  codeSnippet: string;
  message: string;
  remediation: string;
}

export interface VyenSecurityAuditReport {
  ok: boolean;
  score?: number;
  grade?: 'A' | 'B' | 'C' | 'F';
  summary?: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    total: number;
  };
  findings?: VyenSecurityAuditFinding[];
  report?: string;
  workspaceRoot: string;
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
    /** Spawn detached — trả jobId NGAY, output ghi file, sống qua restart. */
    runBg(opts: { command: string; timeoutSecs?: number }): Promise<{ jobId: string; pid?: number; note?: string; error?: string }>;
    /** Không có id → liệt kê mọi job (đã reconcile job pid chết sau restart). */
    bgStatus(id?: string): Promise<{ jobs: VyenBgJob[] }>;
    bgStop(id: string): Promise<{ ok: true; note?: string }>;
  };
  git: {
    status(): Promise<VyenGitStatus>;
    diff(opts?: { relPath?: string; staged?: boolean }): Promise<string>;
    log(opts?: { limit?: number }): Promise<string>;
    add(relPaths: string[]): Promise<{ ok: true }>;
    commit(message: string): Promise<{ ok: true; output: string }>;
  };
  /**
   * Main-process fetch proxy — né CORS/403-Origin khi gọi gateway thẳng từ
   * renderer. Optional: shell Electron cũ hơn renderer không có — caller
   * PHẢI check trước khi dùng (giống `mcp`).
   */
  llm?: {
    fetch(opts: VyenLlmFetchOptions): Promise<VyenLlmFetchResult>;
  };
  /** Kho mã hoá safeStorage cho API key provider — optional như `llm`. */
  secure?: VyenSecureStoreApi;
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
    /** Đổi exposeMode ('full'|'proxy') không cần reconnect — chỉ ngữ cảnh model. */
    setExposeMode(id: string, mode: VyenMcpExposeMode): Promise<{ ok: true }>;
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
  /** Chẩn đoán sức khỏe hệ thống (Claude Code & MonkeyCode) */
  doctor?(): Promise<VyenDoctorReport>;
  /** Quản lý và kiểm tra tài liệu phân việc đa tác tử (MonkeyCode Triad) */
  teamworkArtifacts?(): Promise<VyenTeamworkArtifacts>;
  /** Kiểm toán an ninh mã nguồn & cấu hình (Chaitin MonkeyCode standard) */
  securityAudit?(): Promise<VyenSecurityAuditReport>;
}

/* ------------------------------------------------------------------ */
/* Access (Universal Dual-Mode: Native Electron + Universal Web Bridge)*/
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    vyen?: VyenBridge;
  }
}

/** Kiểm tra xem môi trường hiện tại có phải web chạy trên máy cục bộ (localhost). */
export function isLocalWebEnvironment(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Bridge token (server sinh theo phiên, launcher trao qua fragment)   */
/* ------------------------------------------------------------------ */

/* Tên này phải khớp lib/bridge/bridge-token.ts — không import trực tiếp
   vì module đó kéo node:fs vào bundle browser. */
const BRIDGE_TOKEN_HEADER = 'x-vyen-bridge-token';
const BRIDGE_TOKEN_STORAGE_KEY = 'vyen:bridge-token';

let bridgeTokenBootstrapped = false;
/** true sau khi server trả 401: bridge chết cho phiên này, không thử lại. */
let bridgeMarkedUnavailable = false;

/**
 * Hút bridge token khỏi fragment `#bt=<token>` do launcher gắn vào URL:
 * lưu vào sessionStorage (sống theo tab) rồi xoá fragment khỏi address bar
 * bằng replaceState — token không còn nằm trong URL, history hay referer.
 */
function bootstrapBridgeTokenFromUrl(): void {
  if (bridgeTokenBootstrapped || typeof window === 'undefined') return;
  bridgeTokenBootstrapped = true;
  try {
    const m = /(?:^#|&)bt=([^&]+)/.exec(window.location.hash);
    if (!m) return;
    const token = decodeURIComponent(m[1]);
    if (!token) return;
    window.sessionStorage.setItem(BRIDGE_TOKEN_STORAGE_KEY, token);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    // sessionStorage bị chặn (privacy mode) — bridge không có token, app
    // rơi về web mode thuần thay vì crash.
  }
}

function getBridgeToken(): string | null {
  bootstrapBridgeTokenFromUrl();
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage.getItem(BRIDGE_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function clearBridgeToken(): void {
  try {
    window.sessionStorage.removeItem(BRIDGE_TOKEN_STORAGE_KEY);
  } catch {
    // Bị chặn thì thôi — flag unavailable đã chặn bridge cho phiên này.
  }
}

async function callWebBridge<T>(channel: string, payload?: unknown): Promise<T> {
  const token = getBridgeToken();
  const res = await fetch('/api/bridge', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { [BRIDGE_TOKEN_HEADER]: token } : {}),
    },
    body: JSON.stringify({ channel, payload }),
  });
  if (res.status === 401) {
    // Token sai/hết hạn (server restart sinh token mới): xoá token cũ và
    // đánh dấu bridge unavailable để các tính năng fs/shell/git/mcp rơi về
    // nhánh "không khả dụng ngoài desktop" thay vì quăng lỗi kỹ thuật.
    clearBridgeToken();
    bridgeMarkedUnavailable = true;
    let detail = '';
    try {
      const errJson = (await res.json()) as { error?: string };
      if (errJson.error) detail = errJson.error;
    } catch {}
    throw new Error(
      detail ||
        'Tính năng này chỉ khả dụng trong Vyen desktop hoặc Web bridge cục bộ (bridge chưa được xác thực).',
    );
  }
  if (!res.ok) {
    let errorMsg = `Lỗi bridge (${res.status})`;
    try {
      const errJson = (await res.json()) as { error?: string };
      if (errJson.error) errorMsg = errJson.error;
    } catch {}
    throw new Error(errorMsg);
  }
  const data = (await res.json()) as { ok: boolean; result?: T; error?: string };
  if (data.ok === false) {
    throw new Error(data.error || `Bridge thất bại: ${channel}`);
  }
  return data.result as T;
}

/**
 * Tạo Universal Web Bridge kết nối tới Next.js API route (/api/bridge).
 * Cho phép Web UI có đầy đủ năng lực desktop (fs, shell, git, mcp) mà không cần Electron.
 */
function createWebBridge(): VyenBridge {
  return {
    desktop: true,
    platform: typeof navigator !== 'undefined' ? navigator.platform : 'web-local',
    electron: 'universal-web-bridge',
    workspace: {
      get: () => callWebBridge<{ path: string | null }>('vyen:workspace-get'),
      select: () => callWebBridge<{ path?: string; cancelled?: boolean }>('vyen:workspace-select'),
      set: (p: string) => callWebBridge<{ path: string }>('vyen:workspace-set', { path: p }),
      clear: () => callWebBridge<{ ok: true }>('vyen:workspace-clear'),
    },
    fs: {
      list: (relPath?: string) => callWebBridge<VyenFsEntry[]>('vyen:fs-list', { relPath: relPath ?? '' }),
      read: (relPath: string) => callWebBridge<{ content: string; size: number }>('vyen:fs-read', { relPath }),
      readImage: (relPath: string) =>
        callWebBridge<{ mimeType: string; base64: string; size: number }>('vyen:fs-read-image', { relPath }),
      write: (relPath: string, content: string) =>
        callWebBridge<{ size: number }>('vyen:fs-write', { relPath, content }),
      delete: (relPath: string) => callWebBridge<void>('vyen:fs-delete', { relPath }),
      stat: (relPath: string) => callWebBridge<VyenFsStat>('vyen:fs-stat', { relPath }),
      search: (opts) => callWebBridge<VyenSearchMatch[]>('vyen:fs-search', opts),
    },
    shell: {
      run: (opts) => callWebBridge<VyenRunResult>('vyen:shell-run', opts),
      runBg: (opts) => callWebBridge<{ jobId: string; pid?: number; note?: string; error?: string }>('vyen:bg-run', opts),
      bgStatus: (id?: string) => callWebBridge<{ jobs: VyenBgJob[] }>('vyen:bg-status', { id }),
      bgStop: (id: string) => callWebBridge<{ ok: true; note?: string }>('vyen:bg-stop', { id }),
    },
    git: {
      status: () => callWebBridge<VyenGitStatus>('vyen:git-status'),
      diff: (opts) => callWebBridge<string>('vyen:git-diff', opts ?? {}),
      log: (opts) => callWebBridge<string>('vyen:git-log', opts ?? {}),
      add: (relPaths: string[]) => callWebBridge<{ ok: true }>('vyen:git-add', { relPaths }),
      commit: (message: string) => callWebBridge<{ ok: true; output: string }>('vyen:git-commit', { message }),
    },
    llm: {
      fetch: (opts) => callWebBridge<VyenLlmFetchResult>('vyen:llm-fetch', opts),
    },
    secure: {
      available: () => callWebBridge<{ available: boolean }>('vyen:secure-available'),
      get: (key: string) => callWebBridge<{ value: string | null }>('vyen:secure-get', { key }),
      set: (key: string, value: string) => callWebBridge<{ ok: true }>('vyen:secure-set', { key, value }),
      delete: (key: string) => callWebBridge<{ ok: true }>('vyen:secure-delete', { key }),
    },
    mcp: {
      listServers: () => callWebBridge<VyenMcpServerStatus[]>('mcp:list-servers'),
      addServer: (config) => callWebBridge<VyenMcpServerStatus>('mcp:add-server', config),
      removeServer: (id: string) => callWebBridge<{ ok: true }>('mcp:remove-server', { id }),
      reconnect: (id: string) => callWebBridge<VyenMcpServerStatus>('mcp:reconnect', { id }),
      updateConfig: (servers) => callWebBridge<{ ok: true }>('mcp:update-config', { servers }),
      setExposeMode: (id: string, mode: VyenMcpExposeMode) =>
        callWebBridge<{ ok: true }>('mcp:set-expose-mode', { id, exposeMode: mode }),
      listTools: () => callWebBridge<VyenMcpToolInfo[]>('mcp:list-tools'),
      callTool: (serverId: string, toolName: string, args: Record<string, unknown>) =>
        callWebBridge<VyenMcpCallResult>('mcp:call-tool', { serverId, toolName, arguments: args }),
      resolveApproval: (approvalId: string, decision: VyenMcpPermissionDecision) =>
        callWebBridge<{ ok: true }>('mcp:resolve-approval', { approvalId, decision }),
      getPendingApprovals: () => callWebBridge<VyenMcpApprovalRequest[]>('mcp:get-pending-approvals'),
      getStatus: () => callWebBridge<{ servers: VyenMcpServerStatus[]; tools: number }>('mcp:get-status'),
      onApprovalRequested: () => () => {},
      onApprovalResolved: () => () => {},
      onServerStatus: () => () => {},
    },
    doctor: () => callWebBridge<VyenDoctorReport>('vyen:doctor'),
    teamworkArtifacts: () => callWebBridge<VyenTeamworkArtifacts>('vyen:teamwork-artifacts'),
    securityAudit: () => callWebBridge<VyenSecurityAuditReport>('vyen:security-audit'),
  };
}

let cachedWebBridge: VyenBridge | null = null;

/**
 * true khi app đang chạy trong Vyen desktop shell (Electron) HOẶC local Web
 * bridge có token phiên (mở qua launcher với fragment `#bt=`). Mở localhost
 * bằng tay không token → web mode thuần: tính năng fs/shell/git/mcp hiển thị
 * "không khả dụng ngoài desktop" thay vì truy cập /api/bridge.
 */
export function isVyenDesktop(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.vyen?.desktop === true) return true;
  if (bridgeMarkedUnavailable) return false;
  return isLocalWebEnvironment() && getBridgeToken() !== null;
}

/** Bridge hoặc null — caller web không cần check typeof window nữa. */
export function vyenDesktop(): VyenBridge | null {
  if (typeof window === 'undefined') return null;
  if (window.vyen?.desktop === true) return window.vyen;
  if (!bridgeMarkedUnavailable && isLocalWebEnvironment() && getBridgeToken() !== null) {
    if (!cachedWebBridge) {
      cachedWebBridge = createWebBridge();
    }
    return cachedWebBridge;
  }
  return null;
}

/** Bắt buộc desktop — ném lỗi rõ ràng thay vì undefined đi tiếp. */
export function requireVyenDesktop(): VyenBridge {
  const bridge = vyenDesktop();
  if (!bridge) {
    throw new Error('Tính năng này chỉ khả dụng trong Vyen desktop hoặc Web bridge cục bộ.');
  }
  return bridge;
}

/* ------------------------------------------------------------------ */
/* Giai đoạn 2 — desktop tự chủ                                        */
/* ------------------------------------------------------------------ */

/**
 * Gọi gateway LLM THẲNG TỪ MAIN PROCESS (Node fetch, không header Origin)
 * — gateway có allowlist origin (crax 403) không chặn được đường này.
 * Chỉ dùng trong desktop; ném lỗi rõ khi bridge/shell cũ không có.
 */
export function desktopLlmFetch(opts: VyenLlmFetchOptions): Promise<VyenLlmFetchResult> {
  const fetcher = vyenDesktop()?.llm?.fetch;
  if (!fetcher) {
    throw new Error(
      'llm-fetch không khả dụng — cần chạy trong Vyen desktop bản mới (restart app nếu vừa cập nhật).',
    );
  }
  return fetcher(opts);
}

/** Kho mã hoá key — null khi không phải desktop hoặc shell cũ. */
export function desktopSecureStore(): VyenSecureStoreApi | null {
  return vyenDesktop()?.secure ?? null;
}
