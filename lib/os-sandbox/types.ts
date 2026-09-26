/**
 * lib/os-sandbox/types.ts
 *
 * Định nghĩa các kiểu dữ liệu và hợp đồng giao diện cho OS-Level Isolation Sandbox.
 */

export interface OsSandboxConfig {
  workspaceRoot: string;
  allowNetwork?: boolean;
  memoryLimitMb?: number;
  timeoutMs?: number;
  readOnlyPaths?: string[];
  writablePaths?: string[];
}

export type SandboxEngineType = 'bwrap' | 'job_object' | 'seatbelt' | 'app_jail';

export interface OsSandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxedBy: SandboxEngineType;
}

export interface SandboxBackend {
  readonly name: SandboxEngineType;
  isAvailable(): boolean;
  wrapCommand(
    bin: string,
    args: string[],
    config: OsSandboxConfig
  ): { bin: string; args: string[]; sandboxedBy: SandboxEngineType };
}
