/**
 * Core Agent Runtime — Tool Runner (Tầng 1: Zero React Dependencies).
 *
 * Nhiệm vụ:
 * 1. Trích xuất toàn bộ logic điều phối và thẩm tra an toàn của công cụ (fs_*, shell_run, git_*, mcp_*).
 * 2. Bảo vệ TOCTOU (Time-of-Check to Time-of-Use) bằng mã băm SHA-256 baseHash trước khi ghi đĩa.
 * 3. Chống rò rỉ CWD (CWD Jail) qua `validateSafeRelativePath`.
 * 4. Kiểm tra allowlist câu lệnh shell qua `lib/shell-policy.cjs` (chặn metacharacters, pipes, substitutions).
 * 5. Buộc gắn token phê duyệt chặt chẽ với `activeLeafId` và `expectedBaseHash` để triệt tiêu Race Condition khi fork nhánh.
 */

import { validateSafeRelativePath, normalizePathKey, isSystemDenylistedPath } from '@/lib/path-utils';
import {
  ApprovalBinding,
  ApprovalToken,
  ApprovalVerification,
  createApprovalToken,
  verifyApprovalToken,
  consumeApprovalToken,
} from '@/lib/approval-binding';

import { compileShellCommand, PolicyError } from '@/lib/shell-policy';

/**
 * Kiểm tra và giam giữ đường dẫn file trong workspace an toàn, từ chối System Denylist.
 */
export function validateFilePathJail(filePath?: string): { ok: boolean; reason?: string } {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: false, reason: 'Đường dẫn file không hợp lệ hoặc rỗng.' };
  }
  const check = validateSafeRelativePath(filePath);
  if (!check.ok) {
    return { ok: false, reason: check.reason || 'Đường dẫn thoát khỏi phạm vi workspace an toàn.' };
  }
  if (isSystemDenylistedPath(filePath)) {
    return { ok: false, reason: `Đường dẫn "${filePath}" bị từ chối bởi System Denylist (.git/**, node_modules/**).` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 1. SHA-256 Hash Utilities & TOCTOU Protection                      */
/* ------------------------------------------------------------------ */

/**
 * Tính toán mã băm SHA-256 dạng hex 64 ký tự (hỗ trợ cả Web Crypto API và Node.js).
 */
export async function computeSha256(content: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const data = new TextEncoder().encode(content);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fallback Node.js runtime
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('node:crypto');
  return nodeCrypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface ToctouVerificationResult {
  ok: boolean;
  currentHash: string | null;
  expectedHash: string | null;
  error?: string;
}

/**
 * Xác minh mã băm nội dung hiện tại trên đĩa so với baseHash mong đợi (TOCTOU guard).
 */
export async function verifyToctouBaseHash(
  currentDiskContent: string | null | undefined,
  expectedBaseHash: string | null | undefined,
  filePath: string,
): Promise<ToctouVerificationResult> {
  const currentHash =
    currentDiskContent !== null && currentDiskContent !== undefined
      ? await computeSha256(currentDiskContent)
      : null;

  if (expectedBaseHash !== undefined && expectedBaseHash !== null) {
    if (currentHash !== expectedBaseHash) {
      const initialShort = expectedBaseHash ? expectedBaseHash.slice(0, 8) : 'null';
      const currentShort = currentHash ? currentHash.slice(0, 8) : 'null';
      return {
        ok: false,
        currentHash,
        expectedHash: expectedBaseHash,
        error:
          `Xung đột ghi đè (TOCTOU Conflict): File "${filePath}" đã bị thay đổi bên ngoài sau khi đọc. ` +
          `Hash ban đầu: ${initialShort}..., Hash hiện tại: ${currentShort}... ` +
          'Hãy gọi lại fs_read để đọc nội dung mới nhất trước khi áp dụng thay đổi.',
      };
    }
  }

  return {
    ok: true,
    currentHash,
    expectedHash: expectedBaseHash ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 2. CWD Jail & Shell Policy Allowlist Checks                         */
/* ------------------------------------------------------------------ */

export interface CwdJailResult {
  ok: boolean;
  sanitizedCwd?: string;
  reason?: string;
}

/**
 * Kiểm tra và giam giữ CWD trong phạm vi workspace an toàn (CWD Jail).
 */
export function validateCwdJail(cwd?: string): CwdJailResult {
  if (!cwd || cwd === '.' || cwd === './') {
    return { ok: true, sanitizedCwd: undefined };
  }

  const check = validateSafeRelativePath(cwd);
  if (!check.ok) {
    return {
      ok: false,
      reason: `Thư mục làm việc (cwd) không hợp lệ hoặc thoát khỏi workspace: "${cwd}". ${check.reason || 'Bị chặn bởi path jail.'}`,
    };
  }

  return { ok: true, sanitizedCwd: cwd };
}

export interface ShellValidationResult {
  ok: boolean;
  compiled?: { bin: string; args: string[] };
  reason?: string;
}

/**
 * Kiểm tra lệnh shell theo danh sách allowlist và từ chối các ký tự metacharacter nguy hiểm.
 */
export function validateShellAllowlist(command: string): ShellValidationResult {
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, reason: 'Lệnh shell rỗng hoặc không hợp lệ.' };
  }

  try {
    const compiled = compileShellCommand(command);
    return { ok: true, compiled };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message };
  }
}

/* ------------------------------------------------------------------ */
/* 3. Approval Token Binding Helpers                                  */
/* ------------------------------------------------------------------ */

export interface ToolApprovalBindingParams {
  kind: 'diff' | 'shell' | 'run_code';
  payload: unknown;
  toolCallId?: string;
  chatId?: string;
  activeLeafId?: string;
  expectedBaseHash?: string;
  workspaceFingerprint?: string;
}

export function buildToolApprovalBinding(params: ToolApprovalBindingParams): ApprovalBinding {
  return {
    kind: params.kind,
    payload: params.payload,
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    ...(params.chatId ? { chatId: params.chatId } : {}),
    ...(params.activeLeafId ? { activeLeafId: params.activeLeafId } : {}),
    ...(params.expectedBaseHash ? { expectedBaseHash: params.expectedBaseHash } : {}),
    ...(params.workspaceFingerprint ? { workspaceFingerprint: params.workspaceFingerprint } : {}),
  };
}

export function createToolApprovalToken(
  params: ToolApprovalBindingParams,
  now?: number,
): ApprovalToken | null {
  return createApprovalToken(buildToolApprovalBinding(params), now);
}

export function verifyToolApprovalToken(
  fingerprint: string,
  params: ToolApprovalBindingParams,
  now?: number,
): ApprovalVerification {
  return verifyApprovalToken(fingerprint, buildToolApprovalBinding(params), now);
}

export function consumeToolApprovalToken(
  fingerprint: string,
  params: ToolApprovalBindingParams,
  now?: number,
): ApprovalVerification {
  return consumeApprovalToken(fingerprint, buildToolApprovalBinding(params), now);
}

/* ------------------------------------------------------------------ */
/* 4. Tool Execution Context & Types                                  */
/* ------------------------------------------------------------------ */

export interface ToolExecutionContext {
  chatId: string;
  activeLeafId?: string;
  workspaceRoot?: string;
  readFiles?: Set<string>;
  isDesktop?: boolean;
  agentMode?: 'plan' | 'act';
  approvalPolicy?: string;
  toolPermissions?: Record<string, unknown>;
  autoPilotEnabled?: boolean;
  abortSignal?: AbortSignal;

  // Approval hooks
  requestApproval?: (binding: ApprovalBinding) => Promise<{ approved: boolean; token?: string }>;
  consumeApproval?: (token: string, binding: ApprovalBinding) => boolean;
  recordAuditLog?: (entry: any) => Promise<unknown> | void;

  // File system adapters
  fsRead?: (path: string, opts?: { startLine?: number; lineCount?: number }) => Promise<unknown>;
  fsWrite?: (path: string, content: string, baseHash?: string | null) => Promise<unknown>;
  fsList?: (path: string) => Promise<unknown>;
  fsSearch?: (query: string, opts?: { isRegex?: boolean }) => Promise<unknown>;

  // Shell adapters
  shellRun?: (params: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    approvalToken?: string;
    chatId?: string;
  }) => Promise<{ code: number | null; stdout?: string; stderr?: string }>;
  shellRunBg?: (params: { command: string; timeoutSecs?: number }) => Promise<unknown>;
  shellBgStatus?: (jobId?: string) => Promise<unknown>;
  shellBgStop?: (jobId: string) => Promise<unknown>;

  // Git adapters
  gitStatus?: () => Promise<unknown>;
  gitDiff?: (opts?: unknown) => Promise<unknown>;
  gitLog?: (opts?: unknown) => Promise<unknown>;
  gitAdd?: (opts?: unknown) => Promise<unknown>;
  gitCommit?: (opts?: unknown) => Promise<unknown>;

  // MCP adapter
  mcpCallTool?: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/* 5. ToolRunner Engine                                               */
/* ------------------------------------------------------------------ */

export class ToolRunner {
  private context: ToolExecutionContext;

  constructor(context: ToolExecutionContext) {
    this.context = {
      ...context,
      readFiles: context.readFiles || new Set<string>(),
    };
  }

  public updateContext(updates: Partial<ToolExecutionContext>): void {
    Object.assign(this.context, updates);
  }

  public getContext(): Readonly<ToolExecutionContext> {
    return this.context;
  }

  /**
   * Bọc Promise với AbortSignal để lập tức reject khi turn bị huỷ (Stop hoặc Fork).
   */
  public async withAbort<T>(promise: Promise<T>): Promise<T> {
    const signal = this.context.abortSignal;
    if (!signal) return promise;
    if (signal.aborted) {
      throw new Error('Tác vụ bị hủy bỏ (Aborted).');
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Tác vụ bị hủy bỏ (Aborted).'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (res) => {
          signal.removeEventListener('abort', onAbort);
          resolve(res);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  /**
   * Điều phối thực thi một tool call với đầy đủ chokepoints bảo vệ.
   */
  public async executeTool(toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    if (this.context.abortSignal?.aborted) {
      throw new Error('Tác vụ bị hủy bỏ (Aborted).');
    }

    // Mode chat_only: vô hiệu hóa toàn bộ tool
    if (this.context.approvalPolicy === 'chat_only') {
      return JSON.stringify({
        error: `Tool "${toolName}" is denied by policy (chat_only mode).`,
        denied: true,
      });
    }

    try {
      switch (toolName) {
        case 'fs_list':
          return await this.executeFsList(args);

        case 'fs_read':
          return await this.executeFsRead(args);

        case 'fs_search':
          return await this.executeFsSearch(args);

        case 'fs_edit':
          return await this.executeFsEdit(args);

        case 'fs_write':
          return await this.executeFsWrite(args);

        case 'shell_run':
          return await this.executeShellRun(args);

        case 'bg_run':
          return await this.executeBgRun(args);

        case 'bg_status':
          return await this.executeBgStatus(args);

        case 'bg_stop':
          return await this.executeBgStop(args);

        case 'git_status':
        case 'git_diff':
        case 'git_log':
        case 'git_add':
        case 'git_commit':
          return await this.executeGit(toolName, args);

        default:
          if (toolName.startsWith('mcp__') || toolName.startsWith('mcp:')) {
            return await this.executeMcp(toolName, args);
          }
          return JSON.stringify({ error: `Công cụ không xác định: "${toolName}".` });
      }
    } catch (err) {
      if (this.context.abortSignal?.aborted || (err instanceof Error && err.message.includes('Tác vụ bị hủy bỏ'))) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Thực thi công cụ "${toolName}" thất bại: ${message}` });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Sub-Executors                                                      */
  /* ------------------------------------------------------------------ */

  private async executeFsList(args: Record<string, unknown>): Promise<string> {
    const rel = String(args.path ?? '');
    if (rel && rel !== '.' && rel !== './') {
      const jailCheck = validateFilePathJail(rel);
      if (!jailCheck.ok) {
        return JSON.stringify({ error: jailCheck.reason });
      }
    }
    if (!this.context.fsList) {
      return JSON.stringify({ error: 'fsList adapter chưa được cấu hình.' });
    }
    const data = await this.withAbort(this.context.fsList(rel));
    return JSON.stringify(data);
  }

  private async executeFsRead(args: Record<string, unknown>): Promise<string> {
    const rel = String(args.path ?? '');
    const jailCheck = validateFilePathJail(rel);
    if (!jailCheck.ok) {
      return JSON.stringify({ error: jailCheck.reason });
    }

    const opts = {
      ...(typeof args.start_line === 'number' ? { startLine: args.start_line } : {}),
      ...(typeof args.line_count === 'number' ? { lineCount: args.line_count } : {}),
    };

    if (!this.context.fsRead) {
      return JSON.stringify({ error: 'fsRead adapter chưa được cấu hình.' });
    }

    const data = await this.withAbort(this.context.fsRead(rel, opts));
    if (!(data as Record<string, unknown>)?.error) {
      this.context.readFiles?.add(normalizePathKey(rel));
    }
    return JSON.stringify(data);
  }

  private async executeFsSearch(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '');
    const isRegex = args.is_regex === true;
    if (!this.context.fsSearch) {
      return JSON.stringify({ error: 'fsSearch adapter chưa được cấu hình.' });
    }
    const data = await this.withAbort(this.context.fsSearch(query, { isRegex }));
    return JSON.stringify(data);
  }

  private async executeFsEdit(args: Record<string, unknown>): Promise<string> {
    const path = String(args.path ?? '');
    const jailCheck = validateFilePathJail(path);
    if (!jailCheck.ok) {
      return JSON.stringify({ applied: false, error: jailCheck.reason });
    }

    const normPath = normalizePathKey(path);

    // Read-before-edit guard
    if (normPath && this.context.readFiles && !this.context.readFiles.has(normPath)) {
      return JSON.stringify({
        applied: false,
        error:
          `File "${path}" chưa được đọc. Bạn PHẢI gọi fs_read để đọc nội dung file này ` +
          'trước khi sửa. Điều này đảm bảo bạn hiểu rõ nội dung hiện tại và tránh ghi đè.',
      });
    }

    // Plan mode guard
    if (this.context.agentMode === 'plan') {
      return JSON.stringify({
        applied: false,
        error:
          'PLAN MODE đang bật — không được phép sửa file. Hãy trình bày kế hoạch ' +
          'và chờ người dùng chuyển sang ACT mode trước khi thực thi.',
      });
    }

    if (!this.context.fsRead || !this.context.fsWrite) {
      return JSON.stringify({ applied: false, error: 'fsRead/fsWrite adapter chưa được cấu hình.' });
    }

    // Đọc nội dung hiện tại để tính baseHash
    let beforeText = '';
    try {
      const readResult = (await this.withAbort(this.context.fsRead(path))) as { content?: string; error?: string };
      if (readResult.error) {
        return JSON.stringify({ applied: false, error: readResult.error });
      }
      beforeText = readResult.content ?? '';
    } catch (e) {
      return JSON.stringify({ applied: false, error: `Không thể đọc file trước khi sửa: ${String(e)}` });
    }

    // Xử lý nội dung thay đổi: từ SEARCH/REPLACE blocks hoặc content trực tiếp
    let newContent = typeof args.content === 'string' ? args.content : '';
    let appliedBlocksCount = 0;
    if (args.blocks) {
      let blocksText = String(args.blocks);
      // Nếu blocks không chứa tên file ở trước, tự động bổ sung tên file từ path
      const firstHeadIndex = blocksText.indexOf('<<<<<<< SEARCH');
      if (firstHeadIndex !== -1 && path) {
        const preceding = blocksText.slice(0, firstHeadIndex).trim();
        if (!preceding) {
          blocksText = `${path}\n${blocksText}`;
        }
      }
      const { parseEditBlocks, replaceMostSimilarChunk } = await import('@/lib/edit-blocks');
      const parsed = parseEditBlocks(blocksText);
      if (parsed.error || parsed.blocks.length === 0) {
        return JSON.stringify({ applied: false, error: parsed.error ?? 'Không parse được khối edit.' });
      }
      let current = beforeText;
      for (const block of parsed.blocks) {
        const r = replaceMostSimilarChunk(current, block.search, block.replace);
        if (!r.ok) {
          return JSON.stringify({
            applied: false,
            failedBlock: { file: block.filename, search: block.search.slice(0, 200) },
            hint: r.hint,
            note: 'Khối SEARCH không khớp. Đọc lại file (fs_read) rồi copy NGUYÊN VĂN đoạn cần đổi.',
          });
        }
        current = r.text!;
      }
      newContent = current;
      appliedBlocksCount = parsed.blocks.length;
    } else if (!newContent) {
      newContent = beforeText;
    }

    const baseHash = await computeSha256(beforeText);

    // Chuẩn bị payload và approval binding
    const binding = buildToolApprovalBinding({
      kind: 'diff',
      payload: { path, oldText: beforeText, newText: newContent, toolName: 'fs_edit' },
      chatId: this.context.chatId,
      activeLeafId: this.context.activeLeafId,
      expectedBaseHash: baseHash,
    });

    if (this.context.requestApproval) {
      const approval = await this.withAbort(this.context.requestApproval(binding));
      if (!approval.approved) {
        return JSON.stringify({ applied: false, note: 'Người dùng TỪ CHỐI thay đổi này.' });
      }

      // Xác minh tiêu thụ token trước khi ghi
      if (approval.token && this.context.consumeApproval) {
        const consumed = this.context.consumeApproval(approval.token, binding);
        if (!consumed) {
          return JSON.stringify({ applied: false, error: 'Xác thực Approval Token thất bại hoặc token đã bị dùng.' });
        }
      }
    }

    // Re-check TOCTOU trước khi ghi
    let freshDiskText = '';
    try {
      const probe = (await this.withAbort(this.context.fsRead(path))) as { content?: string };
      freshDiskText = probe?.content ?? '';
    } catch {}

    const toctouCheck = await verifyToctouBaseHash(freshDiskText, baseHash, path);
    if (!toctouCheck.ok) {
      return JSON.stringify({ applied: false, error: toctouCheck.error });
    }

    // Ghi đĩa
    const writeRes = await this.withAbort(this.context.fsWrite(path, newContent, baseHash));

    this.context.recordAuditLog?.({
      action: 'file_modification',
      tool: 'fs_edit',
      target: path,
      decision: 'executed',
      payload: { path, blocks: appliedBlocksCount },
      chatId: this.context.chatId,
    });

    return JSON.stringify({ applied: true, blocks: appliedBlocksCount, ...((writeRes as object) || {}) });
  }

  private async executeFsWrite(args: Record<string, unknown>): Promise<string> {
    const path = String(args.path ?? '');
    const content = String(args.content ?? '');

    const jailCheck = validateFilePathJail(path);
    if (!jailCheck.ok) {
      return JSON.stringify({ written: false, error: jailCheck.reason });
    }

    // Plan mode guard
    if (this.context.agentMode === 'plan') {
      return JSON.stringify({
        written: false,
        error:
          'PLAN MODE đang bật — không được phép ghi file. Hãy trình bày kế hoạch ' +
          'và chờ người dùng chuyển sang ACT mode trước khi thực thi.',
      });
    }

    if (!this.context.fsWrite) {
      return JSON.stringify({ written: false, error: 'fsWrite adapter chưa được cấu hình.' });
    }

    let oldText = '';
    let fileExists = false;
    if (this.context.fsRead) {
      try {
        const readResult = (await this.withAbort(this.context.fsRead(path))) as { content?: string; error?: string };
        if (!readResult.error && typeof readResult.content === 'string') {
          oldText = readResult.content;
          fileExists = true;
        }
      } catch {}
    }

    // Read-before-edit guard cho file đã tồn tại trên đĩa
    const normPath = normalizePathKey(path);
    if (fileExists && normPath && this.context.readFiles && !this.context.readFiles.has(normPath)) {
      return JSON.stringify({
        written: false,
        error:
          `File "${path}" đã tồn tại trên đĩa nhưng chưa được đọc. Bạn PHẢI gọi fs_read ` +
          'để đọc nội dung file này trước khi ghi đè, hoặc dùng fs_edit để sửa cục bộ.',
      });
    }

    const baseHash = fileExists ? await computeSha256(oldText) : null;

    // Chuẩn bị payload và approval binding
    const binding = buildToolApprovalBinding({
      kind: 'diff',
      payload: { path, oldText, newText: content, toolName: 'fs_write' },
      chatId: this.context.chatId,
      activeLeafId: this.context.activeLeafId,
      expectedBaseHash: baseHash ?? undefined,
    });

    if (this.context.requestApproval) {
      const approval = await this.withAbort(this.context.requestApproval(binding));
      if (!approval.approved) {
        return JSON.stringify({ written: false, note: 'Người dùng TỪ CHỐI ghi file này.' });
      }

      // Xác minh tiêu thụ token trước khi ghi
      if (approval.token && this.context.consumeApproval) {
        const consumed = this.context.consumeApproval(approval.token, binding);
        if (!consumed) {
          return JSON.stringify({ written: false, error: 'Xác thực Approval Token thất bại hoặc token đã bị dùng.' });
        }
      }
    }

    // Re-check TOCTOU trước khi ghi
    if (fileExists && this.context.fsRead) {
      let freshDiskText = '';
      try {
        const probe = (await this.withAbort(this.context.fsRead(path))) as { content?: string };
        freshDiskText = probe?.content ?? '';
      } catch {}

      const toctouCheck = await verifyToctouBaseHash(freshDiskText, baseHash, path);
      if (!toctouCheck.ok) {
        return JSON.stringify({ written: false, error: toctouCheck.error });
      }
    }

    // Ghi đĩa
    const writeRes = await this.withAbort(this.context.fsWrite(path, content, baseHash));

    this.context.recordAuditLog?.({
      action: 'file_modification',
      tool: 'fs_write',
      target: path,
      decision: 'executed',
      payload: { path, size: content.length },
      chatId: this.context.chatId,
    });

    return JSON.stringify({ written: true, ...((writeRes as object) || {}) });
  }

  private async executeShellRun(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    const rawCwd = args.cwd ? String(args.cwd) : undefined;

    // 1. CWD Jail Check
    const cwdResult = validateCwdJail(rawCwd);
    if (!cwdResult.ok) {
      return JSON.stringify({ approved: false, error: cwdResult.reason });
    }
    const cwd = cwdResult.sanitizedCwd;

    // 2. Shell Allowlist Check
    const shellResult = validateShellAllowlist(command);
    if (!shellResult.ok) {
      return JSON.stringify({
        approved: false,
        error: `Lệnh bị từ chối bởi Shell Policy: ${shellResult.reason}`,
      });
    }

    // 3. Approval Binding
    const binding = buildToolApprovalBinding({
      kind: 'shell',
      payload: { command, cwd },
      chatId: this.context.chatId,
      activeLeafId: this.context.activeLeafId,
    });

    let token: string | undefined;
    if (this.context.requestApproval) {
      const approval = await this.withAbort(this.context.requestApproval(binding));
      if (!approval.approved) {
        return JSON.stringify({ approved: false, note: 'Người dùng TỪ CHỐI chạy lệnh này.' });
      }
      token = approval.token;

      if (token && this.context.consumeApproval) {
        const consumed = this.context.consumeApproval(token, binding);
        if (!consumed) {
          return JSON.stringify({ approved: false, error: 'Xác thực Approval Token thất bại hoặc token đã bị dùng.' });
        }
      }
    }

    if (!this.context.shellRun) {
      return JSON.stringify({ error: 'shellRun adapter chưa được cấu hình.' });
    }

    const timeoutSecs =
      typeof args.timeout_secs === 'number' ? Math.min(Math.max(args.timeout_secs, 1), 600) : undefined;
    const timeoutMs = timeoutSecs ? timeoutSecs * 1000 : undefined;

    const result = await this.withAbort(
      this.context.shellRun({
        command,
        cwd,
        timeoutMs,
        approvalToken: token,
        chatId: this.context.chatId,
      }),
    );

    this.context.recordAuditLog?.({
      action: 'shell_execution',
      tool: 'shell_run',
      target: command,
      decision: 'executed',
      payload: { command, cwd, exitCode: result.code },
      chatId: this.context.chatId,
    });

    return JSON.stringify(result);
  }

  private async executeBgRun(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '');
    const timeoutSecs =
      typeof args.timeout_secs === 'number' ? Math.min(Math.max(args.timeout_secs, 1), 3600) : undefined;

    const binding = buildToolApprovalBinding({
      kind: 'shell',
      payload: { command, cwd: undefined },
      chatId: this.context.chatId,
      activeLeafId: this.context.activeLeafId,
    });

    if (this.context.requestApproval) {
      const approval = await this.withAbort(this.context.requestApproval(binding));
      if (!approval.approved) {
        return JSON.stringify({ approved: false, note: 'Người dùng TỪ CHỐI chạy lệnh nền này.' });
      }
    }

    if (!this.context.shellRunBg) {
      return JSON.stringify({ error: 'shellRunBg adapter chưa được cấu hình.' });
    }

    const r = await this.withAbort(this.context.shellRunBg({ command, timeoutSecs }));
    return JSON.stringify(r);
  }

  private async executeBgStatus(args: Record<string, unknown>): Promise<string> {
    if (!this.context.shellBgStatus) {
      return JSON.stringify({ error: 'shellBgStatus adapter chưa được cấu hình.' });
    }
    const jobId = typeof args.job_id === 'string' && args.job_id ? args.job_id : undefined;
    const r = await this.withAbort(this.context.shellBgStatus(jobId));
    return JSON.stringify(r);
  }

  private async executeBgStop(args: Record<string, unknown>): Promise<string> {
    const jobId = String(args.job_id ?? '');
    if (!jobId) {
      return JSON.stringify({ error: 'Thiếu job_id — lấy từ kết quả của bg_run.' });
    }
    if (!this.context.shellBgStop) {
      return JSON.stringify({ error: 'shellBgStop adapter chưa được cấu hình.' });
    }
    const r = await this.withAbort(this.context.shellBgStop(jobId));
    return JSON.stringify(r);
  }

  private async executeGit(toolName: string, args: Record<string, unknown>): Promise<string> {
    switch (toolName) {
      case 'git_status':
        if (!this.context.gitStatus) return JSON.stringify({ error: 'gitStatus chưa được cấu hình.' });
        return JSON.stringify(await this.withAbort(this.context.gitStatus()));

      case 'git_diff':
        if (!this.context.gitDiff) return JSON.stringify({ error: 'gitDiff chưa được cấu hình.' });
        return JSON.stringify(await this.withAbort(this.context.gitDiff(args)));

      case 'git_log':
        if (!this.context.gitLog) return JSON.stringify({ error: 'gitLog chưa được cấu hình.' });
        return JSON.stringify(await this.withAbort(this.context.gitLog(args)));

      case 'git_add':
        if (!this.context.gitAdd) return JSON.stringify({ error: 'gitAdd chưa được cấu hình.' });
        return JSON.stringify(await this.withAbort(this.context.gitAdd(args)));

      case 'git_commit':
        if (!this.context.gitCommit) return JSON.stringify({ error: 'gitCommit chưa được cấu hình.' });
        return JSON.stringify(await this.withAbort(this.context.gitCommit(args)));

      default:
        return JSON.stringify({ error: `Lệnh git không được hỗ trợ: ${toolName}` });
    }
  }

  private async executeMcp(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (!this.context.mcpCallTool) {
      return JSON.stringify({ error: 'mcpCallTool adapter chưa được cấu hình.' });
    }

    const parts = toolName.replace(/^mcp(__|:)/, '').split('__');
    const serverId = parts.length > 1 ? parts[0] : 'default';
    const mcpTool = parts.length > 1 ? parts.slice(1).join('__') : parts[0];

    try {
      const res = await this.withAbort(this.context.mcpCallTool(serverId, mcpTool, args));
      return JSON.stringify(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Gọi công cụ MCP "${toolName}" thất bại: ${message}` });
    }
  }
}
