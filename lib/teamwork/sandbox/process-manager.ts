/**
 * Sandboxed Process Supervisor.
 * Manages child process execution with CWD lockdown, environment scrubbing,
 * isolated temp directory redirection, execution deadlines, and clean recursive process tree teardown.
 */

import child_process from 'node:child_process';
import { CwdGuard } from './cwd-lockdown';
import { EnvScrubber } from './env-scrubber';
import { TempIsolationManager } from './temp-isolation';
import { SandboxedExecutionOptions, SandboxedExecutionResult } from './types';
import { spawnArgv } from '@/lib/safe-spawn';

export class SandboxedProcessManager {
  /**
   * Recursively terminates a process and all its child subprocesses across Windows and POSIX.
   */
  public static killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGKILL'): void {
    if (!pid || pid <= 0) return;

    if (process.platform === 'win32') {
      try {
        child_process.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Process already dead
        }
      }
    } else {
      try {
        // Negative PID targets the entire process group.
        // Dùng đúng `signal` được yêu cầu (trước đây hardcode SIGKILL nên caller
        // xin SIGTERM để tắt êm không bao giờ nhận được). Mặc định vẫn là SIGKILL.
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Process already dead
        }
      }
    }
  }

  /**
   * Spawns a shell process inside an isolated, scrubbed, and guarded sandbox.
   */
  public static async executeSandboxed(
    workspaceRoot: string,
    options: SandboxedExecutionOptions
  ): Promise<SandboxedExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 30000;
    const maxBuffer = options.maxBufferBytes ?? 1024 * 1024 * 2; // 2MB default

    // 1. CWD Lockdown
    const execCwd = CwdGuard.assertWithinLockdown(workspaceRoot, options.cwd);

    // 2. Disposable Temp Directory Isolation
    let tempDir: string | undefined;
    if (options.isolatedTemp || options.isolatedTempDir) {
      tempDir = await TempIsolationManager.createScopedTempDir(workspaceRoot, options.workerId);
    }

    // 3. Environment Variable Scrubbing
    let effectiveEnv: Record<string, string>;
    const shouldScrub = options.scrubSensitiveEnv !== false;

    if (shouldScrub) {
      effectiveEnv = EnvScrubber.scrub(process.env, {
        ...options.scrubConfig,
        allowlistKeys: options.envWhiteList ?? options.scrubConfig?.allowlistKeys,
        customEnv: {
          ...(tempDir ? { TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir } : {}),
          ...options.env,
          ...options.scrubConfig?.customEnv,
        },
      });
    } else {
      effectiveEnv = {
        ...(process.env as Record<string, string>),
        ...(tempDir ? { TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir } : {}),
        ...options.env,
      };
    }

    // 4. Spawn Subprocess with Process Group Isolation — KHÔNG QUA SHELL (S3).
    // `spawnArgv` cắt chuỗi thành argv + resolve binary tuyệt đối trong thư mục
    // hệ thống, rồi spawn với `shell: false`. Lệnh cần metacharacter bị từ chối
    // rõ ràng thay vì chạy dưới `/bin/sh -c`.
    const isWin = process.platform === 'win32';
    let child: child_process.ChildProcess;
    try {
      child = spawnArgv(options.command, {
        cwd: execCwd,
        detached: !isWin,
        env: effectiveEnv as NodeJS.ProcessEnv,
        windowsHide: true,
      });
    } catch (err) {
      // Policy/spawn failure: trả về kết quả lỗi có cấu trúc, không throw ra ngoài
      // (hợp đồng của hàm là luôn resolve SandboxedExecutionResult).
      if (tempDir) await TempIsolationManager.cleanupTempDir(tempDir);
      const message = err instanceof Error ? err.message : String(err);
      return {
        code: 126,
        stdout: '',
        stderr: `[EXEC POLICY] ${message}`,
        durationMs: Date.now() - startTime,
        timedOut: false,
        tempDirectory: tempDir,
      };
    }

    return new Promise<SandboxedExecutionResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      // Timeout watchdog
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          SandboxedProcessManager.killProcessTree(child.pid, 'SIGKILL');
        }
      }, timeoutMs);

      // Cắt SAU khi nối: kiểm tra `length < maxBuffer` trước khi nối vẫn để lọt
      // một chunk lớn vượt trần (buffer chỉ bị chặn ở lần ghi kế tiếp).
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = (stdout + chunk.toString()).slice(0, maxBuffer);
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(0, maxBuffer);
      });

      const finalize = async (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        // Always clean up isolated temporary directory
        if (tempDir) {
          await TempIsolationManager.cleanupTempDir(tempDir);
        }

        resolve({
          code: timedOut ? 124 : code,
          stdout: stdout.trim(),
          stderr: timedOut
            ? `${stderr}\nExecution timed out after ${timeoutMs}ms.`.trim()
            : stderr.trim(),
          durationMs: Date.now() - startTime,
          timedOut,
          tempDirectory: tempDir,
        });
      };

      child.on('error', (err: Error) => {
        stderr += `\n${err.message}`;
        finalize(1);
      });

      child.on('close', (code: number | null) => {
        finalize(code);
      });
    });
  }
}
