/**
 * lib/os-sandbox/macos-seatbelt.ts
 *
 * macOS Seatbelt (sandbox-exec) Sandboxing.
 * Áp dụng profile Scheme an toàn ghim cứng cho shell execution.
 */

import fs from 'node:fs';
import type { SandboxBackend, OsSandboxConfig, SandboxEngineType } from './types';

export class MacosSeatbeltBackend implements SandboxBackend {
  public readonly name: SandboxEngineType = 'seatbelt';

  public isAvailable(): boolean {
    if (process.platform !== 'darwin') return false;
    try {
      return fs.existsSync('/usr/bin/sandbox-exec');
    } catch {
      return false;
    }
  }

  public generateProfile(config: OsSandboxConfig): string {
    const lines = [
      '(version 1)',
      '(deny default)',
      '(allow process-exec)',
      '(allow process-fork)',
      '(allow sysctl-read)',
      `(allow file-read* (subpath "${config.workspaceRoot}"))`,
      `(allow file-write* (subpath "${config.workspaceRoot}"))`,
      '(allow file-read* (subpath "/bin"))',
      '(allow file-read* (subpath "/usr"))',
      '(allow file-read* (subpath "/dev"))',
    ];

    if (!config.allowNetwork) {
      lines.push('(deny network*)');
    }

    return lines.join('\n');
  }

  public wrapCommand(
    bin: string,
    args: string[],
    config: OsSandboxConfig
  ): { bin: string; args: string[]; sandboxedBy: SandboxEngineType } {
    const profile = this.generateProfile(config);
    return {
      bin: '/usr/bin/sandbox-exec',
      args: ['-p', profile, bin, ...args],
      sandboxedBy: this.name,
    };
  }
}
