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
  const bin = resolveBinaryAbsolute(rawBin);
  if (!bin) {
    throw new ArgvPolicyError(
      `Không tìm thấy binary "${rawBin}" trong thư mục hệ thống tin cậy ` +
        `(không dùng PATH kế thừa). Nếu đây là công cụ của workspace, hãy chạy qua package script.`,
    );
  }

  const spawnOptions: SpawnOptions = {
    cwd: options.cwd,
    shell: false,
    detached: options.detached ?? process.platform !== 'win32',
    env: options.env ?? process.env,
    windowsHide: options.windowsHide ?? true,
  };

  return new Promise<ArgvSpawnResult>((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin, args, spawnOptions);
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
  const bin = resolveBinaryAbsolute(rawBin);
  if (!bin) {
    throw new ArgvPolicyError(`Không tìm thấy binary "${rawBin}" trong thư mục hệ thống tin cậy.`);
  }
  return spawn(bin, args, { ...options, shell: false });
}

export { PolicyError };
