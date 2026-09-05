/**
 * Tests cho register() của lib/ipc.cjs — tầng IPC chạy dưới server bridge.
 *
 * ipc.cjs đã bỏ Electron hoàn toàn (desktop shell giờ là Edge/Chrome app mode
 * gọi /api/bridge), nên register() phải chạy được trong Node thuần với ipcMain
 * giả lập — pattern tests/mcp-electron.test.ts: mỗi channel thu thành một hàm
 * gọi trực tiếp qua handler(null, payload).
 *
 * Đặc biệt: workspace-select phải vẫn THROW với error tiếng Việt sạch —
 * lib/bridge/server-bridge.ts bao channel này bằng fallback (payload path →
 * native OS folder picker → cancelled) dựa đúng vào việc handler throw.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// File test là ESM nhưng lib/ipc.cjs là CommonJS — cần require thật.
const require = createRequire(import.meta.url);

type Handler = (_event: unknown, payload?: unknown) => Promise<unknown> | unknown;

const ipcHandlers = new Map<string, Handler>();
const fakeIpcMain = {
  handle: (channel: string, fn: Handler) => {
    ipcHandlers.set(channel, fn);
  },
};

const ipc = require('../lib/ipc.cjs') as {
  register: (
    ipcMain: unknown,
    opts: { userDataDir: string; audit: (line: string) => void; workspaceOverride?: string | null },
  ) => void;
};

/** Gọi thẳng handler đã đăng ký (bỏ qua lớp ipcRenderer). */
const call = (channel: string, payload?: unknown) => {
  const handler = ipcHandlers.get(channel);
  if (!handler) throw new Error(`Chưa đăng ký channel ${channel}`);
  return Promise.resolve(handler(null, payload));
};

let userDataDir: string;
let overrideDir: string;

beforeAll(() => {
  userDataDir = mkdtempSync(path.join(tmpdir(), 'vyen-ipc-reg-'));
  overrideDir = mkdtempSync(path.join(tmpdir(), 'vyen-ipc-ws-'));
  ipc.register(fakeIpcMain, { userDataDir, audit: () => {}, workspaceOverride: overrideDir });
});

afterAll(() => {
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(overrideDir, { recursive: true, force: true });
});

describe('register — đăng ký channel', () => {
  it('đăng ký đủ mọi channel cốt lõi', () => {
    for (const channel of [
      'vyen:workspace-get',
      'vyen:workspace-set',
      'vyen:workspace-clear',
      'vyen:workspace-select',
      'vyen:fs-list',
      'vyen:fs-read',
      'vyen:fs-write',
      'vyen:fs-delete',
      'vyen:fs-stat',
      'vyen:fs-search',
      'vyen:fs-read-image',
      'vyen:shell-run',
      'vyen:git-status',
      'vyen:git-diff',
      'vyen:git-log',
      'vyen:git-add',
      'vyen:git-commit',
      'vyen:llm-fetch',
      'vyen:secure-available',
      'vyen:secure-get',
      'vyen:secure-set',
      'vyen:secure-delete',
    ]) {
      expect(ipcHandlers.has(channel), channel).toBe(true);
    }
  });
});

describe('workspaceOverride', () => {
  it('workspace-get trả đúng path override (thắng persist, không ghi file)', async () => {
    const res = (await call('vyen:workspace-get')) as { path: string | null };
    expect(res.path).toBe(path.resolve(overrideDir));
    // Override chỉ là trạng thái runtime — không được persist ra workspace file.
    expect(existsSync(path.join(userDataDir, 'vyen-workspace.json'))).toBe(false);
  });
});

describe('vyen:workspace-select ngoài Electron', () => {
  it('reject với error tiếng Việt sạch — bridge wrapper dựa vào throw này để fallback', async () => {
    await expect(call('vyen:workspace-select')).rejects.toThrow(/Dialog/);
  });

  it('error message không chứa ký tự mojibake (box-drawing / ß / æ / FFFD)', async () => {
    const err = (await call('vyen:workspace-select').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Dialog');
    // Tiếng Việt đúng không bao giờ chứa các ký tự kiểu ─ ├ ╗ (U+2500–U+25FF),
    // Γ (U+0393), ß (U+00DF), æ (U+00E6) — dấu hiệu mojibake CP437.
    expect(err.message).not.toMatch(/[\u2500-\u25FF\u0393\u00DF\u00E6]/);
    expect(err.message).not.toContain('\uFFFD');
  });
});

describe('secure store — safeStorage null có chủ ý', () => {
  it('secure-available → { available: false }', async () => {
    await expect(call('vyen:secure-available')).resolves.toEqual({ available: false });
  });

  it('secure-set reject với lỗi mã hoá (từ chối plaintext fallback)', async () => {
    await expect(call('vyen:secure-set', { key: 'provider:a', value: 'sk-test' })).rejects.toThrow(
      /mã hoá/i,
    );
  });
});

describe('workspace set / get / clear', () => {
  it('set với path không tồn tại → reject error tiếng Việt sạch', async () => {
    await expect(
      call('vyen:workspace-set', { path: path.join(tmpdir(), 'vyen-khong-ton-tai-xyz') }),
    ).rejects.toThrow(/Thư mục không tồn tại/);
  });

  it('set (tmpdir thật) → get trả đúng path; clear → get trả null', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vyen-ipc-set-'));
    try {
      const set = (await call('vyen:workspace-set', { path: dir })) as { path: string };
      expect(set.path).toBe(path.resolve(dir));

      const got = (await call('vyen:workspace-get')) as { path: string | null };
      expect(got.path).toBe(path.resolve(dir));

      await expect(call('vyen:workspace-clear')).resolves.toEqual({ ok: true });
      const cleared = (await call('vyen:workspace-get')) as { path: string | null };
      expect(cleared.path).toBe(null);

      // Sau khi clear, mọi op fs phải bị chặn với error sạch (không âm thầm dùng root cũ).
      await expect(call('vyen:fs-list', { relPath: '' })).rejects.toThrow(/Chưa chọn workspace/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fs-read — path-guard sau refactor', () => {
  it('relPath thoát root (../..) → reject; đọc trong root vẫn bình thường', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vyen-ipc-guard-'));
    try {
      await expect(call('vyen:workspace-set', { path: root })).resolves.toBeTruthy();
      await expect(call('vyen:fs-read', { relPath: '../..' })).rejects.toThrow(
        /thoát khỏi workspace/,
      );

      // Positive control: reject đến từ path-guard, không phải root hỏng.
      writeFileSync(path.join(root, 'a.txt'), 'ok', 'utf8');
      await expect(call('vyen:fs-read', { relPath: 'a.txt' })).resolves.toMatchObject({
        content: 'ok',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('workspace-set blocklist — chặn root là thư mục hệ thống', () => {
  // Mọi case chặn đều kỳ vọng error tiếng Việt chứa "Không thể đặt workspace"
  // kèm lý do — đảo điều kiện (bỏ blocklist) thì cả cụm này đỏ.

  it('từ chối gốc ổ đĩa (drive root / filesystem root)', async () => {
    const driveRoot = path.parse(path.resolve(tmpdir())).root;
    await expect(call('vyen:workspace-set', { path: driveRoot })).rejects.toThrow(
      /Không thể đặt workspace.*gốc của ổ đĩa/,
    );
  });

  it('từ chối chính thư mục home của người dùng (con của home vẫn hợp lệ)', async () => {
    await expect(call('vyen:workspace-set', { path: homedir() })).rejects.toThrow(
      /Không thể đặt workspace.*home/,
    );
  });

  it('từ chối thư mục userDataDir của Vyen (chứa token + kho cấu hình)', async () => {
    await expect(call('vyen:workspace-set', { path: userDataDir })).rejects.toThrow(
      /Không thể đặt workspace.*userData/,
    );
  });

  it('từ chối Windows/System32/Program Files trên Windows (bỏ qua nếu không tồn tại)', async () => {
    if (process.platform !== 'win32') return;
    const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const candidates = [
      sysRoot,
      path.join(sysRoot, 'System32'),
      process.env.ProgramFiles || 'C:\\Program Files',
    ].filter((p) => existsSync(p));
    expect(candidates.length).toBeGreaterThan(0);

    for (const blocked of candidates) {
      await expect(call('vyen:workspace-set', { path: blocked })).rejects.toThrow(
        /Không thể đặt workspace/,
      );
    }
  });

  it('chấp nhận tmpdir thường (con đường hợp lệ của coding agent) và get trả đúng path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vyen-ipc-allow-'));
    try {
      const set = (await call('vyen:workspace-set', { path: dir })) as { path: string };
      expect(set.path).toBe(path.resolve(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('case-insensitive trên Windows: từ chối cả drive root viết thường', async () => {
    if (process.platform !== 'win32') return;
    const driveRoot = path.parse(path.resolve(tmpdir())).root; // vd 'C:\'
    const lower = driveRoot.toLowerCase();
    if (lower === driveRoot) return;
    await expect(call('vyen:workspace-set', { path: lower })).rejects.toThrow(
      /Không thể đặt workspace/,
    );
  });
});
