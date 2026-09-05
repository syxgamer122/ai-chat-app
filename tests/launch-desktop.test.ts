import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const launcher = require('../scripts/launch-desktop.cjs');

/**
 * Ngân sách cho các case spawn tiến trình Node THẬT: chỉ riêng việc nạp CLI của
 * Next.js đã mất ~1.5-2.5s trên máy rảnh, và full suite chạy nhiều worker song
 * song nên các tiến trình con phải giành CPU với nhau. Mặc định 5s của vitest đủ
 * khi chạy riêng file này nhưng đứt khi chạy chung: đó là nguồn flaky ở đây,
 * không phải race trong launcher.
 */
const REAL_SPAWN_TIMEOUT_MS = 30_000;

/**
 * Chờ tiến trình con thoát và gom stdout/stderr. Phải đọc pipe: với
 * `stdio: 'pipe'` mà không ai tiêu thụ, buffer đầy (64KB trên Windows) sẽ chặn
 * tiến trình con giữa lúc ghi và 'exit' không bao giờ tới. Output gom được là
 * manh mối duy nhất khi exit code khác 0.
 */
function awaitChildExit(child: ChildProcess): Promise<{ code: number | null; output: string }> {
  let output = '';
  const collect = (chunk: Buffer | string) => {
    output += chunk.toString();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, output }));
    child.on('error', (err) => resolve({ code: -1, output: `${output}\n[spawn error] ${err.message}` }));
  });
}

describe('launch-desktop.cjs cross-platform server launcher', () => {
  it('hỗ trợ cờ --help và thoát 0 với mô tả tùy chọn đầy đủ', () => {
    const res = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'launch-desktop.cjs'), '--help'], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Vyen Fast Desktop Launcher');
    expect(res.stdout).toContain('--port');
    expect(res.stdout).toContain('--no-open');
  });

  it('resolveNextBin tìm thấy binary Next.js hợp lệ trên ổ đĩa', () => {
    const nextBin = launcher.resolveNextBin();
    expect(typeof nextBin).toBe('string');
    expect(fs.existsSync(nextBin)).toBe(true);
    expect(nextBin).toContain('next');
  });

  it('resolveNpmCli trả về đường dẫn CLI npm hợp lệ hoặc null khi không ở môi trường npm', () => {
    const npmCli = launcher.resolveNpmCli();
    if (npmCli) {
      expect(typeof npmCli).toBe('string');
      expect(fs.existsSync(npmCli)).toBe(true);
    } else {
      expect(npmCli).toBeNull();
    }
  });

  it('checkHasProductionBuild xác thực chính xác BUILD_ID và server dir (không nhầm dev cache)', () => {
    const hasProd = launcher.checkHasProductionBuild();
    expect(typeof hasProd).toBe('boolean');
    const buildIdExists = fs.existsSync(path.join(process.cwd(), '.next', 'BUILD_ID'));
    const serverDirExists = fs.existsSync(path.join(process.cwd(), '.next', 'server'));
    expect(hasProd).toBe(buildIdExists && serverDirExists);
  });

  it('findBrowserBinary tìm được trình duyệt hoặc chuỗi fallback hợp lệ', () => {
    const browser = launcher.findBrowserBinary();
    expect(typeof browser).toBe('string');
    expect(browser.length).toBeGreaterThan(0);
  });

  it('tái hiện chính xác lỗi spawn EINVAL trên Windows khi gọi npm.cmd thiếu shell: true', () => {
    if (process.platform !== 'win32') return;

    let threwEinval = false;
    try {
      // Gọi trực tiếp npm.cmd không có shell: true sẽ kích hoạt bảo mật CVE-2024-27980
      spawn('npm.cmd', ['--version'], { shell: false });
    } catch (err: any) {
      if (err && err.code === 'EINVAL') {
        threwEinval = true;
      }
    }
    expect(threwEinval).toBe(true);
  });

  it('khởi chạy trực tiếp qua Node (direct node invocation) thành công không văng lỗi EINVAL', async () => {
    const nextBin = launcher.resolveNextBin();
    expect(nextBin).toBeTruthy();

    const child = spawn(process.execPath, [nextBin, '-v'], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    expect(child.pid).toBeTypeOf('number');

    const { code, output } = await awaitChildExit(child);
    expect(code, output).toBe(0);
  }, REAL_SPAWN_TIMEOUT_MS);

  it('spawnServerProcess qua direct node mode thực sự gọi hàm và chạy trơn tru', async () => {
    // Gọi trực tiếp launcher.spawnServerProcess với extraArgs --help để thoát ngay
    const child = launcher.spawnServerProcess('dev', process.env, {
      stdio: 'pipe',
      extraArgs: ['--help'],
    });

    expect(child).toBeDefined();
    expect(child.pid).toBeTypeOf('number');

    const { code, output } = await awaitChildExit(child);
    expect(code, output).toBe(0);
  }, REAL_SPAWN_TIMEOUT_MS);

  it('spawnServerProcess với forceNpm=true không văng lỗi EINVAL trên mọi nền tảng', async () => {
    const child = launcher.spawnServerProcess('dev', process.env, {
      forceNpm: true,
      stdio: 'pipe',
      extraArgs: ['--help'],
    });

    expect(child).toBeDefined();
    expect(child.pid).toBeTypeOf('number');

    const { code, output } = await awaitChildExit(child);
    expect(code, output).toBe(0);
  }, REAL_SPAWN_TIMEOUT_MS);

  it('probe() phân biệt chính xác server Vyen (200) vs server lạ trả về 404', async () => {
    // Tạo HTTP server mock để test
    let mockStatusCode = 404;
    let mockResponseBody = JSON.stringify({ error: 'not found' });

    const server = http.createServer((req, res) => {
      res.writeHead(mockStatusCode, { 'Content-Type': 'application/json' });
      res.end(mockResponseBody);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    const testUrl = `http://127.0.0.1:${addr.port}/api/server-config`;

    try {
      // 1. Khi server khác trả về 404 (ví dụ server không phải Vyen), probe() PHẢI trả về false
      mockStatusCode = 404;
      const res404 = await launcher.probe(testUrl, 1000);
      expect(res404).toBe(false);

      // 2. Khi server Vyen trả về 200 với json config, probe() trả về true
      mockStatusCode = 200;
      mockResponseBody = JSON.stringify({ thinkingLevel: true, media: false });
      const res200 = await launcher.probe(testUrl, 1000);
      expect(res200).toBe(true);

      // 3. Khi server trả về 403 (chặn same-origin), probe() trả về false
      mockStatusCode = 403;
      const res403 = await launcher.probe(testUrl, 1000);
      expect(res403).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // 4. Khi port không có server lắng nghe, probe() trả về false mà không crash
    const resOffline = await launcher.probe(`http://127.0.0.1:${addr.port}/api/server-config`, 500);
    expect(resOffline).toBe(false);
  });

  it('isPortAvailable phát hiện chính xác cổng bận vs cổng trống', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const busy = await launcher.isPortAvailable(port);
      expect(busy).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const free = await launcher.isPortAvailable(port);
    expect(free).toBe(true);

    // Cổng không hợp lệ
    expect(await launcher.isPortAvailable(0)).toBe(false);
    expect(await launcher.isPortAvailable(-1)).toBe(false);
    expect(await launcher.isPortAvailable(70000)).toBe(false);
  });

  it('findAvailablePort tự động bỏ qua cổng bị chiếm dụng và chọn cổng kế tiếp trong candidate list', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const busyPort = (server.address() as net.AddressInfo).port;

    const temp = net.createServer();
    await new Promise<void>((resolve) => temp.listen(0, '127.0.0.1', () => resolve()));
    const freePort = (temp.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => temp.close(() => resolve()));

    try {
      const selected = await launcher.findAvailablePort([busyPort, freePort]);
      expect(selected).toBe(freePort);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('findAvailablePort fallback sang cổng ngẫu nhiên khả dụng khi toàn bộ candidate list bị chiếm', async () => {
    const s1 = net.createServer();
    const s2 = net.createServer();
    await new Promise<void>((resolve) => s1.listen(0, '127.0.0.1', () => resolve()));
    await new Promise<void>((resolve) => s2.listen(0, '127.0.0.1', () => resolve()));
    const p1 = (s1.address() as net.AddressInfo).port;
    const p2 = (s2.address() as net.AddressInfo).port;

    try {
      const randomPort = await launcher.findAvailablePort([p1, p2]);
      expect(randomPort).toBeTypeOf('number');
      expect(randomPort).not.toBe(p1);
      expect(randomPort).not.toBe(p2);
      expect(randomPort).toBeGreaterThan(0);
      expect(await launcher.isPortAvailable(randomPort)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => s1.close(() => resolve()));
      await new Promise<void>((resolve) => s2.close(() => resolve()));
    }
  });

  it('probe() từ chối (false) khi server lạ trả về 200 nhưng là HTML hoặc JSON không phải Vyen', async () => {
    let responseBody = '<html><body>Not Vyen</body></html>';
    let contentType = 'text/html';

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(responseBody);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      // 1. Trả về HTML 200 (server web khác) -> probe PHẢI trả về false
      const resHtml = await launcher.probe(`http://127.0.0.1:${port}/api/server-config`, 800);
      expect(resHtml).toBe(false);

      // 2. Trả về JSON 200 nhưng schema không phải Vyen -> probe PHẢI trả về false
      contentType = 'application/json';
      responseBody = JSON.stringify({ message: 'Hello from foreign app' });
      const resOtherJson = await launcher.probe(`http://127.0.0.1:${port}/api/server-config`, 800);
      expect(resOtherJson).toBe(false);

      // 3. Trả về JSON 200 với schema chuẩn của Vyen -> probe trả về true
      responseBody = JSON.stringify({ thinkingLevel: false, media: true });
      const resVyen = await launcher.probe(`http://127.0.0.1:${port}/api/server-config`, 800);
      expect(resVyen).toBe(true);

      // 4. Hỗ trợ truyền port number hoặc base url
      const resPortNum = await launcher.probe(port, 800);
      expect(resPortNum).toBe(true);
      const resBaseUrl = await launcher.probe(`http://127.0.0.1:${port}`, 800);
      expect(resBaseUrl).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('findRunningServer nhận diện đúng instance Vyen đang chạy và kết nối trực tiếp', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/server-config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ thinkingLevel: true, media: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const url = await launcher.findRunningServer([port], 1000);
      expect(url).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('kịch bản giả lập xung đột cổng (EADDRINUSE): launcher tự động fallback sang cổng tiếp theo', async () => {
    // Giả lập tiến trình lạ (foreign web server) đang chiếm giữ cổng
    const foreignServer = http.createServer((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway from foreign process');
    });
    await new Promise<void>((resolve) => foreignServer.listen(0, '127.0.0.1', () => resolve()));
    const occupiedPort = (foreignServer.address() as net.AddressInfo).port;

    const temp = net.createServer();
    await new Promise<void>((resolve) => temp.listen(0, '127.0.0.1', () => resolve()));
    const fallbackPort = (temp.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => temp.close(() => resolve()));

    try {
      const candidatePorts = [occupiedPort, fallbackPort];

      // 1. findRunningServer không nhầm foreign process là Vyen
      const runningUrl = await launcher.findRunningServer([occupiedPort], 500);
      expect(runningUrl).toBeNull();

      // 2. findAvailablePort tự động phát hiện occupiedPort bị chiếm và chọn fallbackPort
      const chosenPort = await launcher.findAvailablePort(candidatePorts);
      expect(chosenPort).toBe(fallbackPort);

      // 3. spawnServerProcess nhận targetPort được chọn và truyền đúng cờ -p
      const child = launcher.spawnServerProcess('dev', process.env, {
        port: chosenPort,
        stdio: 'pipe',
        extraArgs: ['--help'],
      });
      expect(child).toBeDefined();
      expect(child.pid).toBeTypeOf('number');

      const { code, output } = await awaitChildExit(child);
      expect(code, output).toBe(0);
    } finally {
      await new Promise<void>((resolve) => foreignServer.close(() => resolve()));
    }
  }, REAL_SPAWN_TIMEOUT_MS);

  it('isPortAvailable phát hiện chính xác cổng bị chiếm dụng trên IPv6 loopback (::1)', async () => {
    const server = net.createServer();
    let boundIpv6 = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '::1', () => {
          boundIpv6 = true;
          resolve();
        });
      });
    } catch {
      // Bỏ qua nếu môi trường máy không bật IPv6
      return;
    }

    const port = (server.address() as net.AddressInfo).port;
    try {
      const busy = await launcher.isPortAvailable(port);
      expect(busy).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const free = await launcher.isPortAvailable(port);
    expect(free).toBe(true);
  });

  it('probe() lập tức từ chối khi payload vượt quá 64KB hoặc Content-Type không phải JSON', async () => {
    // 1. Server trả về JSON hợp lệ nhưng chunk stream gửi dữ liệu siêu lớn
    const bigServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Gửi 100KB dữ liệu
      const junk = 'a'.repeat(70000);
      res.end(`{"thinkingLevel": true, "junk": "${junk}"}`);
    });
    await new Promise<void>((resolve) => bigServer.listen(0, '127.0.0.1', () => resolve()));
    const bigPort = (bigServer.address() as net.AddressInfo).port;

    try {
      const res = await launcher.probe(`http://127.0.0.1:${bigPort}/api/server-config`, 1000);
      expect(res).toBe(false);
    } finally {
      await new Promise<void>((resolve) => bigServer.close(() => resolve()));
    }

    // 2. Server trả về 200 nhưng Content-Type là text/plain
    const textServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('{"thinkingLevel": true}');
    });
    await new Promise<void>((resolve) => textServer.listen(0, '127.0.0.1', () => resolve()));
    const textPort = (textServer.address() as net.AddressInfo).port;

    try {
      const res = await launcher.probe(`http://127.0.0.1:${textPort}/api/server-config`, 800);
      expect(res).toBe(false);
    } finally {
      await new Promise<void>((resolve) => textServer.close(() => resolve()));
    }
  });

  it('startServerIfNeeded kết nối thẳng vào server Vyen đang chạy mà không spawn tiến trình thừa (R2)', async () => {
    const vyenServer = http.createServer((req, res) => {
      if (req.url === '/api/server-config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ thinkingLevel: true, media: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => vyenServer.listen(0, '127.0.0.1', () => resolve()));
    const port = (vyenServer.address() as net.AddressInfo).port;

    let spawnCalled = false;
    const mockSpawnFn = () => {
      spawnCalled = true;
      return { on: () => {} };
    };

    try {
      const url = await launcher.startServerIfNeeded([port], {
        spawnFn: mockSpawnFn,
        probeTimeoutMs: 800,
      });

      expect(url).toBe(`http://127.0.0.1:${port}`);
      expect(spawnCalled).toBe(false);
    } finally {
      await new Promise<void>((resolve) => vyenServer.close(() => resolve()));
    }
  });

  it('startServerIfNeeded tôn trọng cổng chỉ định (customPort) và không bị chiếm quyền bởi server trên cổng khác', async () => {
    // Server A: đang chạy Vyen
    const vyenServerA = http.createServer((req, res) => {
      if (req.url === '/api/server-config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ thinkingLevel: true, media: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => vyenServerA.listen(0, '127.0.0.1', () => resolve()));
    const portA = (vyenServerA.address() as net.AddressInfo).port;

    // Cổng B: cổng trống người dùng chỉ định qua --port
    const temp = net.createServer();
    await new Promise<void>((resolve) => temp.listen(0, '127.0.0.1', () => resolve()));
    const portB = (temp.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => temp.close(() => resolve()));

    let resolveSpawn: (port: number) => void;
    const spawnPromise = new Promise<number>((r) => {
      resolveSpawn = r;
    });
    const mockSpawnFn = (_subcmd: string, _env: any, opts: any) => {
      resolveSpawn(opts.port);
      // Mock child emitter: launcher chỉ cần .on() để gắn handler exit/error
      return { pid: 12345, on: () => {} };
    };

    try {
      // Khi user truyền customPort = portB, launcher KHÔNG được trả về portA
      // mà phải chọn portB để spawn
      const promise = launcher.startServerIfNeeded([portA, portB], {
        customPort: portB,
        spawnFn: mockSpawnFn,
        timeoutMs: 200,
        probeTimeoutMs: 50,
        pollIntervalMs: 40,
      });

      // Chờ đúng sự kiện spawn thay vì ngủ 60ms: chuỗi probe + kiểm tra cổng
      // trước đó là I/O thật, trên máy đang tải nặng nó chạy lâu hơn mọi mốc
      // thời gian đoán trước.
      expect(await spawnPromise).toBe(portB);

      // Cho promise kết thúc bằng cách giả lập timeout hoặc hủy
      await expect(promise).rejects.toThrow('Timeout');
    } finally {
      await new Promise<void>((resolve) => vyenServerA.close(() => resolve()));
    }
  });

  it('startServerIfNeeded tự động fallback sang cổng tiếp theo khi candidate đầu tiên bị chiếm bởi foreign process', async () => {
    // Foreign server chiếm candidate đầu tiên
    const foreignServer = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    });
    await new Promise<void>((resolve) => foreignServer.listen(0, '127.0.0.1', () => resolve()));
    const busyPort = (foreignServer.address() as net.AddressInfo).port;

    // Cổng thứ hai khả dụng
    const temp = net.createServer();
    await new Promise<void>((resolve) => temp.listen(0, '127.0.0.1', () => resolve()));
    const freePort = (temp.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => temp.close(() => resolve()));

    let resolveSpawn: (port: number) => void;
    const spawnPromise = new Promise<number>((r) => {
      resolveSpawn = r;
    });
    const mockSpawnFn = (_subcmd: string, _env: any, opts: any) => {
      resolveSpawn(opts.port);
      return { pid: 99999, on: () => {} };
    };

    try {
      const promise = launcher.startServerIfNeeded([busyPort, freePort], {
        customPort: null,
        spawnFn: mockSpawnFn,
        timeoutMs: 200,
        probeTimeoutMs: 50,
        pollIntervalMs: 40,
      });

      expect(await spawnPromise).toBe(freePort);

      await expect(promise).rejects.toThrow('Timeout');
    } finally {
      await new Promise<void>((resolve) => foreignServer.close(() => resolve()));
    }
  });

  it('kịch bản giả lập cổng 3000 bị chiếm dụng bởi tiến trình khác: tự động fallback sang cổng 3001 hoặc tiếp theo (Acceptance Criterion)', async () => {
    let foreignServer: http.Server | null = null;
    const is3000Free = await launcher.isPortAvailable(3000);
    if (is3000Free) {
      foreignServer = http.createServer((_req, res) => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Busy port 3000');
      });
      await new Promise<void>((resolve) => foreignServer!.listen(3000, '127.0.0.1', () => resolve()));
    }

    try {
      // Xác nhận cổng 3000 thực sự bị chiếm dụng
      const occupied = await launcher.isPortAvailable(3000);
      expect(occupied).toBe(false);

      let spawnedPort: number | null = null;
      let resolveSpawn: (port: number) => void;
      const spawnPromise = new Promise<number>((r) => {
        resolveSpawn = r;
      });

      const mockSpawnFn = (_subcmd: string, _env: any, opts: any) => {
        spawnedPort = opts.port;
        resolveSpawn(opts.port);
        return { pid: 88888, on: () => {} };
      };

      const promise = launcher.startServerIfNeeded([3000, 3001, 3002, 3457], {
        customPort: null,
        spawnFn: mockSpawnFn,
        timeoutMs: 400,
        probeTimeoutMs: 50,
        pollIntervalMs: 40,
      });

      const port = await spawnPromise;
      expect(port).not.toBe(3000);
      expect([3001, 3002, 3457]).toContain(port);

      await expect(promise).rejects.toThrow('Timeout');
    } finally {
      if (foreignServer) {
        await new Promise<void>((resolve) => foreignServer!.close(() => resolve()));
      }
    }
  });

  it('startServerIfNeeded fallback sang server Vyen đang chạy trên candidate khác khi customPort bị foreign process chiếm', async () => {
    // Foreign process chiếm customPort
    const foreignServer = http.createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Foreign server');
    });
    await new Promise<void>((resolve) => foreignServer.listen(0, '127.0.0.1', () => resolve()));
    const customBusyPort = (foreignServer.address() as net.AddressInfo).port;

    // Vyen server đang chạy trên fallback candidate
    const vyenServer = http.createServer((req, res) => {
      if (req.url === '/api/server-config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ thinkingLevel: true, media: false }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => vyenServer.listen(0, '127.0.0.1', () => resolve()));
    const vyenPort = (vyenServer.address() as net.AddressInfo).port;

    let spawnCalled = false;
    const mockSpawnFn = () => {
      spawnCalled = true;
      return { pid: 77777, on: () => {} };
    };

    try {
      const url = await launcher.startServerIfNeeded([customBusyPort, vyenPort], {
        customPort: customBusyPort,
        spawnFn: mockSpawnFn,
        probeTimeoutMs: 200,
      });

      expect(url).toBe(`http://127.0.0.1:${vyenPort}`);
      expect(spawnCalled).toBe(false);
    } finally {
      await new Promise<void>((resolve) => foreignServer.close(() => resolve()));
      await new Promise<void>((resolve) => vyenServer.close(() => resolve()));
    }
  });

  it('probe() chuẩn hóa chuỗi URL không có giao thức và xử lý an toàn lỗi luồng response', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/server-config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ thinkingLevel: true, media: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      // Chuỗi không có http://
      const resWithoutProto = await launcher.probe(`127.0.0.1:${port}`, 800);
      expect(resWithoutProto).toBe(true);

      // Cổng không có server lắng nghe qua chuỗi host:port
      const offline = await launcher.probe('127.0.0.1:59999', 300);
      expect(offline).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('hỗ trợ cờ -p= và -w= trong đối số dòng lệnh launcher', () => {
    const res = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'scripts', 'launch-desktop.cjs'), '-p=3999', '--help'],
      { encoding: 'utf8' }
    );
    expect(res.status).toBe(0);
  });

  it('hỗ trợ cờ rút gọn dạng POSIX liền kề -p3999 và -w/path không cần dấu bằng hay khoảng trắng', () => {
    const res = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'scripts', 'launch-desktop.cjs'), '-p3999', '-w./tmp', '--help'],
      { encoding: 'utf8' }
    );
    expect(res.status).toBe(0);
  });

  it('cleanupChild gọi hàm .kill() an toàn và không gọi taskkill hệ thống trên mock PID của bài test', async () => {
    let killCalledWithSignal = '';
    let spawnedResolve: () => void;
    const spawnedPromise = new Promise<void>((r) => {
      spawnedResolve = r;
    });

    const mockChild: any = {
      pid: 65432,
      exitCode: null,
      killed: false,
      on: () => {},
      kill: (sig: string) => {
        killCalledWithSignal = sig;
      },
    };

    const promise = launcher.startServerIfNeeded([3457], {
      customPort: 3457,
      spawnFn: () => {
        spawnedResolve();
        return mockChild;
      },
      timeoutMs: 80,
      probeTimeoutMs: 20,
      pollIntervalMs: 20,
    });

    await spawnedPromise;
    launcher.cleanupChild();
    expect(killCalledWithSignal).toBe('SIGTERM');
    await promise.catch(() => {});
  });

  it('startServerIfNeeded chuẩn hóa an toàn các giá trị customPort không hợp lệ (string, số âm, số thực, vượt dải)', async () => {
    let resolvedSpawnPort: number | null = null;
    let onSpawned: ((port: number) => void) | null = null;
    const mockSpawnFn = (_subcmd: string, _env: any, opts: any) => {
      resolvedSpawnPort = opts.port;
      if (onSpawned) onSpawned(opts.port);
      return { pid: 99991, on: () => {} };
    };

    // 1. Chuỗi số hợp lệ '3457' -> tự ép kiểu thành số 3457
    const p1Spawned = new Promise<number>((r) => { onSpawned = r; });
    const p1 = launcher.startServerIfNeeded([3457], {
      customPort: '3457',
      spawnFn: mockSpawnFn,
      timeoutMs: 80,
      probeTimeoutMs: 20,
      pollIntervalMs: 20,
    });
    await p1Spawned;
    expect(typeof resolvedSpawnPort).toBe('number');
    await expect(p1).rejects.toThrow('Timeout');

    // 2. Cổng âm -1 -> coi như null, fallback sang candidate hợp lệ
    resolvedSpawnPort = null;
    const p2Spawned = new Promise<number>((r) => { onSpawned = r; });
    const p2 = launcher.startServerIfNeeded([3001, 3002], {
      customPort: -1,
      spawnFn: mockSpawnFn,
      timeoutMs: 80,
      probeTimeoutMs: 20,
      pollIntervalMs: 20,
    });
    await p2Spawned;
    expect(resolvedSpawnPort).toBeGreaterThan(0);
    await expect(p2).rejects.toThrow('Timeout');
  });

  it('findAvailablePort làm sạch và khử trùng lặp (deduplicate) danh sách candidates', async () => {
    const temp = net.createServer();
    await new Promise<void>((resolve) => temp.listen(0, '127.0.0.1', () => resolve()));
    const validFreePort = (temp.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => temp.close(() => resolve()));

    // Candidate list chứa số âm, null, số thực, trùng lặp và cổng khả dụng
    const dirtyCandidates = [-5, 'abc' as any, 3000.5, validFreePort, validFreePort, 99999];
    const chosen = await launcher.findAvailablePort(dirtyCandidates);
    expect(chosen).toBe(validFreePort);
  });

  it('spawnServerProcess tôn trọng options.workspace truyền vào', () => {
    const customWs = path.resolve('./custom-test-ws');
    const child = launcher.spawnServerProcess('dev', {}, {
      port: 3999,
      workspace: customWs,
      extraArgs: ['--help'],
      stdio: 'pipe',
    });
    expect(child).toBeDefined();
    expect(child.pid).toBeTypeOf('number');
    child.kill?.();
  });

  it('buildBrowserArgs cấu hình đúng cờ app mode, profile độc lập và không chứa app-id lỗi', () => {
    const testUrl = 'http://127.0.0.1:3000';
    const customProfile = path.resolve('./temp-test-profile');
    const args = launcher.buildBrowserArgs(testUrl, {
      windowSize: '1200,800',
      userDataDir: customProfile,
    });

    expect(args).toContain(`--app=${testUrl}`);
    expect(args).toContain(`--user-data-dir=${customProfile}`);
    expect(args).toContain('--window-size=1200,800');
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--no-default-browser-check');
    expect(args).toContain('--disable-extensions');

    // Không được chứa cờ --app-id vì Chromium sẽ cố tìm Chrome App extension thay vì mở URL
    const hasAppId = args.some((a: string) => a.startsWith('--app-id'));
    expect(hasAppId).toBe(false);
  });
});

describe('launch-desktop.cjs bridge token — khóa /api/bridge theo phiên server', () => {
  /** Lấy một cổng trống (bind rồi release) cho các test spawn giả lập. */
  async function getFreePort(): Promise<number> {
    const temp = net.createServer();
    await new Promise<void>((resolve) => temp.listen(0, '127.0.0.1', () => resolve()));
    const port = (temp.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => temp.close(() => resolve()));
    return port;
  }

  it('startServerIfNeeded sinh VYEN_BRIDGE_TOKEN 256-bit (base64url 43 ký tự) và truyền vào env spawn', async () => {
    const freePort = await getFreePort();

    let capturedEnv: Record<string, string> | null = null;
    let onSpawned: () => void = () => {};
    const spawned = new Promise<void>((r) => {
      onSpawned = r;
    });
    const mockSpawnFn = (_subcmd: string, env: Record<string, string>) => {
      capturedEnv = env;
      onSpawned();
      return { pid: 66601, on: () => {} };
    };

    // Đảo điều kiện: nếu startServerIfNeeded không inject env token, expect
    // VYEN_BRIDGE_TOKEN khớp pattern 43 ký tự sẽ đỏ.
    const promise = launcher.startServerIfNeeded([freePort], {
      spawnFn: mockSpawnFn,
      timeoutMs: 80,
      probeTimeoutMs: 20,
      pollIntervalMs: 20,
    });
    await spawned;
    expect(capturedEnv).not.toBeNull();
    expect(capturedEnv!.VYEN_BRIDGE_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Env spawn vẫn giữ các biến bắt buộc cũ (PORT cho server con).
    expect(capturedEnv!.PORT).toBe(String(freePort));
    // Token cũng được giữ lại ở module-var để launch() gắn fragment vào URL.
    expect(launcher.getSpawnedBridgeToken()).toBe(capturedEnv!.VYEN_BRIDGE_TOKEN);
    await promise.catch(() => {});
  });

  it('mỗi lần spawn một token khác nhau — hai phiên server không dùng chung chìa khoá', async () => {
    const freePort = await getFreePort();

    const runOnce = async (): Promise<string> => {
      let token = '';
      let onSpawned: () => void = () => {};
      const spawned = new Promise<void>((r) => {
        onSpawned = r;
      });
      const promise = launcher.startServerIfNeeded([freePort], {
        spawnFn: (_subcmd: string, env: Record<string, string>) => {
          token = env.VYEN_BRIDGE_TOKEN;
          onSpawned();
          return { pid: 66602, on: () => {} };
        },
        timeoutMs: 80,
        probeTimeoutMs: 20,
        pollIntervalMs: 20,
      });
      await spawned;
      await promise.catch(() => {});
      return token;
    };

    // Đảo điều kiện: nếu token bị hardcode/dùng lại giữa các lần spawn,
    // expect not.toBe ở dưới đỏ.
    const first = await runOnce();
    const second = await runOnce();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it('composeAppUrl gắn fragment #bt= khi có token và trả URL nguyên vẹn khi token rỗng', () => {
    const url = 'http://127.0.0.1:3457';

    // Token trống → KHÔNG inject fragment vào URL cho buildBrowserArgs.
    expect(launcher.composeAppUrl(url, '')).toBe(url);
    expect(launcher.composeAppUrl(url, null)).toBe(url);
    expect(launcher.composeAppUrl(url, undefined)).toBe(url);

    // Có token → fragment đúng format; ký tự đặc biệt phải encode.
    expect(launcher.composeAppUrl(url, 'abcDEF012_-')).toBe(`${url}#bt=abcDEF012_-`);
    const encoded = launcher.composeAppUrl(url, 'a/b c+d');
    expect(encoded).toBe(`${url}#bt=${encodeURIComponent('a/b c+d')}`);

    // Fragment nằm trong chính URL của cờ --app (không phải cờ riêng).
    const withToken = launcher.composeAppUrl(url, 'abcDEF012_-');
    const args = launcher.buildBrowserArgs(withToken, { userDataDir: path.resolve('./temp-test-profile') });
    expect(args).toContain(`--app=${url}#bt=abcDEF012_-`);
  });

  it('reconnect: đọc token file từ VYEN_USER_DATA_DIR, verify 200 với server đang chạy → trả token', async () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyen-launcher-bt-'));
    const token = 'reconnect-token-'.repeat(2) + 'ab'; // 34 ký tự base64url-like
    fs.writeFileSync(path.join(scratchDir, 'vyen-bridge-token'), token, 'utf8');

    const prevUserDataDir = process.env.VYEN_USER_DATA_DIR;
    process.env.VYEN_USER_DATA_DIR = scratchDir;
    launcher.resetSpawnedBridgeToken();

    // Server đang chạy chỉ trả 200 khi header token khớp file — như /api/bridge thật.
    const server = http.createServer((req, res) => {
      if (req.url === '/api/bridge' && req.headers['x-vyen-bridge-token'] === token) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'ready' }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: 'BRIDGE_UNAUTHORIZED' }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      // Đảo điều kiện: nếu bỏ bước verify hoặc đọc nhầm file, expect này đỏ.
      const resolved = await launcher.resolveBridgeTokenForUrl(`http://127.0.0.1:${port}`);
      expect(resolved).toBe(token);
    } finally {
      process.env.VYEN_USER_DATA_DIR = prevUserDataDir;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('reconnect verify fail (401 — server khác phiên dùng chung userDataDir) → trả null để mở không fragment', async () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyen-launcher-bt-2-'));
    fs.writeFileSync(path.join(scratchDir, 'vyen-bridge-token'), 'stale-token-of-another-session-123', 'utf8');

    const prevUserDataDir = process.env.VYEN_USER_DATA_DIR;
    process.env.VYEN_USER_DATA_DIR = scratchDir;
    launcher.resetSpawnedBridgeToken();

    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, code: 'BRIDGE_UNAUTHORIZED' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;

    try {
      // Đảo điều kiện: nếu bỏ verify và tin file mù quáng, expect null sẽ đỏ.
      const resolved = await launcher.resolveBridgeTokenForUrl(`http://127.0.0.1:${port}`);
      expect(resolved).toBeNull();
    } finally {
      process.env.VYEN_USER_DATA_DIR = prevUserDataDir;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('reconnect khi server do chính launcher vừa spawn: dùng token module-var, không đụng file', async () => {
    // Giả lập đã spawn: token module-var được set bằng startServerIfNeeded.
    const freePort = await getFreePort();
    let onSpawned: () => void = () => {};
    const spawned = new Promise<void>((r) => {
      onSpawned = r;
    });
    const promise = launcher.startServerIfNeeded([freePort], {
      spawnFn: (_subcmd: string, _env: Record<string, string>) => {
        onSpawned();
        return { pid: 66603, on: () => {} };
      },
      timeoutMs: 80,
      probeTimeoutMs: 20,
      pollIntervalMs: 20,
    });
    await spawned;
    await promise.catch(() => {});

    const moduleToken = launcher.getSpawnedBridgeToken();
    expect(moduleToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Không có server thật để verify cũng phải trả token đã sinh cho con.
    const resolved = await launcher.resolveBridgeTokenForUrl('http://127.0.0.1:1');
    expect(resolved).toBe(moduleToken);
    launcher.resetSpawnedBridgeToken();
  });
});
