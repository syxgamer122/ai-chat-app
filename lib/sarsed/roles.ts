/**
 * Sarsed-Code Multi-Role Agent Fleet.
 *
 * Implements role specialization and structured handovers:
 * 1. Architect: High-level system design, dependency analysis, and blueprint generation.
 * 2. Coder: Surgical implementation, transactional patching, and contract enforcement.
 * 3. Verifier: Automated test execution, diagnostic extraction, and regression gating.
 * 4. Critic: Code quality review, security audit, and final milestone approval.
 */

import type { SarsRole, SarsRoleContract, SarsRoleHandover } from './types';

export const SARS_ROLES: Record<SarsRole, SarsRoleContract> = {
  architect: {
    role: 'architect',
    title: 'System Architect & Graph Analyst',
    responsibilities: [
      'Analyze file dependency graphs and detect dependency cycles.',
      'Produce AST code skeletons for complex modules without bloating token budget.',
      'Formulate structured implementation blueprints and contracts before code edits.',
    ],
    allowedActions: ['code_skeleton', 'code_symbols', 'fs_read', 'fs_list', 'plan_create'],
    systemPromptAddition: `You are the Sarsed ARCHITECT. Your primary objective is to inspect high-level codebase architecture, review interfaces and AST skeletons, and create precise implementation blueprints before any file modification. Do NOT perform destructive writes.`,
  },

  coder: {
    role: 'coder',
    title: 'Surgical Coder & Semantic Patcher',
    responsibilities: [
      'Execute atomic, multi-hunk semantic patches adhering strictly to architectural blueprints.',
      'Maintain indentation normalization and transactional rollback safety.',
      'Avoid unneeded refactoring or breaking existing contracts.',
    ],
    allowedActions: ['code_patch', 'fs_read', 'fs_edit', 'fs_write'],
    systemPromptAddition: `You are the Sarsed CODER. Your primary objective is surgical precision. Apply multi-hunk patches atomically. Never leave intermediate corrupted files. Follow contracts specified by the Architect.`,
  },

  verifier: {
    role: 'verifier',
    title: 'Verification & Diagnostic Engine',
    responsibilities: [
      'Execute compilers (tsc), linters (eslint), and test runners (vitest).',
      'Parse diagnostic traces into structured line-by-line diagnostic errors.',
      'Run the closed SARS self-correction loop to repair failing lines.',
    ],
    allowedActions: ['code_verify', 'shell_run', 'fs_read'],
    systemPromptAddition: `You are the Sarsed VERIFIER. Your primary objective is test and type assurance. Run verification suites, isolate diagnostic errors in touched files, and formulate self-correction repairs.`,
  },

  critic: {
    role: 'critic',
    title: 'Quality Auditor & Gate Reviewer',
    responsibilities: [
      'Inspect unified diffs and verify zero-regression invariants.',
      'Perform security SAST and injection checks.',
      'Issue PASS or REJECT verdict on milestone completion.',
    ],
    allowedActions: ['git_diff', 'fs_read', 'plan_update'],
    systemPromptAddition: `You are the Sarsed CRITIC. Your primary objective is strict quality audit. Validate that 100% of tests pass, no secrets are leaked, and code changes strictly satisfy requirements before granting PASS verdict.`,
  },
};

export class SarsRoleManager {
  private currentRole: SarsRole = 'architect';
  private handovers: SarsRoleHandover[] = [];

  getCurrentRole(): SarsRole {
    return this.currentRole;
  }

  getRoleContract(role: SarsRole = this.currentRole): SarsRoleContract {
    return SARS_ROLES[role];
  }

  /**
   * Transition to next role with structured context handover.
   */
  handover(toRole: SarsRole, payload: Omit<SarsRoleHandover, 'fromRole' | 'toRole' | 'timestamp'>): SarsRoleHandover {
    const record: SarsRoleHandover = {
      fromRole: this.currentRole,
      toRole,
      contextSummary: payload.contextSummary,
      modifiedFiles: payload.modifiedFiles,
      targetInvariants: payload.targetInvariants,
      artifacts: payload.artifacts,
      timestamp: Date.now(),
    };

    this.handovers.push(record);
    this.currentRole = toRole;
    return record;
  }

  getHandoverHistory(): readonly SarsRoleHandover[] {
    return this.handovers;
  }

  clear(): void {
    this.currentRole = 'architect';
    this.handovers = [];
  }
}
