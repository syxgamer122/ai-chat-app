/**
 * Auto-pilot Multi-turn Execution — permission classification.
 *
 * Determines whether a tool call should be auto-approved based on the
 * active approval policy. Inspired by Goose's GooseMode (Auto/SmartApprove),
 * Codex CLI's approval modes (suggest/auto-edit/full-auto), and Cline's
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

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type ApprovalPolicy = 'always' | 'smart' | 'never';

export interface AutoApproveContext {
  toolName: string;
  args: Record<string, unknown>;
  policy: ApprovalPolicy;
  autoPilotEnabled: boolean;
  /** Per-tool permission overrides (optional for backward compat). */
  toolPermissions?: ToolPermissions;
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
  // Node evaluation
  /^node\s+-e\b/i,
  /^node\s+--eval\b/i,
  // Python read-only
  /^python(?:3)?\s+(?:-c|--version|-V)\b/i,
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

/** Tools that only READ data — safe to auto-approve in 'smart' mode. */
const READ_ONLY_TOOLS = new Set([
  'fs_read',
  'fs_list',
  'fs_stat',
  'web_search',
  'web_extract',
  'memory_search',
  'memory_list',
  'lesson_search',
]);

/** Tools that WRITE data — require approval in 'smart' mode. */
const WRITE_TOOLS = new Set([
  'fs_write',
  'fs_edit',
  'shell_run',
  'git_commit',
  'memory_save',
  'memory_delete',
  'lesson_save',
  'plan_create',
  'plan_update',
]);

/* ------------------------------------------------------------------ */
/* Classification                                                       */
/* ------------------------------------------------------------------ */

/**
 * Check if a shell command matches any safe pattern.
 */
export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  return SAFE_COMMAND_PATTERNS.some((p) => p.test(trimmed));
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
  // ── Per-tool override check (highest priority) ──
  if (ctx.toolPermissions) {
    const category = TOOL_CATEGORY_MAP[ctx.toolName];
    if (category) {
      const override = ctx.toolPermissions[category];
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
