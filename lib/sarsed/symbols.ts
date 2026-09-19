/**
 * Sarsed-Code Symbol Indexer & Definition Resolver.
 *
 * Provides workspace-wide symbol navigation:
 * - Symbol declaration and definition lookup
 * - Cross-file reference and usage resolution
 * - Call hierarchy analyzer (caller / callee graph)
 */

import type { CodeSymbol, SymbolKind } from './types';

export interface SymbolSearchOptions {
  name?: string;
  kind?: SymbolKind;
  file?: string;
  exportedOnly?: boolean;
}

export interface SymbolUsage {
  symbolName: string;
  file: string;
  line: number;
  snippet: string;
}

export interface CallHierarchyNode {
  callerSymbol: string;
  calleeSymbol: string;
  file: string;
  line: number;
}

export class SarsedSymbolIndex {
  private symbols: CodeSymbol[] = [];
  private symbolMap: Map<string, CodeSymbol[]> = new Map();

  /**
   * Index symbols from a list of files.
   */
  indexFiles(files: Array<{ path: string; content: string }>): void {
    this.symbols = [];
    this.symbolMap.clear();

    for (const file of files) {
      this.indexSingleFile(file.path, file.content);
    }
  }

  /**
   * Index symbols in a single file.
   */
  indexSingleFile(filePath: string, content: string): CodeSymbol[] {
    const lines = content.split(/\r?\n/);
    const fileSymbols: CodeSymbol[] = [];

    const SYMBOL_PATTERNS: Array<{
      kind: SymbolKind;
      regex: RegExp;
    }> = [
      {
        kind: 'function',
        regex: /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      },
      {
        kind: 'function',
        regex: /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?\(/g,
      },
      {
        kind: 'class',
        regex: /(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      },
      {
        kind: 'interface',
        regex: /(?:export\s+)?interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      },
      {
        kind: 'type',
        regex: /(?:export\s+)?type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      },
      {
        kind: 'enum',
        regex: /(?:export\s+)?enum\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      },
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const isExported = /^\s*export\s+/.test(line);

      for (const pat of SYMBOL_PATTERNS) {
        pat.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pat.regex.exec(line)) !== null) {
          const name = match[1];
          if (name) {
            const sym: CodeSymbol = {
              name,
              kind: pat.kind,
              file: filePath,
              line: lineNum,
              col: match.index,
              exported: isExported,
              signature: line.trim(),
            };
            fileSymbols.push(sym);
            this.symbols.push(sym);

            const list = this.symbolMap.get(name) ?? [];
            list.push(sym);
            this.symbolMap.set(name, list);
          }
        }
      }
    }

    return fileSymbols;
  }

  /**
   * Find symbol definition by name.
   */
  findDefinition(name: string): CodeSymbol | undefined {
    const list = this.symbolMap.get(name);
    return list && list.length > 0 ? list[0] : undefined;
  }

  /**
   * Search symbols matching query options.
   */
  findSymbols(options: SymbolSearchOptions = {}): CodeSymbol[] {
    return this.symbols.filter((sym) => {
      if (options.name && !sym.name.toLowerCase().includes(options.name.toLowerCase())) {
        return false;
      }
      if (options.kind && sym.kind !== options.kind) {
        return false;
      }
      if (options.file && !sym.file.includes(options.file)) {
        return false;
      }
      if (options.exportedOnly && !sym.exported) {
        return false;
      }
      return true;
    });
  }

  /**
   * Find usages / references of a symbol across files.
   */
  findReferences(
    symbolName: string,
    files: Array<{ path: string; content: string }>,
  ): SymbolUsage[] {
    const usages: SymbolUsage[] = [];
    const wordRe = new RegExp(`\\b${symbolName}\\b`, 'g');

    for (const file of files) {
      const lines = file.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (wordRe.test(line)) {
          usages.push({
            symbolName,
            file: file.path,
            line: i + 1,
            snippet: line.trim(),
          });
        }
      }
    }

    return usages;
  }

  /**
   * Build call hierarchy for a target function.
   */
  findCallers(
    targetFunction: string,
    files: Array<{ path: string; content: string }>,
  ): CallHierarchyNode[] {
    const callers: CallHierarchyNode[] = [];
    const callRe = new RegExp(`\\b${targetFunction}\\s*\\(`, 'g');

    for (const file of files) {
      const lines = file.content.split(/\r?\n/);
      let currentFunction = '(module)';

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fnMatch =
          line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/) ||
          line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/) ||
          line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s*)?function/) ||
          line.match(/^\s*(?:(?:public|private|protected|static|async|override)\s+)+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/);
        if (fnMatch) {
          currentFunction = fnMatch[1];
        }

        if (callRe.test(line) && currentFunction !== targetFunction) {
          callers.push({
            callerSymbol: currentFunction,
            calleeSymbol: targetFunction,
            file: file.path,
            line: i + 1,
          });
        }
      }
    }

    return callers;
  }

  get totalSymbols(): number {
    return this.symbols.length;
  }

  clear(): void {
    this.symbols = [];
    this.symbolMap.clear();
  }
}
