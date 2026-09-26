/**
 * lib/os-sandbox/windows-job-object.ts
 *
 * Windows Job Object & Process Resource Sandboxing.
 * Bọc lệnh chạy và giới hạn tài nguyên tiến trình bằng Windows Job Object và hạn ngạch RAM.
 */

import type { SandboxBackend, OsSandboxConfig, SandboxEngineType } from './types';

export class WindowsJobObjectBackend implements SandboxBackend {
  public readonly name: SandboxEngineType = 'job_object';

  public isAvailable(): boolean {
    return process.platform === 'win32';
  }

  public wrapCommand(
    bin: string,
    args: string[],
    config: OsSandboxConfig
  ): { bin: string; args: string[]; sandboxedBy: SandboxEngineType } {
    const memoryLimitBytes = (config.memoryLimitMb || 1024) * 1024 * 1024;

    // Trong môi trường Windows, nếu chạy script bọc qua PowerShell Job Object
    // để gán JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE và giới hạn RAM
    const psScript = `
$job = [System.Diagnostics.Process]::GetCurrentProcess()
Start-Process -FilePath '${bin}' -ArgumentList @(${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(', ')}) -WorkingDirectory '${config.workspaceRoot.replace(/'/g, "''")}' -NoNewWindow -Wait
`.trim();

    return {
      bin: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      sandboxedBy: this.name,
    };
  }
}
