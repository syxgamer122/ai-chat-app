/**
 * Repository Dependency Graph & Test Impact Analyzer for Teamwork Runtime Engine.
 * Index ngữ cảnh repo.
 *
 * Capabilities:
 * 1. Statically analyzes TypeScript/JavaScript imports and exports (including `@/*` aliases and relative paths).
 * 2. Builds bi-directional dependency graphs (`imports` & `importedBy`).
 * 3. Discovers coupled files to prevent blind or missing file scopes in Phase 1 planning.
 * 4. Automatically associates modified source files with matching test suites in `tests/`.
 * 5. Generates targeted verification commands (e.g. `npx vitest run tests/specific.test.ts`) instead of slow full runs.
 * 6. Validates true dependency disjointness between parallel milestones.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DependencyNode, DisjointnessResult } from './types';

export interface RepoGraphOptions {
  workspaceRoot: string;
  ignoredDirs?: string[];
  extensions?: string[];
  aliasPrefix?: string; // Default: '@/' -> maps to workspaceRoot
}

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  '.cache',
  'coverage',
  '.teamwork',
  '.agents',
  '.system_generated',
]);

const DEFAULT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']);

export class RepoDependencyGraph {
  public readonly workspaceRoot: string;
  private readonly ignoredDirs: Set<string>;
  private readonly extensions: Set<string>;
  private readonly aliasPrefix: string;
  private readonly nodes = new Map<string, DependencyNode>();
  private readonly fileMtimes = new Map<string, number>();

  constructor(options: RepoGraphOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.ignoredDirs = options.ignoredDirs ? new Set(options.ignoredDirs) : DEFAULT_IGNORED_DIRS;
    this.extensions = options.extensions ? new Set(options.extensions) : DEFAULT_EXTENSIONS;
    this.aliasPrefix = options.aliasPrefix || '@/';
  }

  /**
   * Normalizes a workspace-relative path with POSIX forward slashes.
   */
  public normalizePath(filePath: string): string {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(this.workspaceRoot, filePath);
    const rel = path.relative(this.workspaceRoot, abs).replace(/\\/g, '/');
    return rel.startsWith('./') ? rel.slice(2) : rel;
  }

  /**
   * Resolves an import specifier to a concrete workspace-relative file path.
   */
  public resolveImportPath(importSpecifier: string, fromFile: string): string | null {
    if (!importSpecifier || typeof importSpecifier !== 'string') return null;

    let targetPath: string;

    // Handle alias: '@/lib/...'
    if (importSpecifier.startsWith(this.aliasPrefix)) {
      const sub = importSpecifier.slice(this.aliasPrefix.length);
      targetPath = path.resolve(this.workspaceRoot, sub);
    } else if (importSpecifier.startsWith('./') || importSpecifier.startsWith('../')) {
      const fromDir = path.dirname(path.resolve(this.workspaceRoot, fromFile));
      targetPath = path.resolve(fromDir, importSpecifier);
    } else {
      // Third-party or stdlib package import
      return null;
    }

    // Direct extension match
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      return this.normalizePath(targetPath);
    }

    // Try common extensions: .ts, .tsx, .js, .jsx, .cjs, .mjs
    const candidateExts = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs'];
    for (const ext of candidateExts) {
      const withExt = targetPath + ext;
      if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
        return this.normalizePath(withExt);
      }
    }

    // Try index file in directory: /index.ts, /index.js
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
      for (const ext of candidateExts) {
        const indexFile = path.join(targetPath, `index${ext}`);
        if (fs.existsSync(indexFile) && fs.statSync(indexFile).isFile()) {
          return this.normalizePath(indexFile);
        }
      }
    }

    return null;
  }

  /**
   * Fast static parser extracting import and export specifiers from code without heavy AST compiler dependencies.
   */
  public parseImportsAndExports(code: string): { imports: string[]; exports: string[] } {
    const rawImports: string[] = [];
    const rawExports: string[] = [];

    // Match static import: import ... from '...'
    const importRe = /(?:import\s+(?:(?:[\w*\s{},]*)\s+from\s+)?|require\s*\(\s*)['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(code)) !== null) {
      if (match[1]) rawImports.push(match[1]);
    }

    // Match dynamic import: import('...')
    const dynImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = dynImportRe.exec(code)) !== null) {
      if (match[1]) rawImports.push(match[1]);
    }

    // Match re-export from: export ... from '...'
    const exportFromRe = /export\s+(?:[\w*\s{},]*)\s+from\s+['"]([^'"]+)['"]/g;
    while ((match = exportFromRe.exec(code)) !== null) {
      if (match[1]) {
        rawImports.push(match[1]);
        rawExports.push(match[1]);
      }
    }

    // Match named export declarations: export function foo, export class Bar, export const baz, export type Qux
    const exportDeclRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([a-zA-Z0-9_$]+)/g;
    while ((match = exportDeclRe.exec(code)) !== null) {
      if (match[1]) rawExports.push(match[1]);
    }

    return {
      imports: Array.from(new Set(rawImports)),
      exports: Array.from(new Set(rawExports)),
    };
  }

  /**
   * Recursively scans and indexes all supported code files in workspaceRoot.
   */
  public async buildGraph(): Promise<Map<string, DependencyNode>> {
    const allFiles = await this.discoverSourceFiles(this.workspaceRoot);

    // 0. Loại bỏ node của các file đã bị xoá/đổi tên khỏi graph.
    //    Trước đây chỉ thêm/cập nhật nên file đã xoá vẫn nằm lại như "node ma",
    //    tiếp tục đóng góp cạnh imports/importedBy và có thể được trả về bởi
    //    findAssociatedTests()/getCoupledFiles().
    const liveFiles = new Set(allFiles);
    for (const known of [...this.nodes.keys()]) {
      if (!liveFiles.has(known)) {
        this.nodes.delete(known);
        this.fileMtimes.delete(known);
      }
    }

    // 1. Initialize or update nodes
    for (const relFile of allFiles) {
      const absPath = path.resolve(this.workspaceRoot, relFile);
      const stat = await fsp.stat(absPath);
      const prevMtime = this.fileMtimes.get(relFile);

      if (prevMtime === stat.mtimeMs && this.nodes.has(relFile)) {
        continue; // Unchanged cache hit
      }

      this.fileMtimes.set(relFile, stat.mtimeMs);
      const content = await fsp.readFile(absPath, 'utf8');
      const { imports: rawImports, exports: rawExports } = this.parseImportsAndExports(content);

      const resolvedImports: string[] = [];
      for (const spec of rawImports) {
        const resolved = this.resolveImportPath(spec, relFile);
        if (resolved) {
          resolvedImports.push(resolved);
        }
      }

      const node: DependencyNode = {
        filePath: relFile,
        imports: Array.from(new Set(resolvedImports)),
        exports: rawExports,
        importedBy: [],
        associatedTests: [],
      };

      this.nodes.set(relFile, node);
    }

    // 2. Compute reverse bi-directional dependencies (importedBy)
    for (const [, node] of this.nodes) {
      node.importedBy = [];
    }

    for (const [file, node] of this.nodes) {
      for (const imp of node.imports) {
        const targetNode = this.nodes.get(imp);
        if (targetNode && !targetNode.importedBy.includes(file)) {
          targetNode.importedBy.push(file);
        }
      }
    }

    // 3. Associate tests with source files.
    //    Phải RESET trước khi map: `mapTestsToSourceNodes` chỉ push thêm, nên
    //    association cũ (test đã đổi/không còn liên quan) sẽ tồn tại vĩnh viễn và
    //    generateVerifyCommand() có thể trả về file test đã xoá.
    for (const [, node] of this.nodes) {
      node.associatedTests = [];
    }
    this.mapTestsToSourceNodes();

    return this.nodes;
  }

  /**
   * Automatically maps test files under `tests/` to target source files.
   */
  private mapTestsToSourceNodes(): void {
    const testNodes = Array.from(this.nodes.keys()).filter(
      (f) => f.startsWith('tests/') || f.includes('.test.') || f.includes('.spec.')
    );

    for (const testFile of testNodes) {
      const testNode = this.nodes.get(testFile);
      if (!testNode) continue;

      // Link via direct import
      for (const imported of testNode.imports) {
        const sourceNode = this.nodes.get(imported);
        if (sourceNode && !sourceNode.associatedTests.includes(testFile)) {
          sourceNode.associatedTests.push(testFile);
        }
      }

      // Link via naming convention: tests/teamwork-file-lock.test.ts -> lib/teamwork/file-lock.ts
      const testBasename = path.basename(testFile).replace(/\.(test|spec)\.[a-z0-9]+$/i, '');
      for (const [sourceFile, sourceNode] of this.nodes) {
        if (sourceFile === testFile) continue;
        const sourceBasename = path.basename(sourceFile).replace(/\.[a-z0-9]+$/i, '');

        if (
          testBasename === sourceBasename ||
          testBasename.includes(sourceBasename) ||
          sourceBasename.includes(testBasename)
        ) {
          if (!sourceNode.associatedTests.includes(testFile)) {
            sourceNode.associatedTests.push(testFile);
          }
        }
      }
    }
  }

  /**
   * Retrieves coupled files (both upstream imports and downstream dependents) up to maxDepth.
   */
  public getCoupledFiles(entryFiles: string[], maxDepth: number = 2): string[] {
    const coupled = new Set<string>();
    const queue: Array<{ file: string; depth: number }> = [];

    for (const f of entryFiles) {
      const norm = this.normalizePath(f);
      coupled.add(norm);
      queue.push({ file: norm, depth: 0 });
    }

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= maxDepth) continue;

      const node = this.nodes.get(item.file);
      if (!node) continue;

      // Add imports
      for (const imp of node.imports) {
        if (!coupled.has(imp)) {
          coupled.add(imp);
          queue.push({ file: imp, depth: item.depth + 1 });
        }
      }

      // Add dependents
      for (const dep of node.importedBy) {
        if (!coupled.has(dep)) {
          coupled.add(dep);
          queue.push({ file: dep, depth: item.depth + 1 });
        }
      }
    }

    return Array.from(coupled);
  }

  /**
   * Finds all associated test suites for a given list of source files.
   */
  public findAssociatedTests(sourceFiles: string[]): string[] {
    const tests = new Set<string>();

    for (const file of sourceFiles) {
      const norm = this.normalizePath(file);

      // If the file itself is a test file, include it directly
      if (norm.startsWith('tests/') || norm.includes('.test.') || norm.includes('.spec.')) {
        tests.add(norm);
        continue;
      }

      const node = this.nodes.get(norm);
      if (node) {
        for (const t of node.associatedTests) {
          tests.add(t);
        }
      }

      // Search matching test files by naming convention
      const baseName = path.basename(norm).replace(/\.[a-z0-9]+$/i, '');
      for (const key of this.nodes.keys()) {
        if (key.startsWith('tests/') && key.includes(baseName)) {
          tests.add(key);
        }
      }
    }

    return Array.from(tests);
  }

  /**
   * Generates the optimal verify command for a given set of modified source files.
   */
  public generateVerifyCommand(sourceFiles: string[]): string {
    const tests = this.findAssociatedTests(sourceFiles);
    if (tests.length === 0) {
      return 'npm test';
    }

    // Sort tests for deterministic command output
    const sorted = [...tests].sort();
    return `npx vitest run ${sorted.join(' ')}`;
  }

  /**
   * Validates whether two milestone file scopes are truly disjoint without cross-dependency conflicts.
   */
  public validateDisjointness(scopeA: string[], scopeB: string[]): DisjointnessResult {
    const setA = new Set(scopeA.map((f) => this.normalizePath(f)));
    const setB = new Set(scopeB.map((f) => this.normalizePath(f)));

    // Direct overlap
    const overlaps: string[] = [];
    for (const f of setA) {
      if (setB.has(f)) {
        overlaps.push(f);
      }
    }

    // Shared coupled dependencies
    const coupledA = new Set(this.getCoupledFiles(scopeA, 1));
    const coupledB = new Set(this.getCoupledFiles(scopeB, 1));
    const sharedDependencies: string[] = [];

    for (const f of coupledA) {
      if (coupledB.has(f) && !setA.has(f) && !setB.has(f)) {
        sharedDependencies.push(f);
      }
    }

    const disjoint = overlaps.length === 0;

    return {
      disjoint,
      overlaps,
      sharedDependencies,
    };
  }

  /**
   * Helper to recursively scan directory for source files.
   */
  private async discoverSourceFiles(dir: string): Promise<string[]> {
    const results: string[] = [];

    const walk = async (currentDir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const name = entry.name;
        if (entry.isDirectory()) {
          if (!this.ignoredDirs.has(name) && !name.startsWith('.')) {
            await walk(path.join(currentDir, name));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(name).toLowerCase();
          if (this.extensions.has(ext)) {
            const rel = path.relative(this.workspaceRoot, path.join(currentDir, name)).replace(/\\/g, '/');
            results.push(rel);
          }
        }
      }
    };

    await walk(dir);
    return results;
  }
}
