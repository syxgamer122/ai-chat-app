/**
 * Compact Completion & Stoppage Summary Generator for Teamwork Runtime Engine.
 * Conforms strictly to ORIGINAL_REQUEST.md R3 và PROJECT.md.
 *
 * Requirements:
 * 1. Strict Line Count Constraint: Output MUST be strictly <= 20 lines under all scenarios.
 * 2. Mandatory Components:
 *    - Overall status (COMPLETED, BLOCKED_429, FAILED).
 *    - Milestones completed vs blocked.
 *    - Modified files with diff stats (+/- lines).
 *    - Real test verification commands and results.
 *    - Direct reference / link to teamwork/PROGRESS.md.
 * 3. Zero Fabrication: Emits only verified real results and exits.
 */

import { FileChangeStat, Milestone, ProgressMilestoneRow } from './types';

export interface VerificationSummaryItem {
  command: string;
  exitCode?: number | null;
  verdict?: string;
  passed?: number;
  failed?: number;
  output?: string;
}

export interface SummaryOptions {
  /** Overall execution status */
  status: 'COMPLETED' | 'BLOCKED_429' | 'FAILED' | string;
  /** List of milestones executed or planned */
  milestones?: Array<
    | Milestone
    | ProgressMilestoneRow
    | { id?: string; milestoneId?: string; title?: string; status?: string; criticVerdict?: string; attempts?: string }
  >;
  /** Changed files as list of paths or diff stat objects */
  changedFiles?: Array<string | FileChangeStat>;
  /** Test commands executed and their real outcomes */
  testResults?: Array<VerificationSummaryItem | string> | string;
  /** Relative or absolute path to PROGRESS.md (defaults to 'teamwork/PROGRESS.md') */
  progressFilePath?: string;
  /** Optional reason explaining blockage or failure */
  blockReason?: string;
  /** Optional total duration in milliseconds */
  durationMs?: number;
}

/**
 * Formats a single milestone entry concisely.
 */
function formatMilestoneEntry(
  m: Milestone | ProgressMilestoneRow | { id?: string; milestoneId?: string; title?: string; status?: string; criticVerdict?: string },
): string {
  const id = ('id' in m ? m.id : undefined) || ('milestoneId' in m ? m.milestoneId : undefined) || 'M';
  const status = m.status || 'todo';
  const verdict = m.criticVerdict ? ` [Critic: ${m.criticVerdict}]` : '';
  return `  - ${id}: ${status}${verdict}`;
}

/**
 * Formats a single file change entry concisely.
 */
function formatFileStatEntry(file: string | FileChangeStat): string {
  if (typeof file === 'string') {
    return `  - \`${file}\``;
  }
  return `  - \`${file.file}\`: +${file.additions} / -${file.deletions}`;
}

/**
 * Formats a single verification command result.
 * `output` (nếu có) được rút thành preview 1 dòng — trước đây field này bị bỏ qua
 * hoàn toàn nên output thực của lệnh verify không bao giờ xuất hiện trong summary.
 */
function formatVerificationEntry(res: VerificationSummaryItem | string): string {
  if (typeof res === 'string') {
    return `  - ${res}`;
  }
  const cmd = res.command ? `\`${res.command}\`` : 'test';
  const exitStr = res.exitCode !== undefined && res.exitCode !== null ? ` (exit ${res.exitCode})` : '';
  const verdict = res.verdict ? ` -> ${res.verdict}` : '';
  const counts =
    res.passed !== undefined || res.failed !== undefined
      ? ` [passed: ${res.passed ?? 0}, failed: ${res.failed ?? 0}]`
      : '';
  const preview = res.output ? ` | ${res.output.replace(/\s+/g, ' ').trim().slice(0, 120)}` : '';
  return `  - ${cmd}${verdict}${exitStr}${counts}${preview}`;
}

/**
 * Generates a compact markdown summary strictly <= 20 lines.
 */
export function generateCompletionSummary(options: SummaryOptions): string {
  const status = (options.status || 'COMPLETED').toUpperCase();
  const progressPath = options.progressFilePath || 'teamwork/PROGRESS.md';

  const milestones = options.milestones || [];
  const changedFiles = options.changedFiles || [];
  let testResults: Array<VerificationSummaryItem | string> = [];
  if (typeof options.testResults === 'string') {
    testResults = [options.testResults];
  } else if (Array.isArray(options.testResults)) {
    testResults = options.testResults;
  }

  // Count milestones completion
  const totalMilestones = milestones.length;
  const completedMilestones = milestones.filter(
    (m) => m.status === 'done' || m.criticVerdict === 'PASS',
  ).length;

  // Header and status lines (3 lines)
  const headerLines: string[] = [
    `### Teamwork Execution Summary: ${status}`,
    `- Status: ${status}${options.durationMs ? ` (${(options.durationMs / 1000).toFixed(1)}s)` : ''}`,
  ];

  if (options.blockReason) {
    headerLines.push(`- Reason: ${options.blockReason}`);
  }

  // Calculate dynamic budgets for the remaining sections
  // Total available lines = 20
  // Reserved: headerLines (2 or 3) + section titles (3) + progressLink (1) = 6 or 7 lines reserved
  const reservedLines = headerLines.length + 4; // sections titles + footer
  const contentBudget = Math.max(6, 20 - reservedLines);

  // Distribute budget among milestones, files, and tests
  const mBudget = Math.min(milestones.length, Math.max(1, Math.floor(contentBudget * 0.35)));
  const fBudget = Math.min(changedFiles.length, Math.max(1, Math.floor(contentBudget * 0.35)));
  const tBudget = Math.min(testResults.length, Math.max(1, contentBudget - mBudget - fBudget));

  const bodyLines: string[] = [];

  // 1. Milestones section
  if (milestones.length > 0) {
    bodyLines.push(`- Milestones (${completedMilestones}/${totalMilestones} done):`);
    const slice = milestones.slice(0, mBudget);
    for (const m of slice) {
      bodyLines.push(formatMilestoneEntry(m));
    }
    const remM = milestones.length - slice.length;
    if (remM > 0) {
      bodyLines.push(`  ... (+${remM} more)`);
    }
  } else {
    bodyLines.push('- Milestones: none recorded');
  }

  // 2. Changed Files section
  if (changedFiles.length > 0) {
    bodyLines.push(`- Changed Files (${changedFiles.length}):`);
    const slice = changedFiles.slice(0, fBudget);
    for (const f of slice) {
      bodyLines.push(formatFileStatEntry(f));
    }
    const remF = changedFiles.length - slice.length;
    if (remF > 0) {
      bodyLines.push(`  ... (+${remF} more)`);
    }
  } else {
    bodyLines.push('- Changed Files: 0 files modified');
  }

  // 3. Verifications section
  if (testResults.length > 0) {
    bodyLines.push('- Verifications:');
    const slice = testResults.slice(0, tBudget);
    for (const t of slice) {
      bodyLines.push(formatVerificationEntry(t));
    }
    const remT = testResults.length - slice.length;
    if (remT > 0) {
      bodyLines.push(`  ... (+${remT} more)`);
    }
  } else {
    bodyLines.push('- Verifications: none recorded');
  }

  // Footer link
  const footerLine = `Full report: ${progressPath}`;

  // Assemble full candidate list
  let allLines = [...headerLines, ...bodyLines, footerLine];

  // Invariant guarantee: strictly <= 20 lines
  if (allLines.length > 20) {
    // Trim from middle content, keeping header and footer
    const trimmed = allLines.slice(0, 19);
    trimmed.push(footerLine);
    allLines = trimmed;
  }

  return allLines.join('\n');
}
