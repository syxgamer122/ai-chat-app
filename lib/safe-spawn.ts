/**
 * `spawnArgv` — spawn KHÔNG QUA SHELL, binary resolve tuyệt đối (P0.5 S3, B1).
 *
 * ## Vì sao có file này
 *
 * Ba executor nội bộ (sandbox của `lib/teamwork/`, permission broker, CLI serve)
 * từng gọi `spawn(command, { shell: true })`. Với `shell: true`, chuỗi lệnh được
 * trả về cho `/bin/sh -c` (hoặc `cmd.exe /c`) — tức mọi metacharacter, phép
 * nối lệnh, redirect và `$(...)` đều sống lại, đúng thứ shell-policy của agent
 * cấm ở đường chính.
 *
 * Cách sửa ở đây KHÔNG phải "thêm regex chặn" mà là bỏ hẳn tầng shell:
 * 1. `tokenizeCommandLine` cắt chuỗi thành argv (từ chối metacharacter);
 * 2. `resolveBinaryAbsolute` tra binary trong THƯ MỤC HỆ THỐNG, không dùng
 *    PATH kế thừa (residual B1(a));
 * 3. `shell: false` ⇒ không có `/bin/sh -c` nào tồn tại để bị lạm dụng.
 *
 * Hệ quả có chủ đích: lệnh cần shell thật (pipe, `&&`, redirect) sẽ bị từ chối
 * bằng lỗi rõ ràng thay vì âm thầm chạy dưới shell. Executor nào cần pipeline
 * thì phải tự cấu trúc bằng nhiều lần spawn — đó là cách duy nhất giữ được
 * ranh giới "một lệnh = một tiến trình không shell".
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { tokenizeCommandLine, resolveBinaryAbsolute, PolicyError } from './shell-policy.cjs';

export interface ArgvSpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
  detached?: boolean;
  windowsHide?: boolean;
}

export interface ArgvSpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Lỗi có kiểu để caller phân biệt "lệnh bị policy chặn" với lỗi spawn. */
export class ArgvPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgvPolicyError';
  }
}

/**
 * Chống batch argument injection & variable expansion trên Windows khi gọi qua cmd.exe.
 */
export function escapeWindowsBatchArg(arg: string): string {
  if (/[\0\r\n]/.test(arg)) {
    throw new ArgvPolicyError('Tham số chứa ký tự điều khiển không an toàn (null byte hoặc newline).');
  }
  // 1. Chặn biến môi trường mở rộng trong cmd.exe (%VAR% -> %%VAR%%)
  let escaped = arg.replace(/%/g, '%%');
  // 2. Nếu có khoảng trắng hoặc metacharacters, bọc trong dấu ngoặc kép an toàn
  if (/[ \t&|<>()^"]/.test(escaped)) {
    escaped = '"' + escaped.replace(/"/g, '""') + '"';
  }
  return escaped;
}

/**
 * Phân giải trực tiếp file .js thực thi cho các công cụ Node-based (npm, npx, corepack).
 * Khi chạy trên Windows, thay vì chạy qua file wrapper .cmd (dễ bị second-order evaluation do cmd.exe %*),
 * ta gọi trực tiếp Node executable với file .js CLI:
 *   safeSpawn(process.execPath, [npmCliPath, ...args], { shell: false })
 * Triệt tiêu 100% bề mặt tấn công batch script của Windows.
 */
export function resolveNodeCliAbsolute(bin: string): { execPath: string; argsPrefix: string[] } | null {
  const nodeDir = path.dirname(process.execPath);
  const base = path.basename(bin).toLowerCase().replace(/\.(cmd|bat|exe)$/, '');

  if (base === 'npm') {
    const candidate = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(candidate)) {
      return { execPath: process.execPath, argsPrefix: [candidate] };
    }
  } else if (base === 'npx') {
    const candidate = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (fs.existsSync(candidate)) {
      return { execPath: process.execPath, argsPrefix: [candidate] };
    }
  } else if (base === 'corepack') {
    const candidate = path.join(nodeDir, 'node_modules', 'corepack', 'dist', 'corepack.js');
    if (fs.existsSync(candidate)) {
      return { execPath: process.execPath, argsPrefix: [candidate] };
    }
  }
  return null;
}

/**
 * Trên Windows (CVE-2024-27980), các script .cmd/.bat không thể spawn trực tiếp
 * với `shell: false` mà không gây ra lỗi EINVAL trong Node.js.
 * Trước hết, ta kiểm tra xem có thể chạy trực tiếp qua Node executable (Direct Node Bypass) hay không.
 * Nếu không, ta bọc an toàn qua `cmd.exe /d /c <bin> ...args` với `shell: false`,
 * đồng thời escape toàn bộ tham số để chặn Batch Argument Injection.
 */
export function wrapWindowsBatchIfNeeded(bin: string, args: string[]): { bin: string; args: string[] } {
  if (process.platform === 'win32') {
    // 1. Direct Node CLI execution bypass (triệt tiêu cmd.exe và second-order expansion)
    const directNode = resolveNodeCliAbsolute(bin);
    if (directNode) {
      return {
        bin: directNode.execPath,
        args: [...directNode.argsPrefix, ...args],
      };
    }

    const lower = bin.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      const comspec = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe')
        : (process.env.ComSpec || 'cmd.exe');
      const escapedArgs = args.map(escapeWindowsBatchArg);
      return {
        bin: comspec,
        args: ['/d', '/c', bin, ...escapedArgs],
      };
    }
  }
  return { bin, args };
}

/**
 * Chạy `command` (chuỗi) như một tiến trình đơn, không shell.
 *
 * @throws {ArgvPolicyError} khi lệnh rỗng, chứa metacharacter, binary là đường
 * dẫn tùy ý, hoặc không tìm thấy binary trong thư mục hệ thống.
 */
export async function runArgvCommand(
  command: string,
  options: ArgvSpawnOptions,
): Promise<ArgvSpawnResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBuffer = options.maxBufferBytes ?? 1024 * 1024 * 2;

  let tokens: string[];
  try {
    tokens = tokenizeCommandLine(command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ArgvPolicyError(message);
  }
  if (tokens.length === 0) {
    throw new ArgvPolicyError('Lệnh rỗng.');
  }

  const [rawBin, ...args] = tokens;
  let bin = resolveBinaryAbsolute(rawBin);
  if (!bin && process.platform === 'win32') {
    const direct = resolveNodeCliAbsolute(rawBin);
    if (direct) {
      bin = rawBin;
    }
  }
  if (!bin) {
    throw new ArgvPolicyError(
      `Không tìm thấy binary "${rawBin}" trong thư mục hệ thống tin cậy ` +
        `(không dùng PATH kế thừa). Nếu đây là công cụ của workspace, hãy chạy qua package script.`,
    );
  }

  const target = wrapWindowsBatchIfNeeded(bin, args);

  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    shell: false,
    detached: options.detached ?? process.platform !== 'win32',
    env: options.env ?? process.env,
    windowsHide: options.windowsHide ?? true,
  };

  return new Promise<ArgvSpawnResult>((resolve, reject) => {
    const started = Date.now();
    const child = spawn(target.bin, target.args, spawnOptions);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const cap = (current: string, chunk: string): string =>
      current.length >= maxBuffer ? current : (current + chunk).slice(0, maxBuffer);

    child.stdout?.on('data', (d: Buffer | string) => {
      stdout = cap(stdout, d.toString());
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr = cap(stderr, d.toString());
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // process group: kill cả cây (spawn detached ở trên)
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Tiến trình đã kết thúc
        }
      }
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

/** Spawn và trả về handle (cho caller tự quản lý stream/timer) — không shell. */
export function spawnArgv(command: string, options: ArgvSpawnOptions & SpawnOptions) {
  let tokens: string[];
  try {
    tokens = tokenizeCommandLine(command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ArgvPolicyError(message);
  }
  if (tokens.length === 0) throw new ArgvPolicyError('Lệnh rỗng.');

  const [rawBin, ...args] = tokens;
  let bin = resolveBinaryAbsolute(rawBin);
  if (!bin && process.platform === 'win32') {
    const direct = resolveNodeCliAbsolute(rawBin);
    if (direct) {
      bin = rawBin;
    }
  }
  if (!bin) {
    throw new ArgvPolicyError(`Không tìm thấy binary "${rawBin}" trong thư mục hệ thống tin cậy.`);
  }
  const target = wrapWindowsBatchIfNeeded(bin, args);
  return spawn(target.bin, target.args, { ...options, shell: false });
}

export { PolicyError };
