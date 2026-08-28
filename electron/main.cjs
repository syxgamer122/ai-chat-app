/*
 * Koda desktop shell — Electron main process.
 *
 * Trách nhiệm: khởi động (hoặc gắn vào) Next.js server cục bộ, mở cửa sổ
 * load app từ đó, và canh chừng server sống chết. Chưa có IPC tool nào ở
 * giai đoạn này — preload chỉ expose "fingerprint" để app feature-detect.
 *
 * Security posture: chỉ load http://127.0.0.1:<port> (không bao giờ remote),
 * contextIsolation + sandbox bật, nodeIntegration tắt, mọi permission request
 * bị từ chối, link ngoài mở bằng trình duyệt hệ thống.
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const ipcBridge = require('./ipc.cjs');

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev') || process.env.KODA_ELECTRON_DEV === '1';
const PORT = Number(process.env.KODA_PORT || 3457);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
/** next dev (Turbopack, FS chậm) đã đo lạnh ~82s — trần phải rộng hơn thế. */
const SERVER_TIMEOUT_MS = IS_DEV ? 180_000 : 60_000;
const PROBE_TIMEOUT_MS = 3_000;

let mainWindow = null;
let serverChild = null;
let serverLogTail = [];
let serverDied = false;

/* ------------------------------------------------------------------ */
/* File logger — bản double-click không có console để đọc log          */
/* ------------------------------------------------------------------ */

function klog(...parts) {
  const line = `[koda] ${parts.join(' ')}`;
  console.log(line);
  klogLine(line);
}

function klogLine(line) {
  try {
    const file = path.join(app.getPath('userData'), 'koda-shell.log');
    // Tránh phình vô hạn: log cũ quá lớn thì cắt lại từ đầu.
    try {
      const st = fs.statSync(file);
      if (st.size > 512 * 1024) fs.writeFileSync(file, '');
    } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Next.js server                                                      */
/* ------------------------------------------------------------------ */

function pushServerLog(chunk) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    console.log(`[next] ${line}`);
    klogLine(`[next] ${line}`);
    serverLogTail.push(line);
    if (serverLogTail.length > 80) serverLogTail.shift();
  }
}

/**
 * Probe đúng endpoint đặc trưng của Koda (/api/server-config) — không dính
 * nhầm app khác đang tình cờ chiếm port.
 */
function probeServer(base, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(ok);
    };
    const req = http.get(`${base}/api/server-config`, { timeout: timeoutMs }, (res) => {
      res.resume();
      done(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => done(false));
    req.on('error', () => done(false));
  });
}

function nextBinPath() {
  const direct = path.join(APP_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (fs.existsSync(direct)) return direct;
  return require.resolve('next/dist/bin/next', { paths: [APP_ROOT] });
}

function killServerTree() {
  if (!serverChild || serverChild.exitCode !== null) return;
  const pid = serverChild.pid;
  if (process.platform === 'win32') {
    // next tự spawn worker — kill cả cây, không chỉ PID gốc.
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    serverChild.kill('SIGTERM');
  }
}

function spawnNextServer() {
  const bin = nextBinPath();
  if (!IS_DEV) {
    const buildId = path.join(APP_ROOT, '.next', 'BUILD_ID');
    if (!fs.existsSync(buildId)) {
      showError(
        'Chưa có bản build production',
        'Koda desktop chạy `next start` nên cần build trước:\n\n    npm run build\n\n' +
          'Hoặc chạy bản dev: npm run app:dev',
      );
      return null;
    }
  }
  const args = [bin, IS_DEV ? 'dev' : 'start', '-p', String(PORT)];
  const child = spawn(process.execPath, args, {
    cwd: APP_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    /* process.execPath trong Electron main là electron.exe — chạy nó như
       node thuần bằng ELECTRON_RUN_AS_NODE, nếu không `next` sẽ được tải
       lên như một app GUI khác và server không bao giờ nghe port. */
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  serverChild = child;
  child.stdout.on('data', pushServerLog);
  child.stderr.on('data', pushServerLog);
  child.on('error', (err) => {
    serverDied = true;
    klog('spawn server lỗi:', String(err));
    showError('Không chạy được Next.js server', String(err));
  });
  child.on('exit', (code) => {
    console.warn(`[next] server process exited (code=${code})`);
    klog('server exited code=', code);
    if (!app.isQuitting && !serverDied) {
      serverDied = true;
      showError('Next.js server đã dừng', `Server đóng bất ngờ (code=${code}). 80 dòng cuối:\n\n${serverLogTail.join('\n')}`);
    }
  });
  klog(`spawn ${IS_DEV ? 'next dev' : 'next start'} (pid=${child.pid}) port=${PORT}`);
  return child;
}

async function ensureServer() {
  // KODA_URL: ép gắn vào server đang chạy elsewhere (debug/online) — không spawn.
  const forced = process.env.KODA_URL;
  if (forced) {
    const ok = await probeServer(forced);
    if (ok) return forced;
    throw new Error(`KODA_URL=${forced} không phản hồi /api/server-config`);
  }
  if (await probeServer(BASE)) {
    klog(`đã có Koda server tại ${BASE} — gắn vào thay vì spawn.`);
    return BASE;
  }
  spawnNextServer();
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverDied) throw new Error('Server process thoát ngay khi khởi động.');
    if (await probeServer(BASE)) return BASE;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server không sẵn sàng trong ${Math.round(SERVER_TIMEOUT_MS / 1000)}s.\n\nLog cuối:\n${serverLogTail.join('\n')}`);
}

/* ------------------------------------------------------------------ */
/* Cửa sổ                                                              */
/* ------------------------------------------------------------------ */

const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Koda</title>
<style>
  body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
    background:#0b0f14;color:#9fb3c8;font-family:system-ui,sans-serif;gap:18px}
  .spin{width:34px;height:34px;border:3px solid #1f2a37;border-top-color:#4ea1ff;border-radius:50%;
    animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  code{color:#4ea1ff;font-size:13px}
</style></head><body>
<div class="spin"></div>
<div>Đang khởi động Koda…</div>
<code>${IS_DEV ? 'next dev' : 'next start'} — ${BASE}</code>
</body></html>`;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: 'Koda',
    backgroundColor: '#0b0f14',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`);
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Link ngoài → trình duyệt hệ thống; điều hướng trong app chỉ trong BASE.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (ev, url) => {
    if (url.startsWith(BASE)) return;
    ev.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  // Không cấp camera/mic/geolocation/notification — app chưa cần cái nào.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    console.warn(`[koda] permission denied: ${permission}`);
    cb(false);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Load app có retry — compile lạnh `/` trên FS chậm có thể khiến server
 * nhả kết nối giữa chừng (đo thật: ERR_FAILED sau ~38s chờ, compile thành
 * công ở lượt GET sau). Retry đều được vì probe đã xác nhận server sống.
 */
async function loadApp(base) {
  const maxAttempts = 8;
  for (let i = 1; i <= maxAttempts; i++) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      await mainWindow.loadURL(base);
      klog(`app load OK (lần ${i})`);
      return;
    } catch (e) {
      klog(`loadURL thất bại (lần ${i}/${maxAttempts}): ${e?.message ?? e}`);
      if (i === maxAttempts) throw e;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
}

function showError(title, detail) {  console.error(`[koda] ${title}: ${detail}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    // Có thể đua với vòng retry loadApp khi server chết giữa chừng — nuốt
    // rejection để không thành unhandled rejection lúc đang dọn dẹp.
    mainWindow
      .loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f14;color:#e5484d;font-family:system-ui,sans-serif;white-space:pre-wrap;padding:40px;box-sizing:border-box"><div><h2 style="margin:0 0 12px">${title}</h2><div style="color:#9fb3c8;font-size:13px">${detail}</div></body>`,
          ),
      )
      .catch(() => {});
  } else {
    dialog.showErrorBox(title, detail.slice(0, 2000));
  }
}

/* ------------------------------------------------------------------ */
/* Vòng đời app                                                        */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('app.koda.desktop');
    if (!IS_DEV) Menu.setApplicationMenu(null); // dev giữ menu cho DevTools
    ipcBridge.register(ipcMain, {
      userDataDir: app.getPath('userData'),
      audit: klog,
      workspaceOverride: process.env.KODA_WORKSPACE_ROOT || null,
    });
    klog('boot: dev=', IS_DEV, 'port=', PORT);
    createWindow();
    try {
      const base = await ensureServer();
      if (mainWindow && !mainWindow.isDestroyed()) await loadApp(base);
      klog('sẵn sàng:', base);
      if (process.env.KODA_IPC_SMOKE === '1') await runIpcSmoke();
    } catch (e) {
      klog('boot thất bại:', String(e?.message ?? e));
      showError('Không khởi động được Koda', String(e?.message ?? e));
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    app.isQuitting = true;
    ipcBridge.killAllRunning();
    killServerTree();
  });
}

/* ------------------------------------------------------------------ */
/* Self-test IPC (chỉ khi KODA_IPC_SMOKE=1) — chạy trong renderer qua  */
/* preload bridge, ghi kết quả vào log rồi tự thoát. Không bao giờ bật */
/* trong môi trường thường.                                            */
/* ------------------------------------------------------------------ */

async function runIpcSmoke() {
  klog('[smoke] bắt đầu self-test IPC bridge…');
  const script = `(async () => {
    const out = {};
    const k = window.koda;
    out.fingerprint = { desktop: k.desktop, platform: k.platform };
    out.workspaceGet = await k.workspace.get();
    out.fsList = (await k.fs.list('.')).length;
    await k.fs.write('koda-smoke.txt', 'smoke ' + Date.now());
    out.fsRead = (await k.fs.read('koda-smoke.txt')).content.slice(0, 30);
    out.fsStat = await k.fs.stat('koda-smoke.txt');
    out.fsSearch = (await k.fs.search({ query: 'smoke', maxResults: 5 })).length;
    await k.fs.delete('koda-smoke.txt');
    // Sandbox renderer khong co process object — dung lenh echo on dinh.
    out.shellRun = await k.shell.run({ command: 'echo koda-ok' });
    try { out.gitStatus = await k.git.status(); } catch (e) { out.gitStatus = { error: String(e).slice(0, 120) }; }
    try { out.escape = await k.fs.read('../outside.txt'); } catch (e) { out.escape = 'BLOCKED: ' + String(e).slice(0, 80); }
    return out;
  })()`;
  try {
    const result = await mainWindow.webContents.executeJavaScript(script, true);
    klog('[smoke] kết quả:', JSON.stringify(result, null, 2));
    const pass =
      result.fingerprint?.desktop === true &&
      result.workspaceGet?.path &&
      typeof result.fsList === 'number' &&
      typeof result.fsRead === 'string' &&
      result.fsStat?.exists === true &&
      typeof result.fsSearch === 'number' &&
      result.shellRun?.code === 0 &&
      String(result.escape).startsWith('BLOCKED:');
    klog(`[smoke] ${pass ? 'PASS' : 'FAIL'}`);
    if (!pass) app.exit(1);
  } catch (e) {
    klog('[smoke] FAIL:', String(e));
    app.exit(1);
  }
}
