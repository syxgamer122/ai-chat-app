/**
 * Server-side Universal Bridge Dispatcher (Goose / Pi architecture).
 *
 * Cho phép Web UI (trình duyệt) và Fast Desktop Shell (Edge/Chrome App Mode)
 * truy cập 100% năng lực hệ thống (filesystem, shell_run, git_*, mcp_*) mà KHÔNG
 * cần chạy qua Electron cồng kềnh.
 *
 * Tái sử dụng trọn vẹn logic đã được kiểm chứng từ `lib/ipc.cjs` và
 * `lib/mcp/ipc-handlers.cjs`:
 * - Path-guard khóa chặt thao tác vào workspace root (chống traversal).
 * - Goose-style smart truncation cho shell output (không làm phình context LLM).
 * - MCP tool execution và approval workflow.
 * - Secure store và LLM fetch proxy.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ensureBridgeToken } from './bridge-token';

const require = createRequire(import.meta.url);

type Handler = (_event: unknown, payload?: unknown) => Promise<unknown> | unknown;

interface BridgeDispatcher {
  handlers: Map<string, Handler>;
  initialized: boolean;
  workspaceRoot: string;
}

let dispatcherInstance: BridgeDispatcher | null = null;

export function getBridgeUserDataDir(): string {
  const custom = process.env.VYEN_USER_DATA_DIR;
  if (custom && fs.existsSync(custom)) return custom;

  // Giữ thư mục userData chuẩn của Vyen ('ai-chat')
  const baseDir =
    process.platform === 'win32'
      ? process.env.APPDATA || os.homedir()
      : path.join(os.homedir(), '.config');

  const target = path.join(baseDir, 'ai-chat');
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    // fallback to tmp
    return os.tmpdir();
  }
  return target;
}

export function initServerBridge(): BridgeDispatcher {
  if (dispatcherInstance && dispatcherInstance.initialized) {
    return dispatcherInstance;
  }

  // Nạp/sinh bridge token trước khi đăng ký handler — mọi request /api/bridge
  // từ đây về sau đều phải mang token này (xem lib/bridge/bridge-token.ts).
  ensureBridgeToken();

  const handlers = new Map<string, Handler>();
  const fakeIpc = {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
  };

  const userDataDir = getBridgeUserDataDir();
  const defaultWorkspace = process.env.VYEN_WORKSPACE_ROOT || process.cwd();

  // 1. Register base IPC handlers (fs, shell, git, workspace, secure, llm)
  try {
    const ipcModule = require('../ipc.cjs');
    ipcModule.register(fakeIpc, {
      userDataDir,
      audit: (msg: string) => {
        if (process.env.DEBUG_VYEN_BRIDGE === '1') {
          console.log(`[bridge] ${msg}`);
        }
      },
      workspaceOverride: defaultWorkspace,
    });
  } catch (err) {
    console.error('[bridge] Failed to load lib/ipc.cjs:', err);
  }

  // 2. Register MCP IPC handlers (tools, servers, approvals)
  try {
    const mcpModule = require('../mcp/ipc-handlers.cjs');
    mcpModule.register(fakeIpc, {
      userDataDir,
      audit: (msg: string) => {
        if (process.env.DEBUG_VYEN_BRIDGE === '1') {
          console.log(`[bridge:mcp] ${msg}`);
        }
      },
    }).catch((e: unknown) => {
      console.warn('[bridge] MCP registration async warning:', e);
    });
  } catch (err) {
    console.error('[bridge] Failed to load lib/mcp/ipc-handlers.cjs:', err);
  }

  // 3. Fallback cho workspace:select khi chạy web/desktop không có dialog Electron
  const originalWorkspaceSelect = handlers.get('vyen:workspace-select');
  handlers.set('vyen:workspace-select', async (event, payload) => {
    try {
      if (originalWorkspaceSelect) {
        const res = await originalWorkspaceSelect(event, payload);
        if (res) return res;
      }
    } catch {
      // Dialog không khả dụng ngoài Electron -> thử gọi native OS folder dialog
    }

    // Nếu payload chỉ định path cụ thể (từ UI prompt hoặc API)
    if (payload && typeof payload === 'object' && 'path' in payload && typeof (payload as { path: string }).path === 'string') {
      const targetPath = (payload as { path: string }).path;
      if (fs.existsSync(targetPath)) {
        await handlers.get('vyen:workspace-set')?.(event, { path: targetPath });
        return { path: path.resolve(targetPath) };
      }
    }

    // Thử mở popup chọn folder native của OS (PowerShell / osascript / zenity)
    const nativeSelected = promptNativeFolderPicker();
    if (nativeSelected && fs.existsSync(nativeSelected)) {
      await handlers.get('vyen:workspace-set')?.(event, { path: nativeSelected });
      return { path: path.resolve(nativeSelected) };
    }

    // Nếu người dùng bấm cancel dialog hoặc không có GUI
    return { cancelled: true };
  });

  // 4. Doctor diagnostic endpoint (Claude Code / MonkeyCode style)
  handlers.set('vyen:doctor', async () => {
    const memory = process.memoryUsage();
    const currentWs = (await handlers.get('vyen:workspace-get')?.(null)) as { path: string | null } | undefined;
    const wsRoot = currentWs?.path || defaultWorkspace;
    const isGit = fs.existsSync(path.join(wsRoot, '.git'));
    const packageJsonExists = fs.existsSync(path.join(wsRoot, 'package.json'));

    return {
      ok: true,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      workspaceRoot: wsRoot,
      isGit,
      packageJsonExists,
      memory: {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      },
      registeredChannels: Array.from(handlers.keys()),
    };
  });

  // 5. Teamwork Triad Artifacts endpoint (MonkeyCode task inspection)
  handlers.set('vyen:teamwork-artifacts', async () => {
    const currentWs = (await handlers.get('vyen:workspace-get')?.(null)) as { path: string | null } | undefined;
    const wsRoot = currentWs?.path || defaultWorkspace;
    const teamworkDir = path.join(wsRoot, 'teamwork');

    const readIfExists = (filename: string): { exists: boolean; content?: string; mtime?: string } => {
      const p = path.join(teamworkDir, filename);
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        const content = fs.readFileSync(p, 'utf8');
        return { exists: true, content, mtime: stat.mtime.toISOString() };
      }
      return { exists: false };
    };

    return {
      ok: true,
      workspaceRoot: wsRoot,
      hasTeamwork: fs.existsSync(teamworkDir),
      request: readIfExists('REQUEST.md'),
      plan: readIfExists('PLAN.md'),
      progress: readIfExists('PROGRESS.md'),
    };
  });

  // 6. Security Audit endpoint (MonkeyCode security scanning)
  handlers.set('vyen:security-audit', async (_event, payload?: unknown) => {
    const currentWs = (await handlers.get('vyen:workspace-get')?.(null)) as { path: string | null } | undefined;
    const wsRoot = currentWs?.path || defaultWorkspace;
    const { runMonkeyCodeSast } = await import('../security-sast');
    const targetPath = payload && typeof payload === 'object' && 'targetPath' in payload && typeof (payload as { targetPath?: unknown }).targetPath === 'string'
      ? (payload as { targetPath: string }).targetPath
      : undefined;
    const report = runMonkeyCodeSast(wsRoot, { targetPath });
    return {
      ok: report.ok,
      score: report.score,
      grade: report.grade,
      summary: report.summary,
      findings: report.findings,
      report: report.textReport,
      workspaceRoot: wsRoot,
    };
  });

  dispatcherInstance = {
    handlers,
    initialized: true,
    workspaceRoot: defaultWorkspace,
  };

  return dispatcherInstance;
}

/**
 * Hiển thị hộp thoại chọn thư mục gốc của hệ điều hành mà không cần Electron.
 */
export function promptNativeFolderPicker(): string | null {
  if (process.platform === 'win32') {
    const script = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Chọn thư mục làm việc (Workspace) cho Vyen'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }`;
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    try {
      const { spawnSync } = require('node:child_process');
      const res = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', b64], {
        encoding: 'utf8',
        windowsHide: false,
        timeout: 60_000,
      });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout
          .split(/\r?\n/)
          .map((l: string) => l.trim())
          .filter((l: string) => l && !l.startsWith('#<') && !l.startsWith('<') && fs.existsSync(l));
        if (lines.length > 0) return lines[lines.length - 1];
      }
    } catch {}
  } else if (process.platform === 'darwin') {
    try {
      const { spawnSync } = require('node:child_process');
      const res = spawnSync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Chọn thư mục làm việc cho Vyen")'], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (res.status === 0 && res.stdout.trim() && fs.existsSync(res.stdout.trim())) {
        return res.stdout.trim();
      }
    } catch {}
  } else {
    // Linux: zenity hoặc kdialog
    try {
      const { spawnSync } = require('node:child_process');
      const res = spawnSync('zenity', ['--file-selection', '--directory', '--title=Chọn thư mục làm việc cho Vyen'], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (res.status === 0 && res.stdout.trim() && fs.existsSync(res.stdout.trim())) {
        return res.stdout.trim();
      }
    } catch {
      try {
        const { spawnSync } = require('node:child_process');
        const res = spawnSync('kdialog', ['--getexistingdirectory', process.cwd()], {
          encoding: 'utf8',
          timeout: 60_000,
        });
        if (res.status === 0 && res.stdout.trim() && fs.existsSync(res.stdout.trim())) {
          return res.stdout.trim();
        }
      } catch {}
    }
  }
  return null;
}

/**
 * Điều phối gọi channel IPC từ Web API.
 */
export async function invokeBridgeChannel(channel: string, payload?: unknown): Promise<unknown> {
  const dispatcher = initServerBridge();
  const handler = dispatcher.handlers.get(channel);

  if (!handler) {
    throw new Error(`Kênh bridge không được hỗ trợ hoặc chưa đăng ký: "${channel}"`);
  }

  return await handler(null, payload);
}

/**
 * Kiểm tra hostname có thuộc danh sách an toàn cục bộ (localhost/127.0.0.1/::1) hay không.
 * Ngăn chặn tuyệt đối tấn công CSRF, DNS Rebinding và các domain giả mạo kiểu "evil-localhost.com".
 */
export function isSafeLocalHostOrIp(hostOrUrl: string): boolean {
  if (!hostOrUrl) return false;
  const val = hostOrUrl.trim();
  let hostname = '';
  try {
    if (val.startsWith('http://') || val.startsWith('https://')) {
      hostname = new URL(val).hostname;
    } else {
      hostname = new URL(`http://${val}`).hostname;
    }
  } catch {
    hostname = val.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  }
  hostname = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0';
}

/**
 * Kiểm tra xem request có xuất phát từ localhost / nội bộ an toàn hay không.
 */
export function isLocalRequest(req: Request): boolean {
  // 1. Chặn cross-site browser requests (Fetch Metadata standard)
  const secFetchSite = req.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite === 'cross-site') {
    return false;
  }

  const host = req.headers.get('host');
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');

  // Host header phải trỏ về local
  if (host && !isSafeLocalHostOrIp(host)) {
    return false;
  }

  // Origin nếu có phải là local
  if (origin && !isSafeLocalHostOrIp(origin)) {
    return false;
  }

  // Referer nếu có phải là local
  if (referer && !isSafeLocalHostOrIp(referer)) {
    return false;
  }

  return true;
}
