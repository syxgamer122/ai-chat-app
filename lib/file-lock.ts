/**
 * Workspace File Concurrency Lock & Content-Addressed TOCTOU Verification.
 *
 * Implements:
 * 1. Content-addressed approval artifacts: { path, baseHash, patchHash }
 * 2. Concurrency lock: .vyen/.lock on disk (with heartbeat PID & auto-eviction of dead PIDs) / Web Lock API
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ApprovalArtifact {
  path: string;
  baseHash: string;
  patchHash: string;
  createdAt: number;
}

/**
 * Compute canonical SHA-256 hash of a string or buffer.
 */
export function sha256Hex(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Creates a content-addressed approval artifact for a proposed file mutation.
 */
export function createApprovalArtifact(
  relPath: string,
  currentContent: string | null | undefined,
  proposedContent: string,
): ApprovalArtifact {
  const baseHash = currentContent !== null && currentContent !== undefined ? sha256Hex(currentContent) : '';
  const patchHash = sha256Hex(proposedContent);
  return {
    path: relPath,
    baseHash,
    patchHash,
    createdAt: Date.now(),
  };
}

/**
 * Workspace lockfile data stored in .vyen/.lock
 */
interface LockFileData {
  pid: number;
  acquiredAt: number;
  heartbeatAt: number;
}

const LOCK_STALE_TIMEOUT_MS = 30_000; // 30 seconds before considered stale

/**
 * Check if a process with a given PID is alive.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire concurrency lock for the workspace on disk (.vyen/.lock).
 * Automatically evicts stale locks if the holding process died or timed out.
 */
export async function acquireDiskLock(workspaceRoot: string): Promise<() => void> {
  const vyenDir = path.join(workspaceRoot, '.vyen');
  const lockPath = path.join(vyenDir, '.lock');

  try {
    fs.mkdirSync(vyenDir, { recursive: true });
  } catch {}

  const currentPid = process.pid;
  const maxRetries = 10;
  const retryIntervalMs = 100;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Check if existing lock is stale
      if (fs.existsSync(lockPath)) {
        try {
          const raw = fs.readFileSync(lockPath, 'utf8');
          const data = JSON.parse(raw) as LockFileData;
          const isStale =
            Date.now() - data.heartbeatAt > LOCK_STALE_TIMEOUT_MS ||
            !isPidAlive(data.pid);

          if (isStale) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          try { fs.unlinkSync(lockPath); } catch {}
        }
      }

      // Write with wx flag (exclusive creation, fails if file exists)
      const lockData: LockFileData = {
        pid: currentPid,
        acquiredAt: Date.now(),
        heartbeatAt: Date.now(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(lockData), { flag: 'wx' });

      // Start heartbeat
      const heartbeatTimer = setInterval(() => {
        try {
          if (fs.existsSync(lockPath)) {
            lockData.heartbeatAt = Date.now();
            fs.writeFileSync(lockPath, JSON.stringify(lockData));
          }
        } catch {}
      }, 5_000);

      // Release callback
      return () => {
        clearInterval(heartbeatTimer);
        try {
          if (fs.existsSync(lockPath)) {
            const raw = fs.readFileSync(lockPath, 'utf8');
            const data = JSON.parse(raw) as LockFileData;
            if (data.pid === currentPid) {
              fs.unlinkSync(lockPath);
            }
          }
        } catch {}
      };
    } catch {
      await new Promise((res) => setTimeout(res, retryIntervalMs));
    }
  }

  throw new Error('Không thể chiếm lock workspace (.vyen/.lock). Có một tiến trình khác đang thao tác trên workspace.');
}
