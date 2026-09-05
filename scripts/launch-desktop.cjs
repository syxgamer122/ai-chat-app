#!/usr/bin/env node
/**
 * Vyen Fast Desktop Launcher (Goose / Pi architecture).
 *
 * Thay thế Electron nặng nề (~600MB RAM, 80s startup) bằng Native App Mode (Edge/Chrome/WebView2):
 * - Khởi động < 0.3s
 * - Tiêu tốn ~35MB RAM (giảm 90% so với Electron)
 * - Cửa sổ độc lập, frameless/app frame, không URL bar, không tabs
 * - Kết nối trực tiếp vào Next.js server cục bộ và sử dụng Universal Web Bridge
 */

const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const rawArgs = process.argv.slice(2);
let customPort = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
let customWorkspace = process.env.VYEN_WORKSPACE_ROOT || null;
let customWindowSize = '1360,880';
let forceDev = false;
let noOpen = false;

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--help' || a === '-h' || a === 'help') {
    console.log(`
Vyen Fast Desktop Launcher (Goose & Pi WebView architecture)

Cách dùng:
  node scripts/launch-desktop.cjs [tùy chọn]

Tùy chọn:
  --port, -p <number>          Cổng Next.js server (mặc định: autodetect 3000/3001/3002/3457)
  --workspace, -w <path>       Thư mục làm việc (Workspace root)
  --window-size <width,height> Kích thước cửa sổ (mặc định: 1360,880)
  --dev                        Bắt buộc chạy server ở chế độ dev (next dev)
  --no-open                    Chỉ khởi động server, không mở cửa sổ browser
  --help, -h                   Hiển thị hướng dẫn này
`);
    process.exit(0);
  } else if (a === '--port' || a === '-p') {
    if (rawArgs[i + 1]) customPort = parseInt(rawArgs[++i], 10);
  } else if (a.startsWith('--port=')) {
    customPort = parseInt(a.slice('--port='.length), 10);
  } else if (a.startsWith('-p=')) {
    customPort = parseInt(a.slice('-p='.length), 10);
  } else if (a.startsWith('-p') && !a.startsWith('--')) {
    customPort = parseInt(a.slice(2), 10);
  } else if (a === '--workspace' || a === '-w') {
    if (rawArgs[i + 1]) customWorkspace = path.resolve(rawArgs[++i]);
  } else if (a.startsWith('--workspace=')) {
    customWorkspace = path.resolve(a.slice('--workspace='.length));
  } else if (a.startsWith('-w=')) {
    customWorkspace = path.resolve(a.slice('-w='.length));
  } else if (a.startsWith('-w') && !a.startsWith('--')) {
    customWorkspace = path.resolve(a.slice(2));
  } else if (a === '--window-size') {
    if (rawArgs[i + 1]) customWindowSize = rawArgs[++i];
  } else if (a.startsWith('--window-size=')) {
    customWindowSize = a.slice('--window-size='.length);
  } else if (a === '--dev') {
    forceDev = true;
  } else if (a === '--no-open') {
    noOpen = true;
  }
}

if (!customPort || Number.isNaN(customPort) || customPort <= 0 || customPort > 65535) {
  customPort = null;
}

if (customWorkspace) {
  process.env.VYEN_WORKSPACE_ROOT = customWorkspace;
}

const DEFAULT_PORTS = [3000, 3001, 3002, 3457];
const defaultPorts = DEFAULT_PORTS;
const PORTS = customPort ? Array.from(new Set([customPort, ...defaultPorts])) : defaultPorts;
const APP_DIR = path.resolve(__dirname, '..');

let spawnedServerChild = null;

/* ------------------------------------------------------------------ */
/* Bridge token — chìa khoá /api/bridge của phiên server (xem          */
/* lib/bridge/bridge-token.ts và lib/desktop-bridge.ts phía renderer)   */
/* ------------------------------------------------------------------ */

// Token launcher sinh cho server con MỚI spawn trong lần chạy này. Server
// đang chạy từ trước (reconnect) thì phải đọc file token trong userDataDir.
let spawnedBridgeToken = null;

function getSpawnedBridgeToken() {
  return spawnedBridgeToken;
}

/** Chỉ dùng bởi test: xoá token đã sinh để giả lập một tiến trình launcher mới. */
function resetSpawnedBridgeToken() {
  spawnedBridgeToken = null;
}

/** Mirror getBridgeUserDataDir (lib/bridge/server-bridge.ts) — đổi một chỗ sửa cả hai. */
function resolveBridgeUserDataDir() {
  const custom = process.env.VYEN_USER_DATA_DIR;
  if (custom && fs.existsSync(custom)) return custom;

  const baseDir =
    process.platform === 'win32'
      ? process.env.APPDATA || os.homedir()
      : path.join(os.homedir(), '.config');

  const target = path.join(baseDir, 'ai-chat');
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {
    return os.tmpdir();
  }
  return target;
}

/** Đọc token fallback server ghi ra userDataDir; null khi thiếu/hỏng format. */
function readBridgeTokenFile() {
  try {
    const token = fs
      .readFileSync(path.join(resolveBridgeUserDataDir(), 'vyen-bridge-token'), 'utf8')
      .trim();
    // base64url của 256-bit = 43 ký tự; cận trên chỉ là phòng file rác — tránh
    // mở browser với fragment dài bất thường.
    return /^[A-Za-z0-9_-]{20,200}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * Verify token với server đang chạy: GET /api/bridge kèm header token,
 * kỳ vọng 200. Cần vì nhiều server Vyen có thể chung userDataDir nhưng mỗi
 * phiên một token — token trong file chưa chắc của server sắp kết nối.
 */
function verifyBridgeTokenWithServer(baseUrl, token, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (req) {
        try {
          req.destroy();
        } catch {}
      }
      resolve(val);
    };

    let target;
    try {
      target = new URL('/api/bridge', baseUrl);
    } catch {
      return resolve(false);
    }

    const client = target.protocol.startsWith('https:') ? https : http;
    let req = null;
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    try {
      req = client.get(
        target,
        {
          timeout: timeoutMs,
          // Giống probe(): sec-fetch-site same-origin để đi qua isLocalRequest.
          headers: {
            'sec-fetch-site': 'same-origin',
            'x-vyen-bridge-token': token,
            'user-agent': 'vyen-desktop-launcher',
            accept: 'application/json',
          },
        },
        (res) => {
          const ok = res.statusCode === 200;
          try {
            res.resume();
          } catch {}
          finish(ok);
        }
      );
      req.on('timeout', () => finish(false));
      req.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/**
 * Token để gắn vào URL mở browser, hoặc null khi bridge không khả dụng:
 * - Server do chính launcher spawn: dùng token đã truyền qua env.
 * - Reconnect: đọc file trong userDataDir rồi verify với server đang chạy.
 */
async function resolveBridgeTokenForUrl(baseUrl) {
  if (spawnedBridgeToken) return spawnedBridgeToken;

  const token = readBridgeTokenFile();
  if (!token) return null;

  const ok = await verifyBridgeTokenWithServer(baseUrl, token);
  if (!ok) {
    console.warn(
      '[vyen-launcher] Bridge token trong userDataDir không khớp server đang chạy — mở không kèm token (tính năng fs/shell/git của bridge sẽ bị khoá cho phiên này).'
    );
    return null;
  }
  return token;
}

/** Gắn fragment `#bt=<token>` vào URL; token rỗng → giữ nguyên URL. */
function composeAppUrl(baseUrl, token) {
  if (!token) return baseUrl;
  return `${baseUrl}#bt=${encodeURIComponent(token)}`;
}

function cleanupChild() {
  if (spawnedServerChild) {
    try {
      if (typeof spawnedServerChild.kill === 'function') {
        spawnedServerChild.kill('SIGTERM');
      }
      const isRealChildProcess =
        spawnedServerChild instanceof require('node:child_process').ChildProcess ||
        spawnedServerChild.spawnargs !== undefined ||
        spawnedServerChild.connected !== undefined ||
        spawnedServerChild.stdin !== undefined;

      if (
        process.platform === 'win32' &&
        spawnedServerChild.pid &&
        spawnedServerChild.exitCode === null &&
        !spawnedServerChild.killed &&
        isRealChildProcess
      ) {
        spawnSync('taskkill', ['/pid', String(spawnedServerChild.pid), '/T', '/F'], { stdio: 'ignore' });
      }
    } catch {}
    spawnedServerChild = null;
  }
}

process.on('SIGINT', () => {
  cleanupChild();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupChild();
  process.exit(0);
});
process.on('exit', () => {
  cleanupChild();
});

function checkSocketConnect(port, host = '127.0.0.1', timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (inUse) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

function checkBind(port, host) {
  return new Promise((resolve) => {
    let settled = false;
    const server = net.createServer();
    server.unref();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (server.listening) {
        let closed = false;
        const done = () => {
          if (closed) return;
          closed = true;
          resolve(result);
        };
        try {
          server.close(done);
        } catch {
          done();
        }
        if (typeof setTimeout === 'function') {
          const t = setTimeout(done, 100);
          if (t && typeof t.unref === 'function') t.unref();
        }
      } else {
        try {
          server.close();
        } catch {}
        resolve(result);
      }
    };

    server.once('error', (err) => {
      // Trên một số hệ điều hành / cấu hình không hỗ trợ IPv6 hoặc route không khả dụng,
      // bind vào ::1 hoặc :: sẽ quăng lỗi EAFNOSUPPORT / EADDRNOTAVAIL / EPROTONOSUPPORT / EINVAL / ENETUNREACH.
      // Điều này không đồng nghĩa cổng bị chiếm dụng bởi tiến trình khác.
      if (host === '::1' || host === '::') {
        if (
          err &&
          (err.code === 'EAFNOSUPPORT' ||
            err.code === 'EADDRNOTAVAIL' ||
            err.code === 'EPROTONOSUPPORT' ||
            err.code === 'EINVAL' ||
            err.code === 'ENETUNREACH')
        ) {
          return finish(true);
        }
      } else if (err && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
        return finish(true);
      }
      finish(false);
    });

    server.once('listening', () => {
      finish(true);
    });

    try {
      server.listen({ port, host, exclusive: true });
    } catch (err) {
      if (host === '::1' || host === '::') {
        if (
          err &&
          (err.code === 'EAFNOSUPPORT' ||
            err.code === 'EADDRNOTAVAIL' ||
            err.code === 'EPROTONOSUPPORT' ||
            err.code === 'EINVAL' ||
            err.code === 'ENETUNREACH')
        ) {
          return finish(true);
        }
      } else if (err && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
        return finish(true);
      }
      finish(false);
    }
  });
}

async function isPortAvailable(port) {
  if (
    !port ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535
  ) {
    return false;
  }

  // Kiểm tra kết nối socket đồng thời trên cả IPv4 và IPv6 loopback
  const [inUseIpv4, inUseIpv6] = await Promise.all([
    checkSocketConnect(port, '127.0.0.1'),
    checkSocketConnect(port, '::1'),
  ]);
  if (inUseIpv4 || inUseIpv6) return false;

  // Kiểm tra quyền bind độc quyền trên cả 127.0.0.1, ::1, :: và 0.0.0.0
  const hostsToTest = ['127.0.0.1', '::1', '::', '0.0.0.0'];
  for (const host of hostsToTest) {
    const ok = await checkBind(port, host);
    if (!ok) return false;
  }

  return true;
}

function getRandomFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((err) => {
        if (err) return reject(err);
        resolve(port);
      });
    });
  });
}

async function findAvailablePort(candidatePorts = PORTS) {
  const filtered = Array.isArray(candidatePorts)
    ? Array.from(new Set(candidatePorts)).filter(
        (p) => typeof p === 'number' && Number.isInteger(p) && p > 0 && p <= 65535
      )
    : [];
  const candidates = filtered.length > 0 ? filtered : DEFAULT_PORTS;

  for (const port of candidates) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const port = await getRandomFreePort();
      if (port && (await isPortAvailable(port))) {
        return port;
      }
    } catch {}
  }

  throw new Error('Không thể tìm thấy cổng mạng khả dụng để khởi động Next.js server.');
}

function probe(urlOrPort, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let targetUrl;
    if (typeof urlOrPort === 'number') {
      targetUrl = `http://127.0.0.1:${urlOrPort}/api/server-config`;
    } else if (typeof urlOrPort === 'string') {
      let trimmed = urlOrPort.trim();
      if (/^\d+$/.test(trimmed)) {
        targetUrl = `http://127.0.0.1:${trimmed}/api/server-config`;
      } else {
        if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
          trimmed = `http://${trimmed}`;
        }
        try {
          const parsed = new URL(trimmed);
          if (!parsed.pathname || parsed.pathname === '/') {
            parsed.pathname = '/api/server-config';
            targetUrl = parsed.toString();
          } else {
            targetUrl = trimmed;
          }
        } catch {
          targetUrl = trimmed;
        }
      }
    } else {
      return resolve(false);
    }

    let resolved = false;
    let req = null;
    let overallTimer = null;

    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      if (overallTimer) clearTimeout(overallTimer);
      if (req) {
        try {
          req.destroy();
        } catch {}
      }
      resolve(val);
    };

    overallTimer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    if (overallTimer && typeof overallTimer.unref === 'function') {
      overallTimer.unref();
    }

    try {
      const client = targetUrl.startsWith('https:') ? https : http;
      req = client.get(
        targetUrl,
        {
          timeout: timeoutMs,
          headers: {
            'sec-fetch-site': 'same-origin',
            'user-agent': 'vyen-desktop-launcher',
            'accept': 'application/json',
          },
        },
        (res) => {
          res.on('error', () => finish(false));

          if (res.statusCode !== 200) {
            try {
              res.destroy();
            } catch {}
            return finish(false);
          }

          const contentType = res.headers['content-type'] || '';
          if (!contentType.includes('json')) {
            try {
              res.destroy();
            } catch {}
            return finish(false);
          }

          let body = '';
          const MAX_PAYLOAD = 65536;

          res.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_PAYLOAD) {
              try {
                res.destroy();
              } catch {}
              finish(false);
            }
          });

          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (
                typeof data === 'object' &&
                data !== null &&
                ('thinkingLevel' in data || 'media' in data)
              ) {
                return finish(true);
              }
            } catch {}
            // Non-Vyen 200 response (e.g. random web server returning HTML or other JSON)
            finish(false);
          });
        }
      );
    } catch {
      return finish(false);
    }

    req.on('timeout', () => finish(false));
    req.on('error', () => finish(false));
  });
}

async function findRunningServer(candidatePorts = PORTS, timeoutMs = 1200) {
  const uniquePorts = Array.from(new Set(candidatePorts));
  const portResults = await Promise.all(
    uniquePorts.map(async (port) => {
      const results = await Promise.all([
        probe(`http://127.0.0.1:${port}/api/server-config`, timeoutMs).then((ok) =>
          ok ? `http://127.0.0.1:${port}` : null
        ),
        probe(`http://localhost:${port}/api/server-config`, timeoutMs).then((ok) =>
          ok ? `http://localhost:${port}` : null
        ),
        probe(`http://[::1]:${port}/api/server-config`, timeoutMs).then((ok) =>
          ok ? `http://[::1]:${port}` : null
        ),
      ]);
      return results.find(Boolean) || null;
    })
  );
  return portResults.find(Boolean) || null;
}

function findBrowserBinary() {
  if (process.platform === 'win32') {
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const progW6432 = process.env.ProgramW6432 || 'C:\\Program Files';
    const localAppData =
      process.env.LOCALAPPDATA ||
      (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');

    const candidates = [
      path.join(progFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(progFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(progW6432, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(localAppData, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(progFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(progFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(progW6432, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(progFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(progFilesX86, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(progW6432, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(localAppData, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return c;
    }

    // Kiểm tra qua where.exe nếu các đường dẫn tĩnh không khớp
    for (const name of ['msedge.exe', 'chrome.exe', 'brave.exe']) {
      try {
        const res = spawnSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (res.status === 0 && res.stdout) {
          const firstLine = res.stdout.split('\r\n')[0].split('\n')[0].trim();
          if (firstLine && fs.existsSync(firstLine)) return firstLine;
        }
      } catch {}
    }

    return 'native-open';
  } else if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return 'open';
  } else {
    // Linux
    const candidates = ['google-chrome', 'chromium-browser', 'chromium', 'microsoft-edge', 'brave-browser'];
    for (const c of candidates) {
      try {
        const res = spawnSync('which', [c], { stdio: 'ignore' });
        if (res.status === 0) return c;
      } catch {}
    }
    return 'xdg-open';
  }
}

function resolveNextBin() {
  try {
    return require.resolve('next/dist/bin/next', { paths: [APP_DIR] });
  } catch {}
  const localBin = path.join(APP_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return null;
}

function resolveNpmCli() {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  return null;
}

function checkHasProductionBuild() {
  const buildIdPath = path.join(APP_DIR, '.next', 'BUILD_ID');
  const serverDir = path.join(APP_DIR, '.next', 'server');
  return fs.existsSync(buildIdPath) && fs.existsSync(serverDir);
}

function spawnServerProcess(runSubcmd, env, options = {}) {
  const targetPort = options.port || customPort;
  const targetWorkspace =
    options.workspace || (env && env.VYEN_WORKSPACE_ROOT) || customWorkspace;
  const childEnv = {
    ...process.env,
    ...(env || {}),
    ...(targetPort ? { PORT: String(targetPort) } : {}),
    ...(targetWorkspace ? { VYEN_WORKSPACE_ROOT: targetWorkspace } : {}),
  };

  const nextBin = resolveNextBin();
  const forceNpm = process.env.VYEN_USE_NPM === '1' || Boolean(options.forceNpm);
  const useDirectNode = !forceNpm && Boolean(nextBin);

  // Strategy 1: Trực tiếp qua Node binary + next CLI (không shell, không .cmd, không EINVAL)
  if (useDirectNode) {
    try {
      const nodeArgs = [nextBin, runSubcmd];
      if (targetPort) {
        nodeArgs.push('-p', String(targetPort));
      }
      if (Array.isArray(options.extraArgs)) {
        nodeArgs.push(...options.extraArgs);
      }
      return spawn(process.execPath, nodeArgs, {
        cwd: APP_DIR,
        stdio: options.stdio || 'inherit',
        detached: false,
        env: childEnv,
      });
    } catch (err) {
      console.warn('[vyen-launcher] Không thể khởi động qua node trực tiếp, chuyển sang npm:', err?.message || err);
    }
  }

  // Strategy 2: nếu có npm-cli.js (khi chạy npm run desktop), gọi qua Node trực tiếp
  const npmCli = resolveNpmCli();
  if (npmCli) {
    try {
      const npmArgs = [npmCli, 'run', runSubcmd];
      if (targetPort) {
        npmArgs.push('--', '-p', String(targetPort));
      }
      if (Array.isArray(options.extraArgs)) {
        npmArgs.push(...options.extraArgs);
      }
      return spawn(process.execPath, npmArgs, {
        cwd: APP_DIR,
        stdio: options.stdio || 'inherit',
        detached: false,
        env: childEnv,
      });
    } catch (err) {
      console.warn('[vyen-launcher] Không thể khởi động qua npm-cli trực tiếp, dùng lệnh npm hệ thống:', err?.message || err);
    }
  }

  // Strategy 3: Fallback qua npm hệ thống
  // Trên Windows bắt buộc phải dùng shell: true do CVE-2024-27980.
  // Truyền toàn bộ command string thay vì mảng args để tránh [DEP0190] DeprecationWarning.
  if (process.platform === 'win32') {
    let cmd = `npm.cmd run ${runSubcmd}`;
    if (targetPort) {
      cmd += ` -- -p ${targetPort}`;
    }
    if (Array.isArray(options.extraArgs) && options.extraArgs.length > 0) {
      cmd += ` -- ${options.extraArgs.join(' ')}`;
    }
    return spawn(cmd, {
      cwd: APP_DIR,
      stdio: options.stdio || 'inherit',
      detached: false,
      shell: true,
      env: childEnv,
    });
  }

  const args = ['run', runSubcmd];
  if (targetPort) {
    args.push('--', '-p', String(targetPort));
  }
  if (Array.isArray(options.extraArgs)) {
    args.push(...options.extraArgs);
  }
  return spawn('npm', args, {
    cwd: APP_DIR,
    stdio: options.stdio || 'inherit',
    detached: false,
    shell: false,
    env: childEnv,
  });
}

async function startServerIfNeeded(candidatePorts = PORTS, options = {}) {
  let optCustomPort = options.customPort !== undefined ? options.customPort : customPort;
  if (typeof optCustomPort === 'string') {
    optCustomPort = parseInt(optCustomPort, 10);
  }
  if (
    typeof optCustomPort !== 'number' ||
    !Number.isInteger(optCustomPort) ||
    optCustomPort <= 0 ||
    optCustomPort > 65535
  ) {
    optCustomPort = null;
  }

  const optCustomWorkspace = options.customWorkspace !== undefined ? options.customWorkspace : customWorkspace;
  const optForceDev = options.forceDev !== undefined ? options.forceDev : forceDev;
  const optSpawnFn = options.spawnFn || spawnServerProcess;
  const optTimeoutMs = options.timeoutMs || 60_000;
  const optProbeTimeoutMs = options.probeTimeoutMs || 2500;
  const optPollIntervalMs = options.pollIntervalMs || 1000;

  // Mỗi lần gọi là một tiến trình launcher mới về mặt logic — xoá token của
  // lần spawn trước để nhánh reconnect bên dưới không dùng token stale.
  spawnedBridgeToken = null;

  // 1. Kiểm tra xem đã có server Vyen đang chạy chưa (R2)
  // Nếu người dùng yêu cầu cổng cụ thể, kiểm tra cổng đó trước.
  const portsToProbeFirst = optCustomPort ? [optCustomPort] : candidatePorts;
  let url = await findRunningServer(portsToProbeFirst, optProbeTimeoutMs);
  if (url) {
    console.log(`[vyen-launcher] Tìm thấy server đang chạy tại ${url} — mở ngay!`);
    return url;
  }

  // 2. Tự động kiểm tra tính khả dụng và fallback cổng nếu bị chiếm dụng (R1)
  let selectedPort;
  if (optCustomPort && (await isPortAvailable(optCustomPort))) {
    selectedPort = optCustomPort;
  } else {
    const fallbackCandidates = candidatePorts.filter((p) => p !== optCustomPort);
    const candidates = (
      fallbackCandidates.length > 0 ? fallbackCandidates : DEFAULT_PORTS
    ).filter((p) => p !== optCustomPort);

    // Nếu customPort bị chiếm dụng, trước khi spawn cổng mới, kiểm tra xem trong candidate fallback có server Vyen nào đang chạy không (R2)
    if (optCustomPort) {
      const fallbackUrl = await findRunningServer(candidates, optProbeTimeoutMs);
      if (fallbackUrl) {
        console.log(`[vyen-launcher] Tìm thấy server Vyen đang chạy tại ${fallbackUrl} — kết nối ngay!`);
        return fallbackUrl;
      }
    }

    selectedPort = await findAvailablePort(candidates);
  }

  const primaryPort = optCustomPort || (candidatePorts.length > 0 ? candidatePorts[0] : 3000);
  if (optCustomPort && selectedPort !== optCustomPort) {
    console.warn(
      `[vyen-launcher] Cổng chỉ định ${optCustomPort} đang bị chiếm dụng. Tự động chuyển sang cổng khả dụng: ${selectedPort}`
    );
  } else if (!optCustomPort && selectedPort !== primaryPort) {
    console.log(
      `[vyen-launcher] Cổng ${primaryPort} đang bị chiếm dụng. Tự động chuyển sang cổng khả dụng: ${selectedPort}`
    );
  }

  const hasBuild = checkHasProductionBuild();
  const runSubcmd = (!optForceDev && hasBuild) ? 'start' : 'dev';

  console.log(`[vyen-launcher] Chưa có server, đang khởi động Next.js (${runSubcmd}) trên cổng ${selectedPort}...`);

  // Token 256-bit cho phiên server này: truyền qua env cho con (server dùng
  // làm chìa khoá /api/bridge), launcher giữ lại để gắn fragment `#bt=` vào
  // URL mở browser sau khi server sẵn sàng.
  const bridgeToken = crypto.randomBytes(32).toString('base64url');
  spawnedBridgeToken = bridgeToken;

  const env = {
    ...process.env,
    PORT: String(selectedPort),
    ...(optCustomWorkspace ? { VYEN_WORKSPACE_ROOT: optCustomWorkspace } : {}),
    VYEN_BRIDGE_TOKEN: bridgeToken,
  };

  const child = optSpawnFn(runSubcmd, env, {
    port: selectedPort,
    workspace: optCustomWorkspace,
  });
  if (!child || typeof child.on !== 'function') {
    throw new Error('Không thể khởi tạo tiến trình Next.js server.');
  }
  spawnedServerChild = child;

  let childExited = false;
  let exitCode = null;
  child.on('exit', (code, signal) => {
    childExited = true;
    exitCode = code !== null ? code : signal;
    if (code !== null && code !== 0) {
      process.exitCode = code;
    }
  });
  child.on('error', (err) => {
    console.error('[vyen-launcher] Lỗi tiến trình server:', err);
  });

  const deadline = Date.now() + optTimeoutMs;
  // Chỉ thăm dò cổng mà Next.js được chỉ định khởi động (tránh trễ do cổng chiếm dụng và tránh nhầm lẫn instance)
  const probePorts = [selectedPort];
  try {
    let firstTick = true;
    while (Date.now() < deadline) {
      if (childExited) {
        cleanupChild();
        throw new Error(`Tiến trình Next.js server đã dừng sớm (mã thoát: ${exitCode}).`);
      }
      if (!firstTick) {
        await new Promise((r) => setTimeout(r, optPollIntervalMs));
      }
      firstTick = false;
      url = await findRunningServer(probePorts, optProbeTimeoutMs);
      if (url) {
        console.log(`[vyen-launcher] Server đã sẵn sàng tại ${url}!`);
        return url;
      }
    }

    cleanupChild();
    throw new Error('Timeout chờ Next.js server khởi động.');
  } catch (err) {
    cleanupChild();
    throw err;
  }
}

function buildBrowserArgs(targetUrl, options = {}) {
  const winSize = options.windowSize || customWindowSize || '1360,880';
  const localAppData =
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : os.tmpdir());
  const userDataDir = options.userDataDir || path.join(localAppData, 'Vyen', 'browser-profile');
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
  } catch {}

  return [
    `--app=${targetUrl}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${winSize}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
  ];
}

async function launch() {
  try {
    const baseUrl = await startServerIfNeeded(PORTS);

    if (noOpen || process.env.VYEN_LAUNCHER_NO_BROWSER === '1') {
      console.log(`[vyen-launcher] Server đã sẵn sàng tại ${baseUrl} (bỏ qua mở cửa sổ browser theo yêu cầu).`);
      return;
    }

    // Token phải có TRƯỚC khi build browser args: fragment `#bt=` nằm trong
    // chính URL của cờ --app, không phải một cờ riêng.
    const bridgeToken = await resolveBridgeTokenForUrl(baseUrl);
    const targetUrl = composeAppUrl(baseUrl, bridgeToken);

    const browserBin = findBrowserBinary();

    console.log(`[vyen-launcher] Mở App Window với: ${browserBin} (Kích thước: ${customWindowSize})`);

    const args = buildBrowserArgs(targetUrl, { windowSize: customWindowSize });

    const fallbackOpen = () => {
      try {
        console.log(`[vyen-launcher] Mở trình duyệt mặc định: ${targetUrl}`);
        if (process.platform === 'win32') {
          spawn('cmd.exe', ['/c', 'start', '""', targetUrl], {
            detached: true,
            stdio: 'ignore',
            windowsVerbatimArguments: true,
          });
        } else if (process.platform === 'darwin') {
          spawn('open', [targetUrl], { detached: true, stdio: 'ignore' });
        } else {
          spawn('xdg-open', [targetUrl], { detached: true, stdio: 'ignore' });
        }
      } catch (err) {
        console.warn('[vyen-launcher] Lỗi khi mở fallback browser:', err?.message || err);
      }
    };

    if (browserBin === 'native-open' || browserBin === 'open' || browserBin === 'xdg-open') {
      fallbackOpen();
    } else {
      try {
        const p = spawn(browserBin, args, {
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });

        let didFallback = false;

        p.on('error', (err) => {
          if (!didFallback) {
            didFallback = true;
            console.warn('[vyen-launcher] Không mở được qua app mode, mở trình duyệt mặc định:', err.message);
            fallbackOpen();
          }
        });

        let stderrBuf = '';
        if (p.stderr) {
          p.stderr.on('data', (chunk) => {
            stderrBuf += chunk.toString();
          });
        }

        p.on('exit', (code) => {
          if (code !== 0 && code !== null && !didFallback) {
            didFallback = true;
            console.warn(
              `[vyen-launcher] App mode thoát bất thường (mã ${code})${stderrBuf ? ': ' + stderrBuf.trim() : ''}. Đang mở trình duyệt mặc định...`
            );
            fallbackOpen();
          }
        });

        const unrefTimer = setTimeout(() => {
          try {
            p.unref();
          } catch {}
        }, 1500);
        if (unrefTimer && typeof unrefTimer.unref === 'function') {
          unrefTimer.unref();
        }
      } catch (err) {
        console.warn('[vyen-launcher] Không mở được qua app mode, mở trình duyệt mặc định:', err?.message || err);
        fallbackOpen();
      }
    }

    console.log('[vyen-launcher] Cửa sổ Vyen Desktop đã được mở thành công!');
  } catch (err) {
    console.error('[vyen-launcher] Lỗi khởi chạy:', err);
    cleanupChild();
    process.exit(1);
  }
}

if (require.main === module) {
  launch();
}

module.exports = {
  DEFAULT_PORTS,
  resolveNextBin,
  resolveNpmCli,
  checkHasProductionBuild,
  spawnServerProcess,
  startServerIfNeeded,
  findRunningServer,
  findAvailablePort,
  isPortAvailable,
  checkSocketConnect,
  checkBind,
  getRandomFreePort,
  findBrowserBinary,
  cleanupChild,
  probe,
  launch,
  buildBrowserArgs,
  getSpawnedBridgeToken,
  resetSpawnedBridgeToken,
  resolveBridgeUserDataDir,
  readBridgeTokenFile,
  verifyBridgeTokenWithServer,
  resolveBridgeTokenForUrl,
  composeAppUrl,
};
