/**
 * lib/os-sandbox/linux-bubblewrap.ts
 *
 * Linux Bubblewrap (bwrap) User Namespace Sandboxing.
 * Bọc lệnh chạy trong unprivileged user namespace, cách ly filesystem và network.
 */

import fs from 'node:fs';
import type { SandboxBackend, OsSandboxConfig, SandboxEngineType } from './types';

export class LinuxBubblewrapBackend implements SandboxBackend {
  public readonly name: SandboxEngineType = 'bwrap';

  public isAvailable(): boolean {
    if (process.platform !== 'linux') return false;
    try {
      return fs.existsSync('/usr/bin/bwrap') || fs.existsSync('/bin/bwrap');
    } catch {
      return false;
    }
  }

  public wrapCommand(
    bin: string,
    args: string[],
    config: OsSandboxConfig
  ): { bin: string; args: string[]; sandboxedBy: SandboxEngineType } {
    const bwrapArgs: string[] = [
      '--ro-bind', '/', '/',
      '--bind', config.workspaceRoot, config.workspaceRoot,
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--unshare-all',
      '--die-with-parent',
    ];

    if (!config.allowNetwork) {
      bwrapArgs.push('--unshare-net');
    }

    if (config.writablePaths) {
      for (const p of config.writablePaths) {
        bwrapArgs.push('--bind', p, p);
      }
    }

    bwrapArgs.push('--', bin, ...args);

    return {
      bin: 'bwrap',
      args: bwrapArgs,
      sandboxedBy: this.name,
    };
  }
}
