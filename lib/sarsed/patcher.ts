/**
 * Sarsed-Code Transactional Semantic Patcher.
 *
 * Provides industrial-grade multi-hunk code patching:
 * 1. Indentation auto-alignment (adapts replace block indentation to match file indentation).
 * 2. Whitespace-resilient matching (CRLF/LF, trailing spaces, tabs vs spaces).
 * 3. Atomic Multi-Hunk Application (all hunks in a patch must succeed or entire file rolls back).
 * 4. Transactional Snapshot Rollback History.
 * 5. Detailed Hunk Diagnostics with line numbers and expected vs actual content.
 */

import { lineDiff, renderUnifiedDiff } from '@/lib/naive-diff';
import type { HunkApplyResult, PatchResult, SemanticHunk, SemanticPatch } from './types';

export class SarsedPatcher {
  private rollbackSnapshots: Map<string, string[]> = new Map();

  /**
   * Apply a multi-hunk semantic patch to file content.
   */
  applyPatch(
    filePath: string,
    originalContent: string,
    patch: SemanticPatch,
  ): PatchResult {
    const isAtomic = patch.atomic !== false;
    let currentContent = originalContent;
    const hunkResults: HunkApplyResult[] = [];
    let hunksApplied = 0;

    // Save snapshot for rollback
    this.saveSnapshot(filePath, originalContent);

    for (let i = 0; i < patch.hunks.length; i++) {
      const hunk = patch.hunks[i];
      const result = this.applySingleHunk(currentContent, hunk, i);

      hunkResults.push(result);

      if (result.applied && result.newContent !== undefined) {
        currentContent = result.newContent;
        hunksApplied++;
      } else {
        // Hunk failed
        if (isAtomic) {
          // Atomic rollback: restore original content completely
          return {
            success: false,
            file: filePath,
            hunksApplied: 0,
            totalHunks: patch.hunks.length,
            hunkResults,
            error: `Hunk #${i + 1} failed: ${result.error}. Atomic patch rolled back completely.`,
            originalContent,
            modifiedContent: originalContent,
          };
        }
      }
    }

    const allSucceeded = hunksApplied === patch.hunks.length;
    const diffLines = lineDiff(originalContent, currentContent);
    const diff = renderUnifiedDiff(diffLines).text;

    return {
      success: allSucceeded,
      file: filePath,
      hunksApplied,
      totalHunks: patch.hunks.length,
      hunkResults,
      originalContent,
      modifiedContent: currentContent,
      diff,
      error: allSucceeded ? undefined : `Applied ${hunksApplied}/${patch.hunks.length} hunks.`,
    };
  }

  /**
   * Apply a single hunk with multi-tiered matching:
   * 1. Exact match.
   * 2. Indentation-normalized match.
   * 3. Whitespace-trimmed line-by-line match.
   */
  private applySingleHunk(
    content: string,
    hunk: SemanticHunk,
    hunkIndex: number,
  ): HunkApplyResult & { newContent?: string } {
    const isCrlf = content.includes('\r\n');
    const eol = isCrlf ? '\r\n' : '\n';

    // Normalize hunk line endings to match file's line ending convention
    const searchRaw = isCrlf
      ? hunk.search.replace(/\r?\n/g, '\r\n')
      : hunk.search.replace(/\r\n/g, '\n');
    const replaceRaw = isCrlf
      ? hunk.replace.replace(/\r?\n/g, '\r\n')
      : hunk.replace.replace(/\r\n/g, '\n');

    if (!searchRaw.trim()) {
      return {
        hunkIndex,
        applied: false,
        error: 'Search block is empty.',
      };
    }

    // Tier 1: Exact Match (using literal slice to prevent $& and $$ corruption)
    if (content.includes(searchRaw)) {
      const occurrences = content.split(searchRaw).length - 1;
      if (occurrences === 1) {
        const idx = content.indexOf(searchRaw);
        const lineNum = content.slice(0, idx).split(/\r?\n/).length;

        // Auto-align multiline replacement with leading line indentation if target is indented
        let effectiveReplace = replaceRaw;
        const lineStart = content.lastIndexOf('\n', idx);
        const leadingOnLine = content.slice(lineStart === -1 ? 0 : lineStart + 1, idx);
        const isLeadingWhitespace = /^[ \t]+$/.test(leadingOnLine);

        if (isLeadingWhitespace && replaceRaw.includes('\n')) {
          const replaceLines = replaceRaw.split(/\r?\n/);
          effectiveReplace = replaceLines
            .map((line, i) => {
              if (i === 0 || !line.trim() || line.startsWith(leadingOnLine)) return line;
              return leadingOnLine + line;
            })
            .join(eol);
        }

        const newContent = content.slice(0, idx) + effectiveReplace + content.slice(idx + searchRaw.length);
        return {
          hunkIndex,
          applied: true,
          matchedLine: lineNum,
          newContent,
        };
      }
      // If multiple exact matches, try line hint to disambiguate
      if (hunk.lineHint && hunk.lineHint > 0) {
        const resolved = this.replaceNearLineHint(content, searchRaw, replaceRaw, hunk.lineHint, eol);
        if (resolved) {
          return {
            hunkIndex,
            applied: true,
            matchedLine: resolved.matchedLine,
            newContent: resolved.newContent,
          };
        }
      }
    }

    // Tier 2: Indentation-Normalized Match
    const indentMatch = this.matchWithIndentationAlignment(content, searchRaw, replaceRaw, eol);
    if (indentMatch) {
      return {
        hunkIndex,
        applied: true,
        matchedLine: indentMatch.matchedLine,
        newContent: indentMatch.newContent,
      };
    }

    // Tier 3: Whitespace-Trimmed Line-by-Line Match
    const trimmedMatch = this.matchTrimmedLines(content, searchRaw, replaceRaw, eol);
    if (trimmedMatch) {
      return {
        hunkIndex,
        applied: true,
        matchedLine: trimmedMatch.matchedLine,
        newContent: trimmedMatch.newContent,
      };
    }

    return {
      hunkIndex,
      applied: false,
      error: `Could not locate unique target block in file. Search block starting with: "${searchRaw.trim().slice(0, 60)}"`,
    };
  }

  /**
   * Disambiguate multiple matches using lineHint.
   */
  private replaceNearLineHint(
    content: string,
    search: string,
    replace: string,
    lineHint: number,
    eol: string = '\n',
  ): { newContent: string; matchedLine: number } | null {
    let bestDist = Infinity;
    let bestIdx = -1;

    let searchIdx = content.indexOf(search);
    while (searchIdx !== -1) {
      const lineNum = content.slice(0, searchIdx).split(/\r?\n/).length;
      const dist = Math.abs(lineNum - lineHint);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = searchIdx;
      }
      searchIdx = content.indexOf(search, searchIdx + 1);
    }

    if (bestIdx !== -1) {
      const matchedLine = content.slice(0, bestIdx).split(/\r?\n/).length;
      let effectiveReplace = replace;
      const lineStart = content.lastIndexOf('\n', bestIdx);
      const leadingOnLine = content.slice(lineStart === -1 ? 0 : lineStart + 1, bestIdx);
      const isLeadingWhitespace = /^[ \t]+$/.test(leadingOnLine);

      if (isLeadingWhitespace && replace.includes('\n')) {
        const replaceLines = replace.split(/\r?\n/);
        effectiveReplace = replaceLines
          .map((line, i) => {
            if (i === 0 || !line.trim() || line.startsWith(leadingOnLine)) return line;
            return leadingOnLine + line;
          })
          .join(eol);
      }

      const newContent = content.slice(0, bestIdx) + effectiveReplace + content.slice(bestIdx + search.length);
      return { newContent, matchedLine };
    }

    return null;
  }

  /**
   * Match with indentation normalization:
   * Detects the leading indentation of the target block in content and adjusts replace block accordingly.
   */
  private matchWithIndentationAlignment(
    content: string,
    search: string,
    replace: string,
    eol: string = '\n',
  ): { newContent: string; matchedLine: number } | null {
    const contentLines = content.split(/\r?\n/);
    const searchLines = search.split(/\r?\n/);
    const replaceLines = replace.split(/\r?\n/);

    if (searchLines.length === 0) return null;

    // Detect base search indent
    const searchBaseIndent = this.getLeadingWhitespace(searchLines[0]);
    const trimmedSearchLines = searchLines.map((l) => l.trim());

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let matches = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trim() !== trimmedSearchLines[j]) {
          matches = false;
          break;
        }
      }

      if (matches) {
        // Found match at contentLines[i]
        const targetBaseIndent = this.getLeadingWhitespace(contentLines[i]);
        const isTabIndent = targetBaseIndent.includes('\t');
        const indentDiff = targetBaseIndent.length - searchBaseIndent.length;

        // Adjust replace lines indentation
        const adjustedReplaceLines = replaceLines.map((line) => {
          if (!line.trim()) return '';
          if (indentDiff > 0) {
            const padChar = isTabIndent ? '\t' : ' ';
            return padChar.repeat(indentDiff) + line;
          } else if (indentDiff < 0) {
            const removeCount = Math.min(-indentDiff, this.getLeadingWhitespace(line).length);
            return line.slice(removeCount);
          }
          return line;
        });

        const newLines = [
          ...contentLines.slice(0, i),
          ...adjustedReplaceLines,
          ...contentLines.slice(i + searchLines.length),
        ];

        return {
          newContent: newLines.join(eol),
          matchedLine: i + 1,
        };
      }
    }

    return null;
  }

  /**
   * Fallback line-by-line trimmed match.
   */
  private matchTrimmedLines(
    content: string,
    search: string,
    replace: string,
    eol: string = '\n',
  ): { newContent: string; matchedLine: number } | null {
    const contentLines = content.split(/\r?\n/);
    const searchLines = search.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const replaceLines = replace.split(/\r?\n/);

    if (searchLines.length === 0) return null;

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let matchedCount = 0;
      let curContentIdx = i;

      for (let j = 0; j < searchLines.length; j++) {
        // Skip empty content lines if search line is non-empty
        while (curContentIdx < contentLines.length && !contentLines[curContentIdx].trim()) {
          curContentIdx++;
        }
        if (curContentIdx >= contentLines.length) break;

        if (contentLines[curContentIdx].trim() === searchLines[j].trim()) {
          matchedCount++;
          curContentIdx++;
        } else {
          break;
        }
      }

      if (matchedCount === searchLines.length) {
        const newLines = [
          ...contentLines.slice(0, i),
          ...replaceLines,
          ...contentLines.slice(curContentIdx),
        ];
        return {
          newContent: newLines.join(eol),
          matchedLine: i + 1,
        };
      }
    }

    return null;
  }

  private getLeadingWhitespace(str: string): string {
    const match = str.match(/^([ \t]*)/);
    return match ? match[1] : '';
  }

  private saveSnapshot(filePath: string, content: string): void {
    const history = this.rollbackSnapshots.get(filePath) ?? [];
    history.push(content);
    if (history.length > 10) history.shift();
    this.rollbackSnapshots.set(filePath, history);
  }

  /**
   * Rollback file to last saved snapshot.
   */
  rollback(filePath: string): string | null {
    const history = this.rollbackSnapshots.get(filePath);
    if (history && history.length > 0) {
      return history.pop() ?? null;
    }
    return null;
  }
}
