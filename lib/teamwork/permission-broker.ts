/**
 * Capability-Based Permission Broker & Process Tree Supervisor for Teamwork Harness.
 * Reverse-engineered and adapted from milind-soni/OpenMausBot's local broker architecture.
 *
 * Core capabilities:
 * 1. Granular Capability Scopes: Grants per-worker read/write file globs and command patterns.
 * 2. Pre-execution Interception: Blocks unauthorized file writes or dangerous shell executions.
 * 3. Dynamic Approval Requests: Prompts for interactive confirmation when actions exceed assigned scope.
 * 4. Comprehensive Audit Trail: Logs all security decisions with timestamps and rationale.
 * 5. Process Tree Supervisor: Cross-platform recursive tree killing (`taskkill /T /F` on Windows,
 *    process group SIGKILL on POSIX) to guarantee zero orphan zombie processes.
 */

import child_process from 'node:child_process';
import path from 'node:path';
import {
  AgentCapabilityScope,
  PermissionAuditLog,
  PermissionCheckResult,
} from './types';

export interface ApprovalRequest {
  workerId: string;
  type: 'fs_write' | 'shell_exec';
  target: string;
  scope?: AgentCapabilityScope;
}

export interface PermissionBrokerOptions {
  workspaceRoot: string;
  strictMode?: boolean; // If true, non-declared scopes are denied immediately
  defaultWriteGlobs?: string[];
  defaultReadGlobs?: string[];
  onApprovalRequest?: (request: ApprovalRequest) => Promise<boolean>;
}

export interface ManagedSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
}

/**
 * Chữ ký lệnh phá hoại — LUÔN bị chặn, bất kể scope của worker.
 *
 * Lưu ý: `format` PHẢI đi kèm ổ đĩa (`format c:`). Để trần `"format"` sẽ chặn oan
 * `npm run format`, `git format-patch`, `npx prettier`… vì phép so khớp cũ dùng
 * `String.includes` trên toàn bộ câu lệnh.
 */
export const GLOBAL_BLOCKED_COMMANDS: readonly string[] = [
  'rm -rf /',
  'mkfs',
  'shutdown',
  'format c:',
  ':(){ :|:& };:',
];

/**
 * So khớp một lệnh với chữ ký bị chặn.
 * - Chữ ký nhiều token (có khoảng trắng / ký tự shell) → so khớp substring.
 * - Chữ ký một token (`mkfs`, `shutdown`) → yêu cầu ranh giới từ, để
 *   `npm run format` không bị chặn oan trong khi `mkfs.ext4` vẫn bị.
 */
function matchesBlockedCommand(command: string, pattern: string): boolean {
  const cmd = command.toLowerCase();
  const pat = pattern.trim().toLowerCase();
  if (!pat) return false;
  if (/[\s(]/.test(pat)) return cmd.includes(pat);

  const escaped = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s;&|(])${escaped}([\\s.;&|)]|$)`).test(cmd);
}

/**
 * Checks if a relative path matches a simple glob pattern (supports `*`, `**`, file prefixes).
 */
export function matchesGlob(relPath: string, globPattern: string): boolean {
  const normPath = relPath.replace(/\\/g, '/');
  const normGlob = globPattern.replace(/\\/g, '/');

  if (normGlob === '**' || normGlob === '**/*') return true;
  if (normGlob === normPath) return true;

  // Prefix wildcard: e.g. "lib/**" matches "lib/teamwork/engine.ts"
  if (normGlob.endsWith('/**')) {
    const dir = normGlob.slice(0, -3);
    return normPath === dir || normPath.startsWith(`${dir}/`);
  }

  // Extension wildcard & recursive globs: e.g. "*.ts", "tests/*.test.ts", "lib/**/*.ts"
  // `**/` phải khớp ZERO hoặc nhiều segment: "**/*.ts" phải khớp cả "file.ts"
  // (bản cũ biên dịch `**` thành `.*` rồi giữ nguyên dấu `/`, nên đòi ít nhất
  // một thư mục và trượt "file.ts").
  // Marker placeholder giữ chỗ cho `**/` qua các bước `*` → vì `*` đơn giản
  // cũng ăn luôn `**` nếu chưa tách riêng.
  // `?` → `.` PHẢI chạy TRƯỚC khi marker được thay bằng `(?:.*/)?`:replacement
  // chứa ký tự `?`, chạy sau sẽ đổi `?` của chính nó thành `.` và vỡ regex
  // (lỗi thật đã xảy ra: `(?:.*/)?` thành `(.:.*/).` nên mọi glob có `**/`
  // đều không khớp).
  const regexStr = normGlob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars except * and ?
    .replace(/\?/g, '.') // glob wildcard `?` — chạy trước khi chèn chuỗi chứa `?`
    .replace(/\*\*\//g, '__VYEN_GLOB_DOUBLESTAR__')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/__VYEN_GLOB_DOUBLESTAR__/g, '(?:.*/)?');

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(normPath);
}

export class PermissionBroker {
  public readonly workspaceRoot: string;
  public readonly strictMode: boolean;
  private readonly scopes = new Map<string, AgentCapabilityScope>();
  private readonly auditLogs: PermissionAuditLog[] = [];
  private readonly onApprovalRequest?: (request: ApprovalRequest) => Promise<boolean>;
  private readonly defaultWriteGlobs?: string[];
  private readonly defaultReadGlobs?: string[];

  constructor(options: PermissionBrokerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.strictMode = options.strictMode ?? false;
    this.onApprovalRequest = options.onApprovalRequest;
    this.defaultWriteGlobs = options.defaultWriteGlobs;
    this.defaultReadGlobs = options.defaultReadGlobs;
  }

  /**
   * Registers or updates a capability scope for a specific agent or worker.
   * `defaultWriteGlobs` / `defaultReadGlobs` từ constructor được áp làm giá trị
   * nền cho scope mới (trước đây 2 option này bị bỏ qua hoàn toàn).
   */
  public registerScope(scope: AgentCapabilityScope): void {
    this.scopes.set(scope.workerId, {
      allowedReadGlobs: this.defaultReadGlobs ?? ['**/*'],
      allowedWriteGlobs: this.defaultWriteGlobs ?? [],
      allowedCommands: [],
      blockedCommands: [...GLOBAL_BLOCKED_COMMANDS],
      allowNetwork: false,
      maxExecutionTimeMs: 60000,
      ...scope,
    });
  }

  /**
   * Chuẩn hoá target thành đường dẫn tương đối trong workspace, đã resolve `..`.
   * Trả null nếu đường dẫn thoát ra ngoài workspaceRoot.
   */
  private resolveWithinWorkspace(targetPath: string): string | null {
    const absTarget = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.workspaceRoot, targetPath);
    const rel = path.relative(this.workspaceRoot, absTarget).replace(/\\/g, '/');

    // So với dấu phân cách thật: đường dẫn như "lib/../../etc/passwd" KHÔNG bắt
    // đầu bằng ".." nên lọt qua kiểm tra tiền tố cũ rồi khớp glob "lib/**".
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
      return null;
    }
    return rel;
  }

  /**
   * Retrieves registered scope for a worker.
   */
  public getScope(workerId: string): AgentCapabilityScope | undefined {
    return this.scopes.get(workerId);
  }

  /**
   * Returns copy of all permission audit logs.
   */
  public getAuditLogs(): PermissionAuditLog[] {
    return [...this.auditLogs];
  }

  private log(
    workerId: string,
    action: PermissionAuditLog['action'],
    target: string,
    decision: 'allow' | 'deny',
    reason?: string
  ): void {
    this.auditLogs.push({
      timestamp: Date.now(),
      workerId,
      action,
      target,
      decision,
      reason,
    });
  }

  /**
   * Checks whether a worker is authorized to write or edit a specific file.
   */
  public async checkWritePermission(workerId: string, targetPath: string): Promise<PermissionCheckResult> {
    // Canonicalize TRƯỚC khi kiểm tra biên và so glob: nếu không, đường dẫn
    // traversal nhúng ("lib/../../etc/passwd") sẽ lọt qua và khớp glob "lib/**".
    const relPath = this.resolveWithinWorkspace(targetPath);

    if (relPath === null) {
      const shown = targetPath.replace(/\\/g, '/');
      this.log(workerId, 'fs_write', shown, 'deny', 'Path escapes workspaceRoot boundary');
      return {
        granted: false,
        reason: `Access Denied: Path "${shown}" escapes workspaceRoot boundary.`,
        violatingTarget: shown,
      };
    }

    const scope = this.scopes.get(workerId);
    if (!scope) {
      if (this.strictMode) {
        this.log(workerId, 'fs_write', relPath, 'deny', 'No registered scope for worker');
        return {
          granted: false,
          reason: `Access Denied: Worker "${workerId}" has no granted capability scope.`,
          violatingTarget: relPath,
        };
      }
      this.log(workerId, 'fs_write', relPath, 'allow', 'Permitted by permissive default');
      return { granted: true };
    }

    // Check allowedWriteGlobs
    const allowed = (scope.allowedWriteGlobs || []).some((pattern) => matchesGlob(relPath, pattern));

    if (allowed) {
      this.log(workerId, 'fs_write', relPath, 'allow', 'Matched allowedWriteGlobs');
      return { granted: true };
    }

    // If not directly allowed, check if approval callback grants access
    if (this.onApprovalRequest) {
      const approved = await this.onApprovalRequest({
        workerId,
        type: 'fs_write',
        target: relPath,
        scope,
      });

      if (approved) {
        this.log(workerId, 'fs_write', relPath, 'allow', 'Explicitly approved by user');
        return { granted: true };
      }
    }

    this.log(workerId, 'fs_write', relPath, 'deny', 'Outside assigned allowedWriteGlobs');
    return {
      granted: false,
      reason: `Access Denied: File "${relPath}" is outside worker "${workerId}" assigned write scope [${(scope.allowedWriteGlobs || []).join(', ')}].`,
      violatingTarget: relPath,
    };
  }

  /**
   * Checks whether a worker is authorized to READ a specific file.
   *
   * Trước đây `allowedReadGlobs` được khai báo trong scope nhưng KHÔNG có đường
   * đọc nào kiểm tra — quyền đọc thực tế không bị giới hạn. Phương thức này làm
   * cho capability đó có hiệu lực thật.
   */
  public async checkReadPermission(workerId: string, targetPath: string): Promise<PermissionCheckResult> {
    const relPath = this.resolveWithinWorkspace(targetPath);

    if (relPath === null) {
      const shown = targetPath.replace(/\\/g, '/');
      this.log(workerId, 'fs_read', shown, 'deny', 'Path escapes workspaceRoot boundary');
      return {
        granted: false,
        reason: `Access Denied: Path "${shown}" escapes workspaceRoot boundary.`,
        violatingTarget: shown,
      };
    }

    const scope = this.scopes.get(workerId);
    if (!scope) {
      if (this.strictMode) {
        this.log(workerId, 'fs_read', relPath, 'deny', 'No registered scope for worker');
        return {
          granted: false,
          reason: `Access Denied: Worker "${workerId}" has no granted capability scope.`,
          violatingTarget: relPath,
        };
      }
      this.log(workerId, 'fs_read', relPath, 'allow', 'Permitted by permissive default');
      return { granted: true };
    }

    const allowed = (scope.allowedReadGlobs || []).some((pattern) => matchesGlob(relPath, pattern));
    if (allowed) {
      this.log(workerId, 'fs_read', relPath, 'allow', 'Matched allowedReadGlobs');
      return { granted: true };
    }

    this.log(workerId, 'fs_read', relPath, 'deny', 'Outside assigned allowedReadGlobs');
    return {
      granted: false,
      reason: `Access Denied: File "${relPath}" is outside worker "${workerId}" assigned read scope [${(scope.allowedReadGlobs || []).join(', ')}].`,
      violatingTarget: relPath,
    };
  }

  /**
   * Checks whether a worker is authorized to execute a specific shell command.
   */
  public async checkExecPermission(workerId: string, command: string): Promise<PermissionCheckResult> {
    const trimmed = command.trim();
    const scope = this.scopes.get(workerId);

    // 1. Check globally destructive command signatures.
    // HỢP NHẤT với danh sách của scope, không thay thế: trước đây scope chỉ cần
    // khai báo `blockedCommands` (kể cả `[]`) là các chữ ký toàn cục như `mkfs`,
    // `shutdown` lập tức mất hiệu lực.
    const blockedPatterns = Array.from(
      new Set([...GLOBAL_BLOCKED_COMMANDS, ...(scope?.blockedCommands ?? [])])
    );

    for (const pattern of blockedPatterns) {
      if (matchesBlockedCommand(trimmed, pattern)) {
        this.log(workerId, 'shell_exec', trimmed, 'deny', `Matched blockedCommand pattern "${pattern}"`);
        return {
          granted: false,
          reason: `Security Block: Command matches destructive pattern "${pattern}".`,
          violatingTarget: command,
        };
      }
    }

    if (!scope) {
      if (this.strictMode) {
        this.log(workerId, 'shell_exec', trimmed, 'deny', 'No registered scope for worker');
        return {
          granted: false,
          reason: `Access Denied: Worker "${workerId}" has no registered execution scope.`,
          violatingTarget: command,
        };
      }
      this.log(workerId, 'shell_exec', trimmed, 'allow', 'Permitted by permissive default');
      return { granted: true };
    }

    // 2. Check allowedCommands
    const allowedPatterns = scope.allowedCommands || [];
    if (allowedPatterns.length > 0) {
      const isAllowed = allowedPatterns.some((pattern) => {
        if (trimmed === pattern || trimmed.startsWith(`${pattern} `)) return true;
        return matchesGlob(trimmed, pattern);
      });

      if (isAllowed) {
        this.log(workerId, 'shell_exec', trimmed, 'allow', 'Matched allowedCommands pattern');
        return { granted: true };
      }
    } else if (!this.strictMode) {
      this.log(workerId, 'shell_exec', trimmed, 'allow', 'No command restriction defined in scope');
      return { granted: true };
    }

    // 3. Check approval request callback
    if (this.onApprovalRequest) {
      const approved = await this.onApprovalRequest({
        workerId,
        type: 'shell_exec',
        target: trimmed,
        scope,
      });

      if (approved) {
        this.log(workerId, 'shell_exec', trimmed, 'allow', 'Approved by user callback');
        return { granted: true };
      }
    }

    this.log(workerId, 'shell_exec', trimmed, 'deny', 'Command not in allowedCommands scope');
    return {
      granted: false,
      reason: `Access Denied: Command "${trimmed}" is not authorized for worker "${workerId}".`,
      violatingTarget: command,
    };
  }
}

/**
 * Cross-platform process tree supervisor.
 * Ensures that spawned child processes and all their child sub-processes (Node workers, Vite, esbuild)
 * are cleanly killed without leaving dangling background processes.
 */
export class ProcessTreeSupervisor {
  /**
   * Recursively kills a process tree across Windows and POSIX.
   */
  public static killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!pid || pid <= 0) return;

    if (process.platform === 'win32') {
      try {
        child_process.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        // Taskkill fallback
        try {
          process.kill(pid, signal);
        } catch {
          // Process already terminated
        }
      }
    } else {
      try {
        // On Unix, kill the entire process group if negative pid.
        // Dùng đúng `signal` được yêu cầu (trước đây hardcode SIGKILL nên caller
        // xin SIGTERM để tắt êm không bao giờ nhận được).
        process.kill(-pid, signal);
      } catch {
        try {
          process.kill(pid, signal);
        } catch {
          // Already exited
        }
      }
    }
  }

  /**
   * Spawns a command with timeout monitoring, buffer capping, and guaranteed process tree cleanup.
   */
  public static async executeSupervised(
    command: string,
    options: {
      cwd: string;
      timeoutMs?: number;
      maxBufferBytes?: number;
      env?: Record<string, string>;
    }
  ): Promise<ManagedSpawnResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs || 30000;
    const maxBuffer = options.maxBufferBytes || 1024 * 1024 * 2; // 2MB default

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      // Spawn shell process with detached process group where supported
      const isWin = process.platform === 'win32';
      const child = child_process.spawn(command, {
        cwd: options.cwd,
        shell: true,
        detached: !isWin,
        env: { ...process.env, ...options.env },
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          ProcessTreeSupervisor.killProcessTree(child.pid, 'SIGKILL');
        }
      }, timeoutMs);

      // Cắt SAU khi nối: kiểm tra `length < maxBuffer` trước khi nối vẫn để lọt
      // một chunk lớn vượt trần.
      child.stdout?.on('data', (data: Buffer | string) => {
        stdout = (stdout + data.toString()).slice(0, maxBuffer);
      });

      child.stderr?.on('data', (data: Buffer | string) => {
        stderr = (stderr + data.toString()).slice(0, maxBuffer);
      });

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        resolve({
          code: timedOut ? 124 : code,
          stdout: stdout.trim(),
          stderr: timedOut ? `${stderr}\nExecution timed out after ${timeoutMs}ms.`.trim() : stderr.trim(),
          durationMs: Date.now() - startTime,
          timedOut,
        });
      };

      child.on('error', (err) => {
        stderr += `\n${err.message}`;
        finish(1);
      });

      child.on('close', (code) => {
        finish(code);
      });
    });
  }
}
