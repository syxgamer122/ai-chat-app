/**
 * Types and interfaces for Process Sandboxing & Isolation (Arcbox Model).
 */

export interface ScrubConfig {
  denylistPatterns?: RegExp[];
  allowlistKeys?: string[];
  maskingMode?: 'strip' | 'mask';
  customEnv?: Record<string, string>;
}

export interface SandboxedProcessOptions {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  scrubConfig?: ScrubConfig;
  envWhiteList?: string[];
  scrubSensitiveEnv?: boolean;
  isolatedTempDir?: boolean;
  isolatedTemp?: boolean;
  workerId?: string;
  env?: Record<string, string>;
}

/** Alias for SandboxedProcessOptions */
export type SandboxedExecutionOptions = SandboxedProcessOptions;

export interface SandboxedExecutionResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  tempDirectory?: string;
}
