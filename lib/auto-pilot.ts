/**
 * Auto-pilot Multi-turn Execution — permission classification.
 *
 * Determines whether a tool call should be auto-approved based on the
 * active approval policy. Inspired by agent-mode approval patterns (Auto/SmartApprove),
 * Các chế độ phê duyệt phổ biến (suggest/auto-edit/full-auto) và
 * per-category auto-approve toggles.
 *
 * Design principles:
 * - Rule-based classification (NOT LLM-based) for zero latency
 * - Conservative defaults: when uncertain, ask the user
 * - Destructive commands ALWAYS require approval, even in 'never' mode
 * - Read-only operations are safe to auto-approve in 'smart' mode
 */

import type { ToolPermissions, PermissionOverride } from '@/lib/store';
import { TOOL_CATEGORY_MAP } from '@/lib/store';
import { getEffectiveToolPermission, isDynamicMcpTool } from '@/lib/tool-permissions';
import { evaluateToolcallRules, type ToolcallRule } from '@/lib/toolcall-rules';
import { isProtectedPath, validateSafeRelativePath } from '@/lib/path-utils';
import { compileShellCommand } from '@/lib/shell-policy';
import {
  isTurnTainted,
  isEgressTool,
  getTurnTaintState,
  checkAutoBudget,
} from '@/lib/taint-tracker';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type ApprovalPolicy = 'always' | 'smart' | 'never' | 'chat_only';

export interface AutoApproveContext {
  toolName: string;
  args: Record<string, unknown>;
  policy: ApprovalPolicy;
  autoPilotEnabled: boolean;
  /** Active conversation identifier for turn taint and budget tracking. */
  conversationId?: string | null;
  /** Per-tool permission overrides (optional for backward compat). */
  toolPermissions?: ToolPermissions;
  /** User-defined toolcall rules. */
  toolcallRules?: ToolcallRule[];
}

/* ------------------------------------------------------------------ */
/* Safe command patterns                                                */
/* ------------------------------------------------------------------ */

/**
 * Shell commands that are SAFE to auto-approve in 'smart' mode.
 * These are read-only or non-destructive operations.
 * Pattern matching is done against the FIRST token of the command.
 */
const SAFE_COMMAND_PATTERNS: RegExp[] = [
  // Test runners
  /^npm\s+(?:test|run\s+test)/i,
  /^npx\s+(?:vitest|jest|mocha|ava)\b/i,
  /^yarn\s+test/i,
  /^pnpm\s+(?:test|run\s+test)/i,
  // Linters (read-only analysis)
  /^npm\s+run\s+(?:lint|typecheck|check|format:\s*check)/i,
  /^npx\s+(?:eslint|tsc|prettier\s+--check)\b/i,
  // Git read-only
  /^git\s+(?:status|log|diff|show|branch|remote|tag|stash\s+list|reflog)/i,
  // Build (non-destructive, output to dist/build)
  /^npm\s+(?:run\s+)?build/i,
  /^npx\s+(?:tsc|vite\s+build|next\s+build|webpack)\b/i,
  // Package info
  /^npm\s+(?:ls|list|outdated|info|view|search)\b/i,
  /^npx\s+(?:npm-check|depcheck)\b/i,
  // File reading / listing
  /^(?:cat|head|tail|less|more|wc|file|stat|ls|dir|find|grep|rg|fd)\b/i,
  // Version checks (read-only) — strictly version flags only, no arbitrary args
  /^node\s+(?:--version|-v)\s*$/i,
  /^python(?:3)?\s+(?:--version|-V)\s*$/i,
];

/**
 * Commands that are ALWAYS destructive and MUST require approval,
 * even in 'never' (YOLO) mode. Safety backstop.
 */
const ALWAYS_BLOCK_PATTERNS: RegExp[] = [
  /rm\s+-(?:rf|r)\s+\//i,           // rm -rf /
  /rm\s+-(?:rf|r)\s+~(?:\/|\s|$)/i,          // rm -rf ~
  /mkfs\b/i,                         // format disk
  /dd\s+.*of=\/dev\//i,             // write to device
  />\s*\/dev\/sd[a-z]/i,            // redirect to disk
  /format\s+[a-zA-Z]:/i,            // Windows format
  /diskpart/i,                       // Windows disk partitioning
  /reg\s+delete/i,                   // Windows registry delete
  /shutdown|reboot|poweroff/i,       // system shutdown
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;?\s*:/, // fork bomb
  /chmod\s+777\s+\//i,              // open permissions on root
];

/* ------------------------------------------------------------------ */
/* Read-only tool names                                                 */
/* ------------------------------------------------------------------ */

/**
 * Tools that only READ data — safe to auto-approve in 'smart' mode.
 * Names MUST match lib/tool-catalog.ts. `git_add` is documented as safe (it only stages
 * files; nothing reaches the repository until git_commit, which still requires approval).
 */
const READ_ONLY_TOOLS = new Set([
  'fs_read',
  'fs_list',
  'fs_search',
  'skill_load',
  'web_search',
  'web_fetch',
  'memory_search',
  'retrieve_memories',
  'chat_recall',
  'git_diff',
  'git_log',
  'git_status',
  'git_add',
  'bg_status',
  'tools_search',
  'tools_load',
]);

/**
 * Tools that WRITE data — require approval in 'smart' mode.
 * `shell_run` is intentionally absent: it is classified earlier by command-safety patterns,
 * so listing it here would be unreachable.
 */
const WRITE_TOOLS = new Set([
  'fs_write',
  'fs_edit',
  'fs_delete',
  'code_patch',
  'git_commit',
  'memory_save',
  'lesson_save',
  'remember_memory',
  'remove_memory_category',
  'remove_specific_memory',
  'plan_create',
  'plan_update',
  'bg_run',
  'bg_stop',
  'run_code',
]);

/* ------------------------------------------------------------------ */
/* Classification                                                       */
/* ------------------------------------------------------------------ */

/**
 * Check if a shell command matches any safe pattern.
 * Compiles the command via strict argv tokenizer and allowlist (shell: false paradigm).
 */
export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  try {
    const compiled = compileShellCommand(trimmed);
    if (compiled.bin === 'git' && compiled.args.length > 0) {
      const sub = compiled.args[0].toLowerCase();
      if (sub === 'commit' || sub === 'add') return false;
    }
    return SAFE_COMMAND_PATTERNS.some((p) => p.test(trimmed));
  } catch {
    return false;
  }
}

/**
 * Check if a shell command is ALWAYS blocked (destructive).
 * Returns true if the command should NEVER be auto-approved.
 */
export function isAlwaysBlocked(command: string): boolean {
  const trimmed = command.trim();
  return ALWAYS_BLOCK_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Check if tool targets auto-execute or sensitive configuration files
 * (.git/**, package.json, .vscode/**, .env*, .vyen/**).
 * Modifying or staging these files ALWAYS requires explicit approval (ask),
 * even in Autonomous / never policy mode or per-tool override 'auto'.
 */
export function targetsProtectedPath(toolName: string, args: Record<string, unknown>): boolean {
  const isTargetingTool =
    WRITE_TOOLS.has(toolName) || toolName === 'git_add' || toolName === 'fs_delete';
  if (!isTargetingTool) return false;

  const singlePath = args.path ?? args.relPath ?? args.file ?? args.filepath ?? args.file_path;
  if (typeof singlePath === 'string' && isProtectedPath(singlePath)) {
    return true;
  }
  if (Array.isArray(args.paths)) {
    return args.paths.some((p) => typeof p === 'string' && isProtectedPath(p));
  }
  return false;
}

/**
 * Provenance cho Egress Guard: khi lượt đã nhiễm nội dung ngoài và tool sắp gọi
 * có khả năng đưa dữ liệu ra ngoài, ghi lại nguồn nhiễm vào audit log (hash
 * chain ở lib/audit-log.ts) để truy vết ngược khi có sự cố.
 *
 * Import động là CỐ Ý: lib/auto-pilot được unit-test trong môi trường node thuần
 * — kéo Dexie vào đồ thị import tĩnh sẽ làm test phải chạy IndexedDB giả. Audit
 * cũng chỉ chạy khi guard thực sự kích hoạt (hiếm), không nằm trên đường nóng.
 */
function recordTaintedEgress(ctx: AutoApproveContext): void {
  const sources = getTurnTaintState(ctx.conversationId).sources;
  void (async () => {
    try {
      const { recordAuditLog } = await import('@/lib/audit-log');
      await recordAuditLog({
        action: 'rejection',
        tool: ctx.toolName,
        target:
          typeof ctx.args.command === 'string'
            ? ctx.args.command.slice(0, 200)
            : typeof ctx.args.path === 'string'
              ? ctx.args.path.slice(0, 200)
              : undefined,
        decision: 'blocked',
        payload: { args: ctx.args, policy: ctx.policy, taintSources: sources },
        chatId: ctx.conversationId ?? undefined,
        details: { reason: 'tainted_egress', taintSources: sources },
      });
    } catch {
      /* Audit là best-effort — không được phép chặn quyết định an toàn. */
    }
  })();
}

/**
 * Determine whether a tool call should be auto-approved.
 *
 * @returns `true` if the tool call should execute WITHOUT showing a confirmation modal.
 * @returns `false` if the user must approve via modal.
 *
 * Decision matrix:
 * | autoPilot | policy   | tool type     | result      |
 * |-----------|----------|---------------|-------------|
 * | OFF       | any      | any           | ASK         |
 * | ON        | always   | any           | ASK         |
 * | ON        | smart    | read-only     | AUTO        |
 * | ON        | smart    | safe shell    | AUTO        |
 * | ON        | smart    | write/destr.  | ASK         |
 * | ON        | never    | non-blocked   | AUTO        |
 * | ON        | never    | ALWAYS_BLOCK  | ASK         |
 */
export function shouldAutoApprove(ctx: AutoApproveContext): boolean {
  // ── Mode chat_only: vô hiệu hoàn toàn tool ──
  if (ctx.policy === 'chat_only') return false;

  // ── Egress Guard: Turn bị nhiễm untrusted data thì mọi tool ra ngoài PHẢI hỏi ──
  if (isTurnTainted(ctx.conversationId) && isEgressTool(ctx.toolName, ctx.args)) {
    recordTaintedEgress(ctx);
    return false;
  }

  // ── Autonomous Budget Guard: Vượt trần ngân sách thì tự hạ về ask ──
  if (ctx.policy === 'never' || ctx.policy === 'smart') {
    const budget = checkAutoBudget(getTurnTaintState(ctx.conversationId));
    if (budget.exceeded) {
      return false;
    }
  }

  // ── 0a. Destructive safety check (always blocked) ──
  if (ctx.toolName === 'shell_run') {
    const command = String(ctx.args.command ?? '');
    if (isAlwaysBlocked(command)) return false;
    // P0.2: Shell command cwd lockdown check
    if (ctx.args.cwd && !validateSafeRelativePath(String(ctx.args.cwd)).ok) {
      return false;
    }
  }

  // ── 0b. P0.3: Protect auto-execute and sensitive configuration files ──
  // (.git/**, package.json, .vscode/**, .env*, .vyen/**)
  // ALWAYS require explicit user approval (ask), even in 'never' mode or override 'auto'
  if (targetsProtectedPath(ctx.toolName, ctx.args)) {
    return false;
  }

  // ── 1. User Toolcall Rules (mức ưu tiên trước policy) ──
  if (ctx.toolcallRules && ctx.toolcallRules.length > 0) {
    const verdict = evaluateToolcallRules(ctx.toolName, ctx.args, ctx.toolcallRules);
    if (verdict.decision === 'deny' || verdict.decision === 'ask') return false;
    if (verdict.decision === 'allow') return true;
  }

  // ── Per-tool override check (highest priority) ──
  if (ctx.toolPermissions) {
    const override = getEffectiveToolPermission(ctx.toolName, ctx.toolPermissions, ctx.args);

    if (override === 'deny') return false;   // Blocked entirely
    if (override === 'ask') return false;     // Always ask, even in YOLO
    if (override === 'auto') {
      // Auto-approve, but ALWAYS_BLOCK commands still blocked for safety
      if (ctx.toolName === 'shell_run') {
        const command = String(ctx.args.command ?? '');
        if (isAlwaysBlocked(command)) return false;
      }
      return true;
    }
    // 'default' → fall through to policy-based logic below
  }

  // ── Enforce deny-by-default for unapproved dynamic MCP tools (mcp__<server>__<tool>) ──
  // P3.6: Dynamic MCP tools require explicit permission override ('auto') to auto-approve.
  if (isDynamicMcpTool(ctx.toolName)) {
    const effective = ctx.toolPermissions
      ? getEffectiveToolPermission(ctx.toolName, ctx.toolPermissions, ctx.args)
      : 'deny';
    if (effective !== 'auto') {
      return false;
    }
  }

  // Master switch off → always ask
  if (!ctx.autoPilotEnabled) return false;

  // Policy 'always' → always ask (explicit user choice to review everything)
  if (ctx.policy === 'always') return false;

  // Policy 'never' (YOLO) → auto-approve UNLESS always-blocked
  if (ctx.policy === 'never') {
    if (ctx.toolName === 'shell_run') {
      const command = String(ctx.args.command ?? '');
      if (isAlwaysBlocked(command)) return false;
    }
    return true;
  }

  // Policy 'smart' → classify by tool type and command safety
  if (ctx.policy === 'smart') {
    // Read-only tools → auto-approve
    if (READ_ONLY_TOOLS.has(ctx.toolName)) return true;

    // Shell commands → check safety patterns
    if (ctx.toolName === 'shell_run') {
      const command = String(ctx.args.command ?? '');
      // Always-blocked commands → ask even in smart mode
      if (isAlwaysBlocked(command)) return false;
      // Safe commands → auto-approve
      if (isSafeCommand(command)) return true;
      // Unknown commands → ask (conservative)
      return false;
    }

    // Write tools → ask
    if (WRITE_TOOLS.has(ctx.toolName)) return false;

    // Unknown tools → ask (conservative)
    return false;
  }

  // Fallback: ask
  return false;
}
