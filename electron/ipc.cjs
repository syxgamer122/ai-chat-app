'use strict';

/*
 * Vyen desktop IPC bridge — fs / shell / git / workspace.
 *
 * Trust model (quyết định thiết kế, có chủ ý):
 * - Renderer là code của app (contextIsolation + sandbox), nhưng nếu renderer
 *   bị chiếm thì key API trong Dexie cũng đã lộ — nên main KHÔNG đóng vai
 *   người giữ chìa khóa bất khả xâm phạm. Vai trò của main là:
 *   1. Khóa mọi op file vào workspace root (path-guard, chống path traversal)
 *   2. Chặn shell injection cấu trúc: command chạy qua cmd /c nhưng args
 *      là MỘT chuỗi đã qua schema (max 4000), cwd luôn nằm trong root,
 *      timeout + tree-kill + output cap — không bao giờ treo máy user.
 *   3. Audit log mọi shell/git call ra vyen-shell.log.
 * - Approval UI (user bấm đồng ý lệnh) thuộc tầng renderer/tool — giai đoạn 3.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { z } = require('zod');
const { resolveWithin } = require('./path-guard.cjs');

// dialog cần app ready — require lazy trong handler để tránh
// load sớm khi test import module ngoài Electron.
function getDialog() {
  try {
    return require('electron').dialog;
  } catch {
    return null;
  }
}
function getFocusedWindow() {
  try {
    return require('electron').BrowserWindow.getFocusedWindow();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Giới hạn — mirror các trần của lib/fs-access.ts nơi có tương đương  */
/* ------------------------------------------------------------------ */

const LIMITS = Object.freeze({
  FS_READ_MAX_BYTES: 2_000_000,
  FS_WRITE_MAX_BYTES: 5_000_000,
  FS_IMAGE_MAX_BYTES: 4_500_000,
  LIST_MAX_ENTRIES: 5_000,
  SEARCH_MAX_FILES: 600,
  SEARCH_FILE_MAX_BYTES: 512_000,
  SEARCH_TIME_BUDGET_MS: 4_000,
  SHELL_TIMEOUT_DEFAULT_MS: 120_000,
  SHELL_TIMEOUT_MAX_MS: 600_000,
  SHELL_OUTPUT_MAX_CHARS: 400_000,
  /* Goose-style smart truncation: giữ output trong ngân sách token của LLM.
     Khi vượt → lưu full vào temp file, trả preview (đuôi) + đường dẫn đọc tiếp. */
  SHELL_OUTPUT_LIMIT_LINES: 2_000,
  SHELL_OUTPUT_LIMIT_BYTES: 50_000,
  SHELL_OUTPUT_PREVIEW_LINES: 50,
  SHELL_OUTPUT_PREVIEW_BYTES: 10_000,
  GIT_TIMEOUT_MS: 60_000,
  COMMIT_MESSAGE_MAX_CHARS: 4_000,
});

/** Đồng bộ BINARY_EXT_RE của lib/fs-access.ts — thêm ext mới phải sửa cả hai. */
const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|otf|mp4|webm|mov|mp3|wav|zip|gz|tar|rar|7z|pdf|docx?|xlsx?|pptx?|exe|dll|so|dylib|wasm|node|lock-bin)$/i;

/** Đồng bộ IGNORE_DIRS của lib/fs-access.ts. */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'out',
  'coverage',
  '.vercel',
]);

/* ------------------------------------------------------------------ */
/* Workspace root — trạng thái main, persist vào userData              */
/* ------------------------------------------------------------------ */

let workspaceRoot = null;
let workspaceFile = null;
let auditLog = () => {};

function loadWorkspace(userDataDir) {
  workspaceFile = path.join(userDataDir, 'vyen-workspace.json');
  // Migration từ thời KODA: lần đầu sau rebrand file mới chưa có — chép từ
  // file cũ sang; các lần persist sau sẽ ghi ra tên mới.
  if (!fs.existsSync(workspaceFile)) {
    const legacy = path.join(userDataDir, 'koda-workspace.json');
    if (fs.existsSync(legacy)) {
      try {
        fs.copyFileSync(legacy, workspaceFile);
      } catch {}
    }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
    if (typeof raw.root === 'string' && fs.existsSync(raw.root)) {
      workspaceRoot = raw.root;
    }
  } catch {
    // File chưa có/hỏng — root mặc định null, user chọn qua dialog.
  }
}

function persistWorkspace(root) {
  try {
    fs.writeFileSync(workspaceFile, JSON.stringify({ root }, null, 2));
  } catch (e) {
    auditLog('persist workspace thất bại:', String(e));
  }
}

function requireRoot() {
  if (!workspaceRoot) {
    throw new Error('Chưa chọn workspace trong Vyen desktop (Settings → Workspace).');
  }
  return workspaceRoot;
}

function targetOf(payload) {
  const root = requireRoot();
  return resolveWithin(root, payload.relPath ?? '');
}

/* ------------------------------------------------------------------ */
/* Schemas (zod dùng lại từ dependencies của app)                      */
/* ------------------------------------------------------------------ */

const RelPath = z.string().max(1024);

const FsListPayload = z.object({ relPath: RelPath.default('') });
const FsReadPayload = z.object({ relPath: z.string().min(1).max(1024) });
const FsWritePayload = z.object({
  relPath: z.string().min(1).max(1024),
  content: z.string().max(LIMITS.FS_WRITE_MAX_BYTES),
});
const FsDeletePayload = z.object({ relPath: z.string().min(1).max(1024) });
const FsStatPayload = z.object({ relPath: z.string().max(1024) });
const FsSearchPayload = z.object({
  query: z.string().min(1).max(400),
  isRegex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(200).optional(),
});
const ShellPayload = z.object({
  command: z.string().min(1).max(4000),
  cwd: RelPath.optional(),
  timeoutMs: z.number().int().min(1_000).max(LIMITS.SHELL_TIMEOUT_MAX_MS).optional(),
});
const GitStatusPayload = z.object({});
const GitDiffPayload = z.object({ relPath: RelPath.optional(), staged: z.boolean().optional() });
const GitLogPayload = z.object({ limit: z.number().int().min(1).max(200).optional() });
const GitAddPayload = z.object({ relPaths: z.array(z.string().min(1).max(1024)).min(1).max(50) });
const GitCommitPayload = z.object({ message: z.string().min(1).max(LIMITS.COMMIT_MESSAGE_MAX_CHARS) });

/* ------------------------------------------------------------------ */
/* fs                                                                  */
/* ------------------------------------------------------------------ */

async function fsList(payload) {
  const dir = targetOf(payload);
  const names = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const ent of names) {
    if (out.length >= LIMITS.LIST_MAX_ENTRIES) break;
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = await fsp.stat(path.join(dir, ent.name));
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      // File biến mất giữa readdir và stat — trả metadata rỗng thay vì sập.
    }
    out.push({ name: ent.name, kind: ent.isDirectory() ? 'directory' : 'file', size, mtimeMs });
  }
  return out;
}

async function fsRead(payload) {
  const file = targetOf(payload);
  if (BINARY_EXT_RE.test(file)) {
    throw new Error(`File binary không đọc qua công cụ text: ${path.basename(file)}`);
  }
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('Không phải file.');
  if (st.size > LIMITS.FS_READ_MAX_BYTES) {
    throw new Error(`File quá lớn để đọc (${st.size} bytes > trần ${LIMITS.FS_READ_MAX_BYTES}).`);
  }
  const content = await fsp.readFile(file, 'utf8');
  return { content, size: st.size };
}

async function fsWrite(payload) {
  const file = targetOf(payload);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, payload.content, 'utf8');
  const st = await fsp.stat(file);
  return { size: st.size };
}

/** Đồng bộ IMAGE_VISION_EXT_RE + IMAGE_MIME_BY_EXT của lib/fs-access.ts. */
const IMAGE_VISION_EXT_RE = /\.(png|jpe?g|webp|heic|heif)$/i;
const IMAGE_MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

/**
 * Đọc file ảnh trong workspace trả base64 — phục vụ luồng vision
 * (client gửi data URL lên /api/vision thay vì đưa bytes cho model).
 */
async function fsReadImage(payload) {
  const file = targetOf(payload);
  const extMatch = /\.([a-z0-9]+)$/i.exec(file);
  const mime = extMatch ? IMAGE_MIME_BY_EXT[extMatch[1].toLowerCase()] : null;
  if (!mime) throw new Error('Không phải định dạng ảnh đọc được qua vision.');
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('Không phải file.');
  if (st.size > LIMITS.FS_IMAGE_MAX_BYTES) {
    throw new Error(`Ảnh quá lớn (${st.size} bytes > trần ${LIMITS.FS_IMAGE_MAX_BYTES}).`);
  }
  const buf = await fsp.readFile(file);
  return { mimeType: mime, base64: buf.toString('base64'), size: st.size };
}

async function fsStat(payload) {
  const file = targetOf(payload);
  try {
    const st = await fsp.stat(file);
    return {
      exists: true,
      kind: st.isDirectory() ? 'directory' : 'file',
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return { exists: false };
  }
}

async function fsDelete(payload) {
  const file = targetOf(payload);
  if (file === path.resolve(requireRoot())) {
    throw new Error('Không được xoá chính workspace root.');
  }
  await fsp.rm(file, { recursive: true, force: false });
}

async function fsSearch(payload) {
  const root = requireRoot();
  const startDir = targetOf(payload);
  const { query, isRegex = false, caseSensitive = false, maxResults = 30 } = payload;
  let matcher;
  if (isRegex) {
    let re;
    try {
      re = new RegExp(query, caseSensitive ? '' : 'i');
    } catch (e) {
      throw new Error(`Regex không hợp lệ: ${String(e?.message ?? e)}`);
    }
    matcher = (line) => re.test(line);
  } else {
    const needle = caseSensitive ? query : query.toLowerCase();
    matcher = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  const deadline = Date.now() + LIMITS.SEARCH_TIME_BUDGET_MS;
  const results = [];
  let scanned = 0;

  const walk = async (dir, prefix) => {
    if (results.length >= maxResults || scanned >= LIMITS.SEARCH_MAX_FILES || Date.now() > deadline) return;
    let names;
    try {
      names = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of names) {
      if (results.length >= maxResults || scanned >= LIMITS.SEARCH_MAX_FILES || Date.now() > deadline) return;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(ent.name) && !ent.name.startsWith('.')) {
          await walk(path.join(dir, ent.name), rel);
        }
        continue;
      }
      if (!ent.isFile() || BINARY_EXT_RE.test(ent.name)) continue;
      scanned += 1;
      try {
        const fullPath = path.join(dir, ent.name);
        const st = await fsp.stat(fullPath);
        if (st.size > LIMITS.SEARCH_FILE_MAX_BYTES) continue;
        const text = await fsp.readFile(fullPath, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matcher(lines[i])) {
            results.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (results.length >= maxResults) return;
          }
        }
      } catch {
        // File không đọc được — bỏ qua, không làm sập search.
      }
    }
  };

  await walk(startDir, payload.relPath ? payload.relPath.replace(/\\/g, '/') : '');
  return results;
}

/* ------------------------------------------------------------------ */
/* shell — buffered run, timeout, tree-kill                            */
/* ------------------------------------------------------------------ */

const runningChildren = new Set();

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3_000).unref?.();
  }
}

function killAllRunning() {
  for (const child of runningChildren) killTree(child);
  runningChildren.clear();
}

/* ------------------------------------------------------------------ */
/* Smart output truncation (Goose-style)                                */
/* Khi stdout/stderr vượt ngưỡng → lưu full vào temp file, trả preview  */
/* (đuôi = phần cuối chứa lỗi/thông báo quan trọng) + hint đọc tiếp.    */
/* ------------------------------------------------------------------ */

const os = require('node:os');
const crypto = require('node:crypto');

/**
 * @param {string} fullOutput
 * @param {'stdout'|'stderr'|'output'} label
 * @returns {{ text: string; truncated: boolean; savedTo?: string; previewHint?: string }}
 */
function truncateShellOutput(fullOutput, label) {
  if (!fullOutput) return { text: '', truncated: false };

  const lines = fullOutput.split('\n');
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(fullOutput, 'utf8');

  const exceededLines = totalLines > LIMITS.SHELL_OUTPUT_LIMIT_LINES;
  const exceededBytes = totalBytes > LIMITS.SHELL_OUTPUT_LIMIT_BYTES;

  if (!exceededLines && !exceededBytes) {
    return { text: fullOutput, truncated: false };
  }

  // Lưu full output vào temp file
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(4).toString('hex');
  const fileName = `vyen-shell-${label}-${id}.txt`;
  const savePath = path.join(tmpDir, fileName);
  try {
    fs.writeFileSync(savePath, fullOutput, 'utf8');
  } catch {
    // Nếu không ghi được → fallback về cap cũ
    return {
      text: fullOutput.slice(0, LIMITS.SHELL_OUTPUT_MAX_CHARS),
      truncated: true,
    };
  }

  // Preview = đuôi (last N lines) vì lỗi thường nằm ở cuối
  const previewStart = Math.max(0, totalLines - LIMITS.SHELL_OUTPUT_PREVIEW_LINES);
  let preview = lines.slice(previewStart).join('\n');

  // Cap preview bytes để tránh line dài bất thường (progress bar, base64...)
  if (Buffer.byteLength(preview, 'utf8') > LIMITS.SHELL_OUTPUT_PREVIEW_BYTES) {
    let cutAt = preview.length - LIMITS.SHELL_OUTPUT_PREVIEW_BYTES;
    // Snip to char boundary (avoid cutting surrogate pairs)
    while (cutAt < preview.length && !Number.isFinite(parseInt(preview[cutAt], 10)) === false) {
      cutAt += 1;
    }
    preview = preview.slice(Math.max(0, cutAt));
  }

  const reason = exceededLines
    ? `Output exceeded ${LIMITS.SHELL_OUTPUT_LIMIT_LINES} line limit (${totalLines} lines total).`
    : `Output exceeded ${LIMITS.SHELL_OUTPUT_LIMIT_BYTES} byte limit (${totalBytes} bytes total).`;

  const isWin = process.platform === 'win32';
  const readCmd = isWin
    ? `Get-Content "${savePath}" -TotalCount 200 or Select-String`
    : `head -200 "${savePath}" or tail -200 "${savePath}"`;

  return {
    text: preview,
    truncated: true,
    savedTo: savePath,
    previewHint: `[${reason} Full output saved to ${savePath}. Read with ${readCmd}, up to ${LIMITS.SHELL_OUTPUT_LIMIT_LINES} lines at a time.]`,
  };
}

function shellRun(payload) {
  const root = requireRoot();
  const cwd = resolveWithin(root, payload.cwd ?? '');
  const timeoutMs = payload.timeoutMs ?? LIMITS.SHELL_TIMEOUT_DEFAULT_MS;
  const isWin = process.platform === 'win32';
  const file = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  const args = isWin ? ['/d', '/s', '/c', payload.command] : ['-c', payload.command];

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(file, args, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: isWin,
      env: { ...process.env },
    });
    runningChildren.add(child);
    auditLog(`shell: ${payload.command.slice(0, 200)} (cwd=${path.relative(root, cwd) || '.'}, timeout=${timeoutMs}ms)`);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    /* Cap thô khi thu thập để tránh OOM; truncate thông minh ở resolve. */
    const cap = (s, add) => (s.length >= LIMITS.SHELL_OUTPUT_MAX_CHARS ? s : (s + add).slice(0, LIMITS.SHELL_OUTPUT_MAX_CHARS));

    child.stdout.on('data', (d) => {
      stdout = cap(stdout, d.toString());
    });
    child.stderr.on('data', (d) => {
      stderr = cap(stderr, d.toString());
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runningChildren.delete(child);
      const errStderr = `${stderr}\n${String(err)}`.trim();
      const outTrunc = truncateShellOutput(stdout, 'stdout');
      const errTrunc = truncateShellOutput(errStderr, 'stderr');
      resolve({
        code: null, signal: null,
        stdout: outTrunc.text, stderr: errTrunc.text,
        durationMs: Date.now() - started, timedOut,
        truncated: outTrunc.truncated || errTrunc.truncated,
        savedTo: outTrunc.savedTo || errTrunc.savedTo,
        previewHint: [outTrunc.previewHint, errTrunc.previewHint].filter(Boolean).join('\n') || undefined,
      });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runningChildren.delete(child);
      const outTrunc = truncateShellOutput(stdout, 'stdout');
      const errTrunc = truncateShellOutput(stderr, 'stderr');
      resolve({
        code, signal,
        stdout: outTrunc.text, stderr: errTrunc.text,
        durationMs: Date.now() - started, timedOut,
        truncated: outTrunc.truncated || errTrunc.truncated,
        savedTo: outTrunc.savedTo || errTrunc.savedTo,
        previewHint: [outTrunc.previewHint, errTrunc.previewHint].filter(Boolean).join('\n') || undefined,
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* git — subcommand cố định, args template, không passthrough tự do    */
/* ------------------------------------------------------------------ */

function gitRun(root, args, timeoutMs = LIMITS.GIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', '-C', root, ...args], {
      windowsHide: true,
    });
    runningChildren.add(child);
    auditLog(`git ${args.slice(0, 4).join(' ')}`);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      killTree(child);
    }, timeoutMs);
    const cap = (s, add) => (s.length >= LIMITS.SHELL_OUTPUT_MAX_CHARS ? s : (s + add).slice(0, LIMITS.SHELL_OUTPUT_MAX_CHARS));
    child.stdout.on('data', (d) => {
      stdout = cap(stdout, d.toString());
    });
    child.stderr.on('data', (d) => {
      stderr = cap(stderr, d.toString());
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runningChildren.delete(child);
      reject(new Error(`git không chạy được: ${String(err)}`));
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runningChildren.delete(child);
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args[0]} thất bại (code=${code}${signal ? `, signal=${signal}` : ''}): ${stderr.trim().slice(0, 500)}`));
    });
  });
}

function parsePorcelain(out) {
  const lines = out.split('\n').filter((l) => l.length > 0);
  let branch = null;
  const entries = [];
  let start = 0;
  if (lines[0] && lines[0].startsWith('##')) {
    branch = lines[0].slice(2).trim().split('...')[0].replace(/^\s+/, '') || null;
    start = 1;
  }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let body = line.slice(3);
    let origPath;
    const rename = /^"?(.+?)"? -> "?(.+)"?$/.exec(body);
    if (rename) {
      origPath = rename[1];
      body = rename[2];
    }
    entries.push({ x, y, path: body.replace(/^"|"$/g, ''), ...(origPath ? { origPath } : {}) });
  }
  return { branch, entries };
}

/* ------------------------------------------------------------------ */
/* register                                                            */
/* ------------------------------------------------------------------ */

function handler(fn) {
  return async (_event, payload) => {
    try {
      return await fn(payload ?? {});
    } catch (e) {
      const msg = String(e?.message ?? e);
      auditLog(`IPC lỗi: ${msg.slice(0, 200)}`);
      throw new Error(msg);
    }
  };
}

/**
 * Đăng ký mọi channel. Gọi một lần từ main.cjs khi app ready.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ userDataDir: string, audit: (line: string) => void, workspaceOverride?: string | null }} opts
 */
function register(ipcMain, opts) {
  auditLog = opts.audit;
  loadWorkspace(opts.userDataDir);
  // VYEN_WORKSPACE_ROOT: override cho e2e/smoke — không persist (chỉ runtime).
  if (opts.workspaceOverride && fs.existsSync(opts.workspaceOverride)) {
    workspaceRoot = path.resolve(opts.workspaceOverride);
  }

  const on = (channel, fn) => ipcMain.handle(channel, handler(fn));

  on('vyen:workspace-get', () => ({ path: workspaceRoot }));
  on('vyen:workspace-select', async () => {
    const dialog = getDialog();
    if (!dialog) throw new Error('Dialog không khả dụng.');
    const win = getFocusedWindow();
    const result = await dialog.showOpenDialog(win ?? undefined, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { cancelled: true };
    const resolved = path.resolve(result.filePaths[0]);
    workspaceRoot = resolved;
    persistWorkspace(resolved);
    auditLog(`workspace = ${resolved}`);
    return { path: workspaceRoot };
  });
  on('vyen:workspace-set', (payload) => {
    const schema = z.object({ path: z.string().min(1).max(500) });
    const p = schema.parse(payload);
    const resolved = path.resolve(p.path);
    if (!fs.existsSync(resolved)) throw new Error('Thư mục không tồn tại.');
    workspaceRoot = resolved;
    persistWorkspace(resolved);
    auditLog(`workspace = ${resolved}`);
    return { path: workspaceRoot };
  });
  // Ngắt kết nối: xoá root runtime + persist null (loadWorkspace bỏ qua root
  // không phải string, nên phiên sau không âm thầm nối lại).
  on('vyen:workspace-clear', () => {
    workspaceRoot = null;
    persistWorkspace(null);
    auditLog('workspace = (đã ngắt kết nối)');
    return { ok: true };
  });
  on('vyen:fs-list', (p) => fsList(FsListPayload.parse(p)));
  on('vyen:fs-read', (p) => fsRead(FsReadPayload.parse(p)));
  on('vyen:fs-read-image', (p) => fsReadImage(FsReadPayload.parse(p)));
  on('vyen:fs-write', (p) => fsWrite(FsWritePayload.parse(p)));
  on('vyen:fs-delete', (p) => fsDelete(FsDeletePayload.parse(p)));
  on('vyen:fs-stat', (p) => fsStat(FsStatPayload.parse(p)));
  on('vyen:fs-search', (p) => fsSearch(FsSearchPayload.parse(p)));
  on('vyen:shell-run', (p) => shellRun(ShellPayload.parse(p)));
  on('vyen:git-status', (p) => {
    GitStatusPayload.parse(p ?? {});
    return gitRun(requireRoot(), ['status', '--porcelain=v1', '-b']).then(parsePorcelain);
  });
  on('vyen:git-diff', (p) => {
    const d = GitDiffPayload.parse(p ?? {});
    const args = ['diff'];
    if (d.staged) args.push('--cached');
    args.push('--');
    if (d.relPath) args.push(d.relPath);
    return gitRun(requireRoot(), args);
  });
  on('vyen:git-log', (p) => {
    const d = GitLogPayload.parse(p ?? {});
    return gitRun(requireRoot(), ['log', '--oneline', `-${d.limit ?? 30}`]);
  });
  on('vyen:git-add', (p) => {
    const d = GitAddPayload.parse(p);
    const root = requireRoot();
    // Path từ renderer phải nằm trong root trước khi đưa cho git.
    for (const rel of d.relPaths) resolveWithin(root, rel);
    return gitRun(root, ['add', '--', ...d.relPaths]).then(() => ({ ok: true }));
  });
  on('vyen:git-commit', (p) => {
    const d = GitCommitPayload.parse(p);
    return gitRun(requireRoot(), ['commit', '-m', d.message]).then((out) => ({ ok: true, output: out.trim().slice(0, 2000) }));
  });
}

module.exports = {
  register,
  killAllRunning,
  LIMITS,
  BINARY_EXT_RE,
  IGNORE_DIRS,
  truncateShellOutput,
};
