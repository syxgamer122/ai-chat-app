import { describe, it, expect } from 'vitest';
import { ArgvPolicyError, runArgvCommand, spawnArgv } from '@/lib/safe-spawn';
import {
  SYSTEM_BIN_DIRS,
  buildSafePath,
  getSafeEnv,
  resolveBinaryAbsolute,
} from '@/lib/shell-policy.cjs';

/**
 * S3 — đóng residual B1: không còn `shell: true` ở executor nội bộ, binary được
 * resolve TUYỆT ĐỐI trong thư mục hệ thống thay vì PATH kế thừa.
 *
 * Các test này là hàng rào chống tái phát: nếu ai đó đặt lại `shell: true` hoặc
 * trả `path` kế thừa vào SAFE_ENV, chúng đỏ ngay.
 */

describe('resolveBinaryAbsolute — không phụ thuộc PATH kế thừa', () => {
  it('trả đường dẫn tuyệt đối cho binary hệ thống', () => {
    if (process.platform === 'win32') return; // chỉ assert trên POSIX
    const resolved = resolveBinaryAbsolute('ls');
    expect(resolved).not.toBeNull();
    expect(resolved!.startsWith('/')).toBe(true);
    expect(resolved).toContain('/');
  });

  it('trả null cho binary không tồn tại — KHÔNG fallback sang PATH', () => {
    expect(resolveBinaryAbsolute('definitely-not-a-real-binary-xyz')).toBeNull();
  });

  it('từ chối đường dẫn tùy ý (tránh thoát khỏi thư mục hệ thống)', () => {
    expect(resolveBinaryAbsolute('../../bin/sh')).toBeNull();
    expect(resolveBinaryAbsolute('/bin/sh')).toBeNull();
    expect(resolveBinaryAbsolute('bin/sh')).toBeNull();
    expect(resolveBinaryAbsolute('')).toBeNull();
  });

  it('chỉ tra trong thư mục hệ thống tin cậy', () => {
    const allowed = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    for (const dir of SYSTEM_BIN_DIRS) {
      if (process.platform === 'win32') {
        expect(dir.toLowerCase()).toContain('windows');
      } else {
        expect(allowed).toContain(dir);
      }
    }
  });
});

describe('buildSafePath / getSafeEnv — PATH không còn kế thừa', () => {
  it('PATH gồm node_modules/.bin của workspace + thư mục hệ thống', () => {
    const p = buildSafePath('/ws/project');
    expect(p).toContain('node_modules');
    expect(p).toContain('.bin');
    for (const dir of SYSTEM_BIN_DIRS) {
      expect(p).toContain(dir);
    }
  });

  it('không chứa thư mục PATH độc hại của người dùng', () => {
    const p = buildSafePath('/ws/project');
    expect(p).not.toContain('/tmp');
    expect(p).not.toContain('.local/bin');
    expect(p).not.toContain('/home/');
  });

  it('getSafeEnv đặt PATH mới, không giữ PATH kế thừa', () => {
    const inherited = process.env.PATH || '';
    const env = getSafeEnv('/ws/project');
    expect(env.PATH).toBeTruthy();
    expect(env.PATH).toBe(buildSafePath('/ws/project'));

    // Nếu PATH của môi trường test có thư mục lạ, nó KHÔNG được truyền xuống.
    for (const dir of inherited.split(':')) {
      if (!dir) continue;
      if (SYSTEM_BIN_DIRS.includes(dir)) continue;
      if (dir.includes('node_modules')) continue;
      expect(env.PATH?.split(':')).not.toContain(dir);
    }
  });

  it('vẫn giữ biến an toàn và LANG, vẫn cắt biến nguy hiểm', () => {
    const env = getSafeEnv('/ws/project');
    expect(env.LANG).toBe('C.UTF-8');
    for (const key of Object.keys(env)) {
      const l = key.toLowerCase();
      expect(l.startsWith('node_')).toBe(false);
      expect(l.startsWith('ld_')).toBe(false);
      expect(l.startsWith('git_')).toBe(false);
      expect(l.startsWith('npm_')).toBe(false);
    }
  });
});

describe('spawnArgv / runArgvCommand — không có shell', () => {
  it('TỪ CHỐI lệnh chứa metacharacter thay vì chạy qua /bin/sh', () => {
    const attacks = [
      'ls && rm -rf /',
      'ls; rm -rf /',
      'cat /etc/passwd | sh',
      'echo $(whoami)',
      'echo `whoami`',
      'ls > /tmp/pwned',
      'ls\nexit 1',
    ];
    for (const attack of attacks) {
      expect(() => spawnArgv(attack, { cwd: process.cwd() })).toThrow(ArgvPolicyError);
    }
  });

  it('TỪ CHỐI binary không tìm thấy trong thư mục hệ thống', async () => {
    await expect(
      runArgvCommand('definitely-not-a-real-binary-xyz --version', { cwd: process.cwd() }),
    ).rejects.toThrow(ArgvPolicyError);
  });

  it('spawnArgv trả ChildProcess với shell tắt và binary tuyệt đối', () => {
    if (process.platform === 'win32') return;
    const child = spawnArgv('ls -la', { cwd: process.cwd() });
    // shell mặc định của spawn là false — assert qua hành vi: không có /bin/sh -c
    expect(child.spawnfile).toBe(resolveBinaryAbsolute('ls'));
    child.kill();
  });

  it('chạy lệnh đọc thật và trả stdout', async () => {
    if (process.platform === 'win32') return;
    const res = await runArgvCommand('cat /etc/hostname', {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(res.code).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(typeof res.stdout).toBe('string');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  }, 15000);

  it('cắt output theo maxBufferBytes', async () => {
    if (process.platform === 'win32') return;
    const res = await runArgvCommand('cat /etc/hostname', {
      cwd: process.cwd(),
      maxBufferBytes: 2,
      timeoutMs: 5000,
    });
    expect(res.stdout.length).toBeLessThanOrEqual(2);
  }, 15000);
});

describe('không còn shell:true trong executor nội bộ (chống tái phát)', () => {
  it('các file executor không DÙNG "shell: true" (bỏ qua comment)', async () => {
    const fs = await import('node:fs');
    const files = [
      'lib/teamwork/sandbox/process-manager.ts',
      'lib/teamwork/permission-broker.ts',
      'lib/cli/cli-surface.ts',
    ];
    for (const f of files) {
      const code = fs
        .readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '') // comment block
        .replace(/^\s*\/\/.*$/gm, ''); // comment dòng
      expect(code.includes('shell: true')).toBe(false);
    }
  });

  it('mọi executor đi qua spawnArgv của safe-spawn', async () => {
    const fs = await import('node:fs');
    const files = [
      'lib/teamwork/sandbox/process-manager.ts',
      'lib/teamwork/permission-broker.ts',
    ];
    for (const f of files) {
      expect(fs.readFileSync(f, 'utf8')).toContain('spawnArgv');
    }
  });
});
