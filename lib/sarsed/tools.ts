/**
 * Sarsed-Code Tool Suite.
 *
 * Provides high-level executable tools for the Agent and CLI harness:
 * 1. code_skeleton: Extract compact AST skeleton of source files (80-90% token reduction).
 * 2. code_symbols: Search symbol declarations, definitions, and usages across workspace.
 * 3. code_patch: Apply atomic multi-hunk semantic patch with indentation auto-alignment & rollback.
 * 4. code_verify: Run compiler/linter/test commands and return structured line-by-line diagnostics.
 */

import { z } from 'zod';
import { CodeSkeletonizer } from './skeletonizer';
import { SarsedSymbolIndex } from './symbols';
import { SarsedPatcher } from './patcher';
import { SarsedVerifier } from './verifier';
import type { SymbolKind } from './types';

// Global singletons
const skeletonizer = new CodeSkeletonizer();
const symbolIndex = new SarsedSymbolIndex();
const patcher = new SarsedPatcher();
const verifier = new SarsedVerifier();

export const codeSkeletonSchema = z.object({
  file_path: z.string().describe('Relative or absolute file path to skeletonize'),
  content: z.string().optional().describe('File content if already read (optional)'),
  preserve_comments: z.boolean().optional().describe('Whether to preserve docstrings and top-level comments'),
});

export const codeSymbolsSchema = z.object({
  query: z.string().optional().describe('Symbol name or pattern to search for'),
  kind: z.enum(['function', 'class', 'interface', 'type', 'variable', 'method', 'enum']).optional().describe('Symbol kind filter'),
  file_path: z.string().optional().describe('Filter symbols within specific file'),
});

export const codePatchSchema = z.object({
  file_path: z.string().describe('Target file path to patch'),
  hunks: z.array(
    z.object({
      search: z.string().describe('Exact block to search for in original file'),
      replace: z.string().describe('Replacement block'),
      line_hint: z.number().int().optional().describe('Approximate line number hint to disambiguate identical blocks'),
    }),
  ).min(1).describe('List of SEARCH/REPLACE hunks to apply'),
  atomic: z.boolean().optional().describe('If true (default), all hunks must succeed or none is applied'),
  original_content: z.string().optional().describe('Original content if provided directly'),
});

export const codeVerifySchema = z.object({
  command: z.string().optional().describe('Verification command to run (e.g. "npm test" or "npx tsc --noEmit")'),
  raw_output: z.string().optional().describe('Raw compiler or test output to parse into structured diagnostics'),
  touched_files: z.array(z.string()).optional().describe('Filter diagnostics to only these touched files'),
});

export async function executeCodeSkeleton(
  args: z.infer<typeof codeSkeletonSchema>,
  readFileFn?: (path: string) => Promise<string>,
) {
  let content = args.content;
  if (!content && readFileFn) {
    content = await readFileFn(args.file_path);
  }
  if (!content) {
    return { ok: false, error: 'File content must be provided or readable.' };
  }

  const skeleton = skeletonizer.skeletonize(args.file_path, content, {
    preserveComments: args.preserve_comments,
  });

  return {
    ok: true,
    file: skeleton.file,
    language: skeleton.language,
    symbolsCount: skeleton.symbols.length,
    symbols: skeleton.symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line })),
    totalLines: skeleton.totalLines,
    skeletonLines: skeleton.skeletonLines,
    reductionPercentage: skeleton.reductionPercentage,
    skeletonText: skeleton.skeletonText,
  };
}

export async function executeCodeSymbols(
  args: z.infer<typeof codeSymbolsSchema>,
  filesProvider?: () => Array<{ path: string; content: string }>,
) {
  if (filesProvider) {
    const files = filesProvider();
    symbolIndex.indexFiles(files);
  }

  const matches = symbolIndex.findSymbols({
    name: args.query,
    kind: args.kind as SymbolKind | undefined,
    file: args.file_path,
  });

  return {
    ok: true,
    totalIndexed: symbolIndex.totalSymbols,
    matchedCount: matches.length,
    symbols: matches.slice(0, 50),
  };
}

export async function executeCodePatch(
  args: z.infer<typeof codePatchSchema>,
  fileIO?: {
    read: (path: string) => Promise<string>;
    write: (path: string, content: string) => Promise<void>;
  },
) {
  let originalContent = args.original_content;
  if (!originalContent && fileIO) {
    originalContent = await fileIO.read(args.file_path);
  }
  if (originalContent === undefined) {
    return { ok: false, error: 'Original content is required to apply patch.' };
  }

  const res = patcher.applyPatch(args.file_path, originalContent, {
    file: args.file_path,
    hunks: args.hunks.map((h) => ({
      search: h.search,
      replace: h.replace,
      lineHint: h.line_hint,
    })),
    atomic: args.atomic !== false,
  });

  if (res.success && res.modifiedContent !== undefined && fileIO) {
    await fileIO.write(args.file_path, res.modifiedContent);
  }

  return {
    ok: res.success,
    file: res.file,
    hunksApplied: res.hunksApplied,
    totalHunks: res.totalHunks,
    diff: res.diff,
    error: res.error,
    modifiedContent: res.modifiedContent,
  };
}

export async function executeCodeVerify(
  args: z.infer<typeof codeVerifySchema>,
  shellRunner?: (cmd: string) => Promise<{ exitCode: number; output: string }>,
) {
  let output = args.raw_output ?? '';
  let exitCode = 0;

  if (args.command && shellRunner) {
    const runRes = await shellRunner(args.command);
    output = runRes.output;
    exitCode = runRes.exitCode;
  }

  const allDiags = verifier.parseDiagnostics(output);
  const relevantDiags = args.touched_files
    ? verifier.filterByFiles(allDiags, args.touched_files)
    : allDiags;

  const errorCount = relevantDiags.filter((d) => d.severity === 'error').length;
  const warningCount = relevantDiags.filter((d) => d.severity === 'warning').length;

  return {
    ok: exitCode === 0 && errorCount === 0,
    exitCode,
    totalDiagnostics: relevantDiags.length,
    errorCount,
    warningCount,
    diagnostics: relevantDiags,
    report: verifier.renderDiagnosticReport(relevantDiags),
  };
}

export { skeletonizer, symbolIndex, patcher, verifier };
