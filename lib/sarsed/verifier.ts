/**
 * Sarsed-Code Automated Verification & Diagnostic Engine.
 *
 * Parses stdout/stderr from language tools (tsc, eslint, vitest, python, rust)
 * into structured `CodeDiagnostic` objects with exact file, line, col, severity, and message.
 */

import type { CodeDiagnostic, DiagnosticSeverity, VerificationResult } from './types';

export class SarsedVerifier {
  /**
   * Parse diagnostic output from arbitrary command execution.
   */
  parseDiagnostics(output: string, defaultSource: 'tsc' | 'eslint' | 'vitest' | 'compiler' = 'compiler'): CodeDiagnostic[] {
    const diagnostics: CodeDiagnostic[] = [];
    const lines = output.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 1. TypeScript Compiler (tsc) pattern:
      // filepath.ts(12,34): error TS2322: Type 'string' is not assignable to type 'number'.
      // or filepath.ts:12:34 - error TS2322: ...
      const tscMatch =
        line.match(/^((?:[a-zA-Z]:[\\/])?[a-zA-Z0-9_.\-\\/]+)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/) ||
        line.match(/^((?:[a-zA-Z]:[\\/])?[a-zA-Z0-9_.\-\\/]+):(\d+):(\d+)\s*-\s*(error|warning)\s+(TS\d+):\s*(.+)$/);

      if (tscMatch) {
        diagnostics.push({
          file: tscMatch[1].replace(/\\/g, '/'),
          line: parseInt(tscMatch[2], 10),
          column: parseInt(tscMatch[3], 10),
          severity: tscMatch[4].toLowerCase() as DiagnosticSeverity,
          code: tscMatch[5],
          message: tscMatch[6].trim(),
          source: 'tsc',
          rawSnippet: line,
        });
        continue;
      }

      // 2. ESLint pattern:
      //   12:5  error  'foo' is assigned a value but never used  @typescript-eslint/no-unused-vars
      // Preceded by filename line (e.g. /path/to/file.ts)
      const eslintLineMatch = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s\s+([a-zA-Z0-9_\-/@]+))?$/);
      if (eslintLineMatch) {
        // Look backwards for recent file line
        let currentFile = 'unknown';
        for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
          const candidate = lines[j].trim();
          if (candidate.match(/^(?:[a-zA-Z]:[\\/])?[a-zA-Z0-9_.\-\\/]+\.[a-zA-Z0-9]+$/)) {
            currentFile = candidate.replace(/\\/g, '/');
            break;
          }
        }

        diagnostics.push({
          file: currentFile,
          line: parseInt(eslintLineMatch[1], 10),
          column: parseInt(eslintLineMatch[2], 10),
          severity: eslintLineMatch[3].toLowerCase() as DiagnosticSeverity,
          message: eslintLineMatch[4].trim(),
          code: eslintLineMatch[5],
          source: 'eslint',
          rawSnippet: line,
        });
        continue;
      }

      // 3. Vitest / Jest test failure pattern:
      // FAIL tests/foo.test.ts > suite > test name
      // AssertionError: expected 1 to be 2
      const vitestFailMatch = line.match(/(?:FAIL|✕)\s+((?:[a-zA-Z]:[\\/])?[a-zA-Z0-9_.\-\\/]+\.test\.[a-zA-Z0-9]+)(?:\s*>\s*(.+))?/);
      if (vitestFailMatch) {
        diagnostics.push({
          file: vitestFailMatch[1].replace(/\\/g, '/'),
          line: 1,
          column: 1,
          severity: 'error',
          code: 'TEST_FAIL',
          message: vitestFailMatch[2] ? `Test failed: ${vitestFailMatch[2]}` : 'Test assertion failed',
          source: 'vitest',
          rawSnippet: line,
        });
        continue;
      }

      // 4. Python / Mypy pattern:
      // app.py:10: error: Incompatible types in assignment
      const pythonMatch = line.match(/^((?:[a-zA-Z]:[\\/])?[a-zA-Z0-9_.\-\\/]+\.py):(\d+):\s*(error|warning):\s*(.+)$/);
      if (pythonMatch) {
        diagnostics.push({
          file: pythonMatch[1].replace(/\\/g, '/'),
          line: parseInt(pythonMatch[2], 10),
          column: 1,
          severity: pythonMatch[3].toLowerCase() as DiagnosticSeverity,
          message: pythonMatch[4].trim(),
          source: 'compiler',
          rawSnippet: line,
        });
        continue;
      }

      // 5. Generic Error pattern:
      // Error: Something went wrong at /path/file.ts:42:10
      const genericMatch = line.match(/Error:\s*([^\r\n]+?)\s+at\s+((?:[a-zA-Z]:[\\/])?[a-zA-Z0-9_.\-\\/]+):(\d+):(\d+)/);
      if (genericMatch) {
        diagnostics.push({
          file: genericMatch[2].replace(/\\/g, '/'),
          line: parseInt(genericMatch[3], 10),
          column: parseInt(genericMatch[4], 10),
          severity: 'error',
          message: genericMatch[1].trim(),
          source: defaultSource,
          rawSnippet: line,
        });
        continue;
      }
    }

    return diagnostics;
  }

  /**
   * Filter diagnostics strictly to touched/modified files.
   */
  filterByFiles(diagnostics: CodeDiagnostic[], touchedFiles: string[]): CodeDiagnostic[] {
    const normalizedTouched = new Set(touchedFiles.map((f) => f.replace(/\\/g, '/').toLowerCase()));

    return diagnostics.filter((diag) => {
      const diagLower = diag.file.toLowerCase();
      for (const touched of normalizedTouched) {
        if (diagLower.endsWith(touched) || touched.endsWith(diagLower)) {
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Summarize diagnostics into a structured report for LLM prompt self-correction.
   */
  renderDiagnosticReport(diagnostics: CodeDiagnostic[]): string {
    if (diagnostics.length === 0) {
      return 'Verification: All checks PASSED (0 errors, 0 warnings).';
    }

    const errors = diagnostics.filter((d) => d.severity === 'error');
    const warnings = diagnostics.filter((d) => d.severity === 'warning');

    const lines: string[] = [
      `### Verification Diagnostics (${errors.length} errors, ${warnings.length} warnings)\n`,
    ];

    for (const err of errors) {
      lines.push(
        `- **[${err.source.toUpperCase()}] ERROR** at \`${err.file}:${err.line}:${err.column}\`${err.code ? ` (${err.code})` : ''}:`,
      );
      lines.push(`  ${err.message}`);
    }

    for (const warn of warnings) {
      lines.push(
        `- *[${warn.source.toUpperCase()}] WARNING* at \`${warn.file}:${warn.line}:${warn.column}\`: ${warn.message}`,
      );
    }

    return lines.join('\n');
  }
}
