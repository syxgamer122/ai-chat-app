/**
 * Adversarial Critic Verifier for Teamwork Multi-Agent Runtime Engine.
 * Conforms strictly to ORIGINAL_REQUEST.md R1 & R3 và PROJECT.md.
 *
 * Implements:
 * 1. Zero-Trust Verification: Re-runs real test/build commands independently via HeadlessToolRunner.
 * 2. Exit Code & Output Auditing: Captures real exit codes, stdout, stderr, and failure signatures.
 * 3. Multi-Level Integrity Mode Enforcement:
 *    - 'development': blocks dummy empty facades, stubs, and fabricated outputs.
 *    - 'demo': also blocks open-source copy-paste and test assertion reverse-engineering.
 *    - 'benchmark': strictly enforces clean-room standard library only (no third-party imports).
 * 4. Structured Remediation Feedback: Generates precise guidance for worker retries upon FAIL-BLOCKED.
 */

import { HeadlessToolRunner } from './tools';
import {
  CriticIssue,
  CriticResult,
  CriticVerdict,
  IntegrityMode,
  Milestone,
} from './types';

/**
 * Node.js built-in standard library modules permitted in 'benchmark' mode.
 */
const NODE_STDLIB_MODULES = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'test',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

/**
 * Formats command output preview by cleaning and truncating to a readable length.
 */
export function formatOutputPreview(rawOutput: string, maxLines: number = 30): string {
  if (!rawOutput || !rawOutput.trim()) {
    return '(no output recorded)';
  }
  const lines = rawOutput.split(/\r?\n/);
  if (lines.length <= maxLines) {
    return lines.join('\n').trim();
  }
  const half = Math.floor(maxLines / 2);
  const head = lines.slice(0, half);
  const tail = lines.slice(-half);
  const omitted = lines.length - maxLines;
  return [...head, `... [${omitted} lines omitted] ...`, ...tail].join('\n').trim();
}

/**
 * Audits a unified git diff against the integrity mode rubric.
 * Blocks empty facades, stub implementations, copy-paste licenses, or unauthorized libraries.
 */
export function auditDiffForIntegrity(
  diffText: string,
  integrityMode: IntegrityMode = 'development',
  ownedFiles?: string[],
): CriticIssue[] {
  const issues: CriticIssue[] = [];
  if (!diffText || !diffText.trim()) {
    return issues;
  }

  // Parse diff into per-file chunks
  const fileDiffs: Array<{ filePath: string; addedLines: string[]; addedChunk: string }> = [];
  const lines = diffText.split(/\r?\n/);
  let currentFile = '';
  let currentAdded: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('+++ b/')) {
      if (currentFile && currentAdded.length > 0) {
        fileDiffs.push({
          filePath: currentFile,
          addedLines: [...currentAdded],
          addedChunk: currentAdded.join('\n'),
        });
      }
      currentFile = line.slice(6).trim();
      currentAdded = [];
    } else if (line.startsWith('--- a/') && !currentFile) {
      currentFile = line.slice(6).trim();
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      currentAdded.push(line.slice(1));
    }
  }
  if (currentFile && currentAdded.length > 0) {
    fileDiffs.push({
      filePath: currentFile,
      addedLines: [...currentAdded],
      addedChunk: currentAdded.join('\n'),
    });
  }

  // Common code extensions to audit for logic facades (ignore pure markdown/json documentation)
  const CODE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|c|cpp|java|rb|php)$/i;

  for (const { filePath, addedLines, addedChunk } of fileDiffs) {
    const isCodeFile = CODE_EXT_RE.test(filePath);

    // If milestone specifies ownedFiles, check if modifications occurred in assigned scope
    if (ownedFiles && ownedFiles.length > 0) {
      const normalizedPath = filePath.replace(/\\/g, '/');
      const isOwned = ownedFiles.some((f) => {
        const norm = f.replace(/\\/g, '/');
        return normalizedPath === norm || normalizedPath.endsWith(`/${norm}`) || norm.endsWith(`/${normalizedPath}`);
      });
      // Non-owned files with code modifications may indicate an ownership leak
      if (!isOwned && isCodeFile) {
        issues.push({
          severity: 'major',
          fileLocation: filePath,
          description: `Code modifications detected in unassigned file "${filePath}" outside milestone ownedFiles scope.`,
          reproduction: `Check file ownership declarations in milestone configuration.`,
        });
      }
    }

    if (!isCodeFile) {
      continue;
    }

    // ------------------------------------------------------------------------
    // Check A: Development Mode Rubric (Blocks dummy empty facades & stubs)
    // ------------------------------------------------------------------------

    // 1. Stub comments
    const stubCommentMatch = addedChunk.match(
      /\/\/\s*(?:TODO:?\s*implement|stub|dummy\s*facade|placeholder\s*logic|mock\s*for\s*test|fake\s*implementation)\b/i,
    );
    if (stubCommentMatch) {
      issues.push({
        severity: 'blocker',
        fileLocation: filePath,
        description: `Integrity violation: dummy stub comment detected ("${stubCommentMatch[0].trim()}"). Genuine logic must be implemented.`,
        reproduction: `Inspect added lines in ${filePath} containing stub annotations.`,
      });
    }

    // 2. Empty function declarations: function foo() {} or async function foo() {}
    const emptyFnMatch = addedChunk.match(
      /(?:async\s+)?function\s*([a-zA-Z0-9_$]*)\s*\([^)]*\)\s*\{\s*\}/,
    );
    if (emptyFnMatch) {
      const fnName = emptyFnMatch[1] || 'anonymous';
      issues.push({
        severity: 'blocker',
        fileLocation: filePath,
        description: `Integrity violation: empty function facade detected ("${fnName}"). Empty bodies created to bypass typechecks are forbidden.`,
        reproduction: `Inspect function definition "${emptyFnMatch[0]}" in ${filePath}.`,
      });
    }

    // 3. Empty arrow function bodies: const foo = () => {} or foo = () => {}
    const emptyArrowMatch = addedChunk.match(
      /(?:const|let|var)?\s*([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*:\s*[a-zA-Z0-9_<>[\]|&\s]+\s*=>\s*\{\s*\}|(?:const|let|var)?\s*([a-zA-Z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*\}/,
    );
    if (emptyArrowMatch) {
      const varName = emptyArrowMatch[1] || emptyArrowMatch[2] || 'arrow function';
      issues.push({
        severity: 'blocker',
        fileLocation: filePath,
        description: `Integrity violation: empty arrow function facade detected for "${varName}".`,
        reproduction: `Inspect arrow function assignment in ${filePath}.`,
      });
    }

    // 4. Methods or functions throwing "not implemented" / "TODO"
    const notImplementedMatch = addedChunk.match(
      /throw\s+new\s+Error\s*\(\s*['"`](?:not\s+implemented|TODO|stub|dummy|mock)['"`]\s*\)/i,
    );
    if (notImplementedMatch) {
      issues.push({
        severity: 'blocker',
        fileLocation: filePath,
        description: `Integrity violation: "not implemented" exception thrown (${notImplementedMatch[0]}).`,
        reproduction: `Remove placeholder throw in ${filePath} and implement required behavior.`,
      });
    }

    // 5. Blatant trivial dummy returns in standalone functions: { return null; } or { return ""; }
    const trivialReturnMatch = addedChunk.match(
      /(?:function\s+[a-zA-Z0-9_$]+\s*\([^)]*\)|=>)\s*\{\s*return\s+(?:null|undefined|""|''|false)\s*;?\s*\}/,
    );
    if (trivialReturnMatch) {
      issues.push({
        severity: 'blocker',
        fileLocation: filePath,
        description: `Integrity violation: trivial stub return detected ("${trivialReturnMatch[0]}"). Implement substantive logic.`,
        reproduction: `Inspect ${filePath} around stub return construct.`,
      });
    }

    // ------------------------------------------------------------------------
    // Check B: Demo Mode Rubric (Blocks OSS copy-paste & test reverse engineering)
    // ------------------------------------------------------------------------
    if (integrityMode === 'demo' || integrityMode === 'benchmark') {
      // 1. OSS License headers or external repo copy markers
      const licenseMatch = addedChunk.match(
        /SPDX-License-Identifier|Licensed\s+under\s+the\s+Apache\s+License|GNU\s+General\s+Public\s+License|https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/i,
      );
      if (licenseMatch) {
        issues.push({
          severity: 'blocker',
          fileLocation: filePath,
          description: `Integrity violation in ${integrityMode} mode: external open-source copy-paste signature detected ("${licenseMatch[0]}").`,
          reproduction: `Remove copied third-party code in ${filePath} and write original implementation.`,
        });
      }

      // 2. Explicit reverse-engineering from test assertion markers
      const testSpoofMatch = addedChunk.match(
        /\/\/\s*(?:copied\s*from\s*test|hardcoded\s*for\s*test|reverse-engineered\s*from\s*test|test\s*assert\s*constant)/i,
      );
      if (testSpoofMatch) {
        issues.push({
          severity: 'blocker',
          fileLocation: filePath,
          description: `Integrity violation in ${integrityMode} mode: hardcoded test reverse-engineering marker detected.`,
          reproduction: `Ensure implementation solves general problem rather than matching specific test constants.`,
        });
      }
    }

    // ------------------------------------------------------------------------
    // Check C: Benchmark Mode Rubric (Strictly clean-room standard library only)
    // ------------------------------------------------------------------------
    if (integrityMode === 'benchmark') {
      for (const line of addedLines) {
        // Match import ... from 'package' or require('package')
        const importMatch =
          line.match(/\bfrom\s+['"]([^'"]+)['"]/) ||
          line.match(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/);

        if (importMatch) {
          const mod = importMatch[1].trim();

          // Allowed: relative imports, workspace alias '@/...', and node standard library
          const isRelative = mod.startsWith('.') || mod.startsWith('@/') || mod.startsWith('~/');
          const isNodePrefixed = mod.startsWith('node:');
          const bareName = mod.replace(/^node:/, '').split('/')[0];
          const isNodeStdlib = NODE_STDLIB_MODULES.has(bareName);

          if (!isRelative && !isNodePrefixed && !isNodeStdlib) {
            issues.push({
              severity: 'blocker',
              fileLocation: filePath,
              description: `Integrity violation in benchmark mode: unauthorized third-party library import "${mod}". Benchmark mode permits standard library only.`,
              reproduction: `Replace third-party package "${mod}" in ${filePath} with Node standard library or custom implementation.`,
            });
          }
        }
      }
    }
  }

  return issues;
}

/**
 * Builds structured, actionable remediation feedback for worker retry if FAIL-BLOCKED.
 */
export function buildRemediationFeedback(
  issues: CriticIssue[],
  command: string,
  exitCode: number | null,
  outputPreview: string,
): string {
  const lines: string[] = [];
  lines.push('### Critic Remediation Guidance');
  lines.push('');

  if (exitCode !== 0) {
    lines.push(`- **Command Failure**: \`${command}\` exited with code ${exitCode ?? 'null'}.`);
    lines.push('  Examine the test error output and resolve failing assertions or compilation errors.');
  }

  const blockers = issues.filter((i) => i.severity === 'blocker');
  if (blockers.length > 0) {
    lines.push('');
    lines.push('**Blocking Integrity Issues:**');
    for (const b of blockers) {
      lines.push(`- [${b.fileLocation}] ${b.description}`);
      if (b.reproduction) {
        lines.push(`  *Action*: ${b.reproduction}`);
      }
    }
  }

  const majors = issues.filter((i) => i.severity === 'major');
  if (majors.length > 0) {
    lines.push('');
    lines.push('**Major Issues:**');
    for (const m of majors) {
      lines.push(`- [${m.fileLocation}] ${m.description}`);
    }
  }

  lines.push('');
  lines.push('**Conditions for PASS on Next Attempt:**');
  lines.push(`1. \`${command}\` must execute and exit with code 0.`);
  lines.push('2. All empty facades, stubs, or unauthorized imports must be replaced with genuine logic.');
  lines.push('3. No hardcoded or fabricated outputs.');

  return lines.join('\n');
}

/**
 * TeamworkCritic class implementing adversarial independent verification.
 */
export class TeamworkCritic {
  constructor(private readonly tools: HeadlessToolRunner) {
    if (!tools) {
      throw new Error('TeamworkCritic requires a valid HeadlessToolRunner instance.');
    }
  }

  public getTools(): HeadlessToolRunner {
    return this.tools;
  }

  /**
   * Executes milestone verification with zero-trust shell execution and git diff audit.
   * Emits CriticResult with verdict 'PASS' or 'FAIL-BLOCKED'.
   */
  public async verifyMilestone(
    milestone: Milestone,
    integrityMode: IntegrityMode = 'development',
  ): Promise<CriticResult> {
    const issues: CriticIssue[] = [];
    const command = milestone.verifyCommand ? milestone.verifyCommand.trim() : '';

    // 1. Check if verify command is provided
    if (!command) {
      const issue: CriticIssue = {
        severity: 'blocker',
        fileLocation: milestone.id || 'milestone',
        description: `Milestone "${milestone.id}" does not specify a verifyCommand.`,
        reproduction: 'Specify milestone.verifyCommand with a valid test/build command.',
      };
      issues.push(issue);

      return {
        verdict: 'FAIL-BLOCKED',
        command: '',
        exitCode: null,
        outputPreview: 'No verifyCommand specified in milestone.',
        issues,
        passCriteriaMet: false,
        remediation: buildRemediationFeedback(issues, '', null, ''),
      };
    }

    // 2. Zero-Trust Shell Execution: Captures real exit code and stdout/stderr
    const shellResult = await this.tools.shellRun(command);
    const combinedOutput = [shellResult.stdout, shellResult.stderr].filter(Boolean).join('\n');
    const outputPreview = formatOutputPreview(combinedOutput);

    // 3. Check shell exit code
    if (shellResult.code !== 0) {
      issues.push({
        severity: 'blocker',
        fileLocation: milestone.id || command,
        description: `Verification command "${command}" failed with exit code ${shellResult.code ?? 'null'}.`,
        reproduction: `Run \`${command}\` in workspace to reproduce failure.`,
      });
    }

    // 4. Inspect Git Diff against Integrity Mode Rubric
    let diffText = '';
    try {
      // Check unstaged and staged diffs
      const workingDiff = await this.tools.gitDiff();
      const stagedDiff = await this.tools.gitDiff(undefined, true);
      diffText = [workingDiff, stagedDiff].filter(Boolean).join('\n');
    } catch {
      // In non-git workspace, fallback gracefully
      diffText = '';
    }

    const integrityIssues = auditDiffForIntegrity(
      diffText,
      integrityMode,
      milestone.ownedFiles,
    );
    issues.push(...integrityIssues);

    // 5. Evaluate Verdict
    const hasBlockers = issues.some((i) => i.severity === 'blocker' || i.severity === 'major');
    const exitZero = shellResult.code === 0;

    let verdict: CriticVerdict = 'PASS';
    let passCriteriaMet = true;
    let remediation: string | undefined = undefined;

    if (!exitZero || hasBlockers) {
      verdict = 'FAIL-BLOCKED';
      passCriteriaMet = false;
      remediation = buildRemediationFeedback(issues, command, shellResult.code, outputPreview);
    }

    return {
      verdict,
      command,
      exitCode: shellResult.code,
      outputPreview,
      issues,
      passCriteriaMet,
      remediation,
    };
  }
}
