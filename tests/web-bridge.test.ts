/**
 * Unit & Integration Tests cho Universal Web Bridge & Terminal CLI Harness.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  initServerBridge,
  invokeBridgeChannel,
  isLocalRequest,
  getBridgeUserDataDir,
} from '../lib/bridge/server-bridge';
import { CliCodingHarness } from '../lib/cli/interactive-agent';

describe('Universal Web Bridge (Server Dispatcher)', () => {
  beforeAll(() => {
    initServerBridge();
  });

  it('khởi tạo thành công các kênh IPC cơ bản và MCP', () => {
    const dispatcher = initServerBridge();
    expect(dispatcher.initialized).toBe(true);
    expect(dispatcher.handlers.has('vyen:workspace-get')).toBe(true);
    expect(dispatcher.handlers.has('vyen:fs-list')).toBe(true);
    expect(dispatcher.handlers.has('vyen:shell-run')).toBe(true);
    expect(dispatcher.handlers.has('vyen:git-status')).toBe(true);
    expect(dispatcher.handlers.has('mcp:list-tools')).toBe(true);
  });

  it('getBridgeUserDataDir trả về đường dẫn hợp lệ và tồn tại', () => {
    const dir = getBridgeUserDataDir();
    expect(typeof dir).toBe('string');
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('invokeBridgeChannel vyen:workspace-get trả về workspace hiện tại', async () => {
    const res = (await invokeBridgeChannel('vyen:workspace-get')) as { path: string | null };
    expect(res).toBeDefined();
    expect(typeof res.path).toBe('string');
    expect(res.path).toContain('ai-chat-app');
  });

  it('invokeBridgeChannel vyen:fs-list trả về danh sách file', async () => {
    const list = (await invokeBridgeChannel('vyen:fs-list', { relPath: '' })) as Array<{ name: string }>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((item) => item.name === 'package.json')).toBe(true);
  });

  it('invokeBridgeChannel vyen:shell-run thực thi lệnh shell an toàn', async () => {
    const res = (await invokeBridgeChannel('vyen:shell-run', {
      command: 'echo vyen-bridge-ok',
    })) as { code: number; stdout: string; durationMs: number };

    expect(res.code).toBe(0);
    expect(res.stdout).toContain('vyen-bridge-ok');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('chặn path traversal ra ngoài workspace khi dùng bridge', async () => {
    await expect(
      invokeBridgeChannel('vyen:fs-read', { relPath: '../outside-escape.txt' }),
    ).rejects.toThrow();
  });

  it('báo lỗi khi gọi channel không tồn tại', async () => {
    await expect(
      invokeBridgeChannel('vyen:invalid-channel-xyz'),
    ).rejects.toThrow(/không được hỗ trợ/i);
  });

  it('isLocalRequest xác thực chính xác origin an toàn', () => {
    const localReq = new Request('http://localhost:3000/api/bridge', {
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
      },
    });
    expect(isLocalRequest(localReq)).toBe(true);

    const ipReq = new Request('http://127.0.0.1:3000/api/bridge', {
      headers: {
        host: '127.0.0.1:3000',
      },
    });
    expect(isLocalRequest(ipReq)).toBe(true);

    const remoteReq = new Request('http://evil.com/api/bridge', {
      headers: {
        host: 'evil.com',
        origin: 'https://evil.com',
      },
    });
    expect(isLocalRequest(remoteReq)).toBe(false);
  });

  it('chặn tuyệt đối tấn công giả mạo domain chứa chữ localhost hoặc 127.0.0.1', () => {
    // 1. Tấn công giả mạo origin: attacker-localhost.com
    const spoofedReq1 = new Request('http://localhost:3000/api/bridge', {
      headers: {
        host: 'localhost:3000',
        origin: 'http://attacker-localhost.com',
      },
    });
    expect(isLocalRequest(spoofedReq1)).toBe(false);

    // 2. Tấn công sub-domain: localhost.evil.com
    const spoofedReq2 = new Request('http://localhost:3000/api/bridge', {
      headers: {
        host: 'localhost:3000',
        origin: 'https://localhost.evil.com',
      },
    });
    expect(isLocalRequest(spoofedReq2)).toBe(false);

    // 3. Tấn công tham số: evil.com/?q=localhost
    const spoofedReq3 = new Request('http://localhost:3000/api/bridge', {
      headers: {
        host: 'localhost:3000',
        referer: 'https://evil.com/?q=localhost',
      },
    });
    expect(isLocalRequest(spoofedReq3)).toBe(false);

    // 4. Chặn browser cross-site metadata
    const crossSiteReq = new Request('http://localhost:3000/api/bridge', {
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(isLocalRequest(crossSiteReq)).toBe(false);
  });

  it('vyen:workspace-select với payload path cập nhật đúng workspace', async () => {
    const currentWd = process.cwd();
    const res = (await invokeBridgeChannel('vyen:workspace-select', { path: currentWd })) as { path: string };
    expect(res.path).toBe(path.resolve(currentWd));
  });
});

describe('CliCodingHarness (Pi-style Primitives)', () => {
  const harness = new CliCodingHarness(process.cwd());

  it('lấy đúng workspace root', () => {
    expect(harness.getWorkspace()).toBe(path.resolve(process.cwd()));
  });

  it('read đọc chính xác file trong workspace', () => {
    const res = harness.read('package.json', 1, 10);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('vyen');
  });

  it('read báo lỗi nếu file không tồn tại', () => {
    const res = harness.read('file-chua-tung-ton-tai-xyz.txt');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('không tồn tại');
  });

  it('bash thực thi lệnh và trả về output', () => {
    const res = harness.bash('echo hello-pi-cli');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('hello-pi-cli');
  });

  it('write và edit cập nhật file đúng quy trình', () => {
    const testFile = 'tmp-test-cli-file.txt';
    const writeRes = harness.write(testFile, 'line1\nline2\nline3');
    expect(writeRes.ok).toBe(true);

    const editRes = harness.edit(testFile, 'line2', 'line2-modified');
    expect(editRes.ok).toBe(true);

    const readRes = harness.read(testFile);
    expect(readRes.output).toContain('line2-modified');

    // Dọn dẹp
    fs.unlinkSync(path.join(process.cwd(), testFile));
  });

  it('edit xử lý trơn tru line-endings CRLF (Windows) khi target dùng LF', () => {
    const testFile = 'tmp-test-crlf-file.txt';
    // Ghi file với ký tự xuống dòng CRLF chuẩn Windows
    fs.writeFileSync(path.join(process.cwd(), testFile), 'first line\r\nsecond line\r\nthird line\r\n', 'utf8');

    // Gọi edit với target dùng LF thuần
    const editRes = harness.edit(testFile, 'first line\nsecond line', 'first line modified\nsecond line modified');
    expect(editRes.ok).toBe(true);

    const content = fs.readFileSync(path.join(process.cwd(), testFile), 'utf8');
    expect(content).toContain('first line modified');

    // Dọn dẹp
    fs.unlinkSync(path.join(process.cwd(), testFile));
  });

  it('find tìm kiếm đúng các file trong workspace', () => {
    const res = harness.find('package.json');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('package.json');
  });

  it('grep tìm kiếm nội dung trong mã nguồn', () => {
    const res = harness.grep('CliCodingHarness');
    expect(res.ok).toBe(true);
    expect(res.output).toContain('interactive-agent.ts');
  }, 15_000);

  it('doctor trả về thông số môi trường đầy đủ', () => {
    const res = harness.doctor();
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Node.js');
    expect(res.output).toContain('Workspace');
    expect(res.output).toContain('Status:       READY');
  });

  it('gitStatus trả về kết quả không lỗi', () => {
    const res = harness.gitStatus();
    expect(res.ok).toBe(true);
  });

  it('invokeBridgeChannel vyen:doctor trả về thông số chuẩn', async () => {
    const doc = (await invokeBridgeChannel('vyen:doctor')) as {
      ok: boolean;
      nodeVersion: string;
      platform: string;
      workspaceRoot: string;
      registeredChannels: string[];
    };
    expect(doc.ok).toBe(true);
    expect(doc.nodeVersion).toBe(process.version);
    expect(doc.registeredChannels).toContain('vyen:doctor');
    expect(doc.registeredChannels).toContain('vyen:teamwork-artifacts');
  });

  it('invokeBridgeChannel vyen:teamwork-artifacts trả về cấu trúc artifacts', async () => {
    const res = (await invokeBridgeChannel('vyen:teamwork-artifacts')) as {
      ok: boolean;
      workspaceRoot: string;
      request: { exists: boolean };
      plan: { exists: boolean };
      progress: { exists: boolean };
    };
    expect(res.ok).toBe(true);
    expect(typeof res.workspaceRoot).toBe('string');
    expect(typeof res.request.exists).toBe('boolean');
    expect(typeof res.plan.exists).toBe('boolean');
    expect(typeof res.progress.exists).toBe('boolean');
  });

  it('invokeBridgeChannel vyen:security-audit trả về báo cáo kiểm toán an ninh MonkeyCode', async () => {
    const res = (await invokeBridgeChannel('vyen:security-audit')) as {
      ok: boolean;
      report: string;
      workspaceRoot: string;
    };
    expect(res).toBeDefined();
    expect(typeof res.workspaceRoot).toBe('string');
    expect(res.report).toContain('Vyen Security & Code Audit');
    expect(res.report).toContain('Security Score');
  });

  it('read với lineCount <= 0 được clamp an toàn và không gây lỗi slice âm', () => {
    const res = harness.read('package.json', 1, -5);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Lines 1-1 of');
  });

  it('audit thực hiện kiểm toán bảo mật và phát hiện cấu hình an toàn', () => {
    const res = harness.audit();
    expect(res.output).toContain('Vyen Security & Code Audit');
    expect(res.output).toContain('Checked Files');
  });

  it('init kiểm tra và báo cáo không gian làm việc chuẩn Claude Code', () => {
    const res = harness.init();
    expect(res.ok).toBe(true);
    expect(res.output).toContain('PROJECT.md');
  });

  it('compact báo cáo thông số bộ nhớ context', () => {
    const res = harness.compact();
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Compaction: READY');
  });

  it('scripts/launch-desktop.cjs hỗ trợ cờ --help và thoát 0', () => {
    const { spawnSync } = require('node:child_process');
    const res = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'launch-desktop.cjs'), '--help'], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Vyen Fast Desktop Launcher');
    expect(res.stdout).toContain('--port');
  });

  it('vyen CLI subcommands hoạt động chuẩn xác', () => {
    const { spawnSync } = require('node:child_process');
    const binPath = path.join(process.cwd(), 'bin', 'vyen.ts');

    // 1. --version
    const vRes = spawnSync(process.execPath, ['-r', 'tsx', binPath, '--version'], { encoding: 'utf8' });
    expect(vRes.status).toBe(0);
    expect(vRes.stdout).toContain('vyen v');

    // 2. status
    const sRes = spawnSync(process.execPath, ['-r', 'tsx', binPath, 'status'], { encoding: 'utf8' });
    expect(sRes.status).toBe(0);

    // 3. diff
    const dRes = spawnSync(process.execPath, ['-r', 'tsx', binPath, 'diff'], { encoding: 'utf8' });
    expect(dRes.status).toBe(0);

    // 4. read
    const rRes = spawnSync(process.execPath, ['-r', 'tsx', binPath, 'read', 'package.json', '1', '5'], { encoding: 'utf8' });
    expect(rRes.status).toBe(0);
    expect(rRes.stdout).toContain('name');

    // 5. audit
    const aRes = spawnSync(process.execPath, ['-r', 'tsx', binPath, 'audit'], { encoding: 'utf8' });
    expect(aRes.status).toBe(0);
    expect(aRes.stdout).toContain('Vyen Security & Code Audit');

    // 5b. audit --json
    const aJsonRes = spawnSync(process.execPath, ['-r', 'tsx', binPath, 'audit', '--json'], { encoding: 'utf8' });
    expect(aJsonRes.status).toBe(0);
    const parsedReport = JSON.parse(aJsonRes.stdout);
    expect(parsedReport.score).toBeDefined();
    expect(parsedReport.summary).toBeDefined();

    // 6. init
    const iRes = spawnSync(process.execPath, ['-r', 'tsx', binPath, 'init'], { encoding: 'utf8' });
    expect(iRes.status).toBe(0);
    expect(iRes.stdout).toContain('PROJECT.md');

    // 7. cli autonomous prompt execution (simulated mode)
    const cRes = spawnSync(process.execPath, ['-r', 'tsx', binPath, 'cli', 'đọc file package.json'], {
      encoding: 'utf8',
      env: { ...process.env, VYEN_MOCK_AGENT: '1' },
    });
    expect(cRes.status).toBe(0);
    expect(cRes.stdout).toContain('read_file');
  }, 40_000);
});



