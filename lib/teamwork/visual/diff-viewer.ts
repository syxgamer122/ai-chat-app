/**
 * Unified diff viewer with LCS diff calculation, hunk grouping,
 * syntax context, danger pattern detection, and terminal/markdown rendering.
 */

import type { VisualDiffOptions, VisualDiffResult, DiffHunk } from './types';

// ANSI terminal color codes
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

export class DiffViewer {
  /**
   * Computes unified diff between two text contents.
   */
  public static renderUnifiedDiff(
    filePath: string,
    oldContent: string | null,
    newContent: string,
    options?: VisualDiffOptions
  ): VisualDiffResult {
    const isOldBinary = oldContent !== null && this.isBinaryString(oldContent);
    const isNewBinary = this.isBinaryString(newContent);

    if (isOldBinary || isNewBinary) {
      const summary = `Binary file changed: ${filePath}`;
      return {
        filePath,
        additions: 0,
        deletions: 0,
        totalChanges: 0,
        diffText: `Binary files differ: ${filePath}`,
        hunks: [],
        isBinary: true,
        dangerFlags: ['Binary file modification detected'],
        summary,
      };
    }

    const maxLines = options?.maxLines ?? 1000;
    const contextLines = options?.contextLines ?? 3;
    const useColor = Boolean(options?.color);
    const detectDanger = options?.detectDanger ?? true;
    // Trước đây cờ này bị bỏ qua hoàn toàn.
    const showHunkHeaders = options?.showHunkHeaders !== false;

    const oldLines = oldContent !== null ? oldContent.split(/\r?\n/) : [];
    const newLines = newContent.split(/\r?\n/);

    // Compute edit script using Longest Common Subsequence (LCS)
    const edits = this.computeLcsEdits(oldLines, newLines);

    let additions = 0;
    let deletions = 0;
    const dangerFlags: string[] = [];

    // Count additions & deletions and check for danger flags
    for (const edit of edits) {
      if (edit.type === 'add') {
        additions++;
      } else if (edit.type === 'del') {
        deletions++;
        if (detectDanger) {
          const danger = this.checkDangerLine(edit.line, edit.oldIndex);
          if (danger && !dangerFlags.includes(danger)) {
            dangerFlags.push(danger);
          }
        }
      }
    }

    // Group edits into hunks with context
    const hunks = this.buildHunks(edits, contextLines);

    // Render diff text
    const diffLines: string[] = [];
    const aHeader = `--- a/${filePath}`;
    const bHeader = `+++ b/${filePath}`;

    if (useColor) {
      diffLines.push(`${ANSI.bold}${aHeader}${ANSI.reset}`);
      diffLines.push(`${ANSI.bold}${bHeader}${ANSI.reset}`);
    } else {
      diffLines.push(aHeader);
      diffLines.push(bHeader);
    }

    let emittedLinesCount = 2;
    let truncated = false;

    for (const hunk of hunks) {
      if (emittedLinesCount >= maxLines) {
        truncated = true;
        break;
      }

      if (showHunkHeaders) {
        const hunkHeader = hunk.header;
        diffLines.push(useColor ? `${ANSI.cyan}${hunkHeader}${ANSI.reset}` : hunkHeader);
        emittedLinesCount++;
      }

      for (const line of hunk.lines) {
        if (emittedLinesCount >= maxLines) {
          truncated = true;
          break;
        }

        if (useColor) {
          if (line.startsWith('+')) {
            diffLines.push(`${ANSI.green}${line}${ANSI.reset}`);
          } else if (line.startsWith('-')) {
            diffLines.push(`${ANSI.red}${line}${ANSI.reset}`);
          } else {
            diffLines.push(`${ANSI.gray}${line}${ANSI.reset}`);
          }
        } else {
          diffLines.push(line);
        }
        emittedLinesCount++;
      }
    }

    if (truncated) {
      const truncateNotice = `... [diff truncated at ${maxLines} lines]`;
      diffLines.push(useColor ? `${ANSI.yellow}${truncateNotice}${ANSI.reset}` : truncateNotice);
    }

    const summary = `${filePath} (+${additions}, -${deletions})`;

    return {
      filePath,
      additions,
      deletions,
      totalChanges: additions + deletions,
      diffText: diffLines.join('\n'),
      hunks,
      isBinary: false,
      dangerFlags,
      summary,
    };
  }

  /**
   * Helper implementing LCS edit computation.
   */
  private static computeLcsEdits(
    oldLines: string[],
    newLines: string[]
  ): Array<{ type: 'eq' | 'add' | 'del'; line: string; oldIndex: number; newIndex: number }> {
    const m = oldLines.length;
    const n = newLines.length;

    // Standard LCS table (optimizing memory for fast comparison)
    // If matrix size is within bounds (< 25,000,000 cells)
    if (m * n <= 25_000_000) {
      const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          if (oldLines[i - 1] === newLines[j - 1]) {
            dp[i][j] = dp[i - 1][j - 1] + 1;
          } else {
            dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
          }
        }
      }

      // Backtrack to form edits
      let i = m;
      let j = n;
      const reversedEdits: Array<{ type: 'eq' | 'add' | 'del'; line: string; oldIndex: number; newIndex: number }> = [];

      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
          reversedEdits.push({ type: 'eq', line: oldLines[i - 1], oldIndex: i, newIndex: j });
          i--;
          j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
          reversedEdits.push({ type: 'add', line: newLines[j - 1], oldIndex: i, newIndex: j });
          j--;
        } else if (i > 0) {
          reversedEdits.push({ type: 'del', line: oldLines[i - 1], oldIndex: i, newIndex: j });
          i--;
        }
      }

      return reversedEdits.reverse();
    }

    // Fallback for massive line arrays: greedy linear matching
    const edits: Array<{ type: 'eq' | 'add' | 'del'; line: string; oldIndex: number; newIndex: number }> = [];
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && oldLines[i] === newLines[j]) {
        edits.push({ type: 'eq', line: oldLines[i], oldIndex: i + 1, newIndex: j + 1 });
        i++;
        j++;
      } else {
        if (i < m) {
          edits.push({ type: 'del', line: oldLines[i], oldIndex: i + 1, newIndex: j + 1 });
          i++;
        }
        if (j < n) {
          edits.push({ type: 'add', line: newLines[j], oldIndex: i, newIndex: j + 1 });
          j++;
        }
      }
    }
    return edits;
  }

  /**
   * Groups linear edits into contextual hunks.
   */
  private static buildHunks(
    edits: Array<{ type: 'eq' | 'add' | 'del'; line: string; oldIndex: number; newIndex: number }>,
    contextSize: number
  ): DiffHunk[] {
    if (edits.length === 0) return [];

    // Find ranges of modifications
    const hunks: DiffHunk[] = [];
    let hunkEdits: typeof edits = [];
    let lastChangeIndex = -1;

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      if (edit.type !== 'eq') {
        // We have a modification
        if (hunkEdits.length === 0) {
          // Prepend leading context
          const startContext = Math.max(0, i - contextSize);
          hunkEdits = edits.slice(startContext, i + 1);
        } else {
          // Add intervening lines up to this change
          const intervening = edits.slice(lastChangeIndex + 1, i + 1);
          hunkEdits.push(...intervening);
        }
        lastChangeIndex = i;
      } else if (hunkEdits.length > 0) {
        // Inside a hunk, check if we exceeded trailing context
        if (i - lastChangeIndex <= contextSize) {
          hunkEdits.push(edit);
        } else {
          // Finalize current hunk
          hunks.push(this.formatHunk(hunkEdits));
          hunkEdits = [];
        }
      }
    }

    if (hunkEdits.length > 0) {
      hunks.push(this.formatHunk(hunkEdits));
    }

    return hunks;
  }

  private static formatHunk(
    edits: Array<{ type: 'eq' | 'add' | 'del'; line: string; oldIndex: number; newIndex: number }>
  ): DiffHunk {
    let oldLines = 0;
    let newLines = 0;
    const lines: string[] = [];

    for (const e of edits) {
      if (e.type === 'eq') {
        oldLines++;
        newLines++;
        lines.push(` ${e.line}`);
      } else if (e.type === 'del') {
        oldLines++;
        lines.push(`-${e.line}`);
      } else if (e.type === 'add') {
        newLines++;
        lines.push(`+${e.line}`);
      }
    }

    // Derive the hunk offsets from the first line that exists in each file.
    // Using `0` as an "unset" sentinel (the previous approach) forced every pure-addition
    // hunk to `-1,0` and every pure-deletion hunk to `+1,0`, losing the real offsets.
    const firstOld = edits.find((e) => e.type === 'eq' || e.type === 'del');
    const firstNew = edits.find((e) => e.type === 'eq' || e.type === 'add');
    const oldStart = firstOld ? firstOld.oldIndex : edits[0]?.oldIndex ?? 0;
    const newStart = firstNew ? firstNew.newIndex : edits[0]?.newIndex ?? 0;

    const header = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`;
    return {
      oldStart,
      oldLines,
      newStart,
      newLines,
      header,
      lines,
    };
  }

  private static checkDangerLine(line: string, lineNumber: number): string | null {
    const lower = line.toLowerCase();
    if (lower.includes('apikey') || lower.includes('api_key') || lower.includes('secret') || lower.includes('password') || lower.includes('auth_token')) {
      return `Potential secret/key deletion detected at line ${lineNumber}`;
    }
    if (lower.includes('rm -rf') || lower.includes('drop table') || lower.includes('delete from') || lower.includes('truncate table')) {
      return `Destructive command deletion at line ${lineNumber}`;
    }
    if (lower.includes('process.exit(')) {
      return `Process termination call deletion at line ${lineNumber}`;
    }
    if (lower.includes('chmod 777') || lower.includes('eval(')) {
      return `Sensitive security pattern modification at line ${lineNumber}`;
    }
    return null;
  }

  private static isBinaryString(content: string): boolean {
    if (content.length > 5000000) return false;
    // Check first 8000 bytes for null character
    const checkLength = Math.min(content.length, 8000);
    for (let i = 0; i < checkLength; i++) {
      if (content.charCodeAt(i) === 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Conforms to PROJECT.md interface VisualDiffVisualizer
   */
  public renderDiff(oldContent: string | null, newContent: string, options?: VisualDiffOptions): string {
    return DiffViewer.renderUnifiedDiff('diff', oldContent, newContent, options).diffText;
  }
}
