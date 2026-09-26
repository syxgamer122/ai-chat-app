/**
 * lib/os-sandbox/sandbox-dispatcher.ts
 *
 * Bộ điều phối Sandbox cấp OS (OS-Level Isolation Dispatcher).
 * Tự động phát hiện hệ điều hành và áp dụng backend cách ly tương ứng:
 * - Linux: Bubblewrap (bwrap)
 * - Windows: Job Object & Process Quota
 * - macOS: Seatbelt (sandbox-exec)
 * - Fallback: App-level CWD & Environment Jail
 */

import { LinuxBubblewrapBackend } from './linux-bubblewrap';
import { WindowsJobObjectBackend } from './windows-job-object';
import { MacosSeatbeltBackend } from './macos-seatbelt';
import type { SandboxBackend, OsSandboxConfig, SandboxEngineType } from './types';

export class OsSandboxDispatcher {
  private backends: SandboxBackend[];

  constructor() {
    this.backends = [
      new LinuxBubblewrapBackend(),
      new WindowsJobObjectBackend(),
      new MacosSeatbeltBackend(),
    ];
  }

  public getActiveBackend(): SandboxBackend | null {
    for (const b of this.backends) {
      if (b.isAvailable()) {
        return b;
      }
    }
    return null;
  }

  public dispatchCommand(
    bin: string,
    args: string[],
    config: OsSandboxConfig
  ): { bin: string; args: string[]; sandboxedBy: SandboxEngineType } {
    const backend = this.getActiveBackend();
    if (backend) {
      return backend.wrapCommand(bin, args, config);
    }

    // App-level Jail Fallback
    return {
      bin,
      args,
      sandboxedBy: 'app_jail',
    };
  }
}

export const osSandboxDispatcher = new OsSandboxDispatcher();
