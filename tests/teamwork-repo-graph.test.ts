import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoDependencyGraph } from '../lib/teamwork/repo-graph';

describe('RepoDependencyGraph — Repository-Aware Dependency Mapping (Orca Model)', () => {
  const workspaceRoot = path.resolve(process.cwd());
  const graph = new RepoDependencyGraph({
    workspaceRoot,
  });

  it('normalizes paths consistently across Windows and POSIX', () => {
    expect(graph.normalizePath('lib\\teamwork\\engine.ts')).toBe('lib/teamwork/engine.ts');
    expect(graph.normalizePath('./lib/teamwork/engine.ts')).toBe('lib/teamwork/engine.ts');
    expect(graph.normalizePath(path.join(workspaceRoot, 'lib', 'teamwork', 'types.ts'))).toBe(
      'lib/teamwork/types.ts'
    );
  });

  it('resolves relative and aliased import specifiers to workspace files', () => {
    // Relative import
    const relResolved = graph.resolveImportPath('./types', 'lib/teamwork/engine.ts');
    expect(relResolved).toBe('lib/teamwork/types.ts');

    // Alias import (@/lib/staging)
    const aliasResolved = graph.resolveImportPath('@/lib/staging', 'lib/teamwork/tools.ts');
    expect(aliasResolved).toBe('lib/staging.ts');

    // Non-existent or external package returns null
    const extResolved = graph.resolveImportPath('node:fs', 'lib/teamwork/tools.ts');
    expect(extResolved).toBeNull();
  });

  it('parses import and export declarations from source code accurately', () => {
    const sampleCode = `
      import { foo, bar } from './foo';
      import * as utils from '@/lib/utils';
      const helper = require('./helper');
      export const myVar = 42;
      export function doWork() {}
      export class Service {}
      export { baz } from './baz';
      const dynamic = await import('./dynamic-mod');
    `;

    const result = graph.parseImportsAndExports(sampleCode);
    expect(result.imports).toContain('./foo');
    expect(result.imports).toContain('@/lib/utils');
    expect(result.imports).toContain('./helper');
    expect(result.imports).toContain('./baz');
    expect(result.imports).toContain('./dynamic-mod');

    expect(result.exports).toContain('myVar');
    expect(result.exports).toContain('doWork');
    expect(result.exports).toContain('Service');
    expect(result.exports).toContain('./baz');
  });

  it('builds dependency graph for teamwork codebase', async () => {
    const nodes = await graph.buildGraph();
    expect(nodes.size).toBeGreaterThan(5);

    const engineNode = nodes.get('lib/teamwork/engine.ts');
    expect(engineNode).toBeDefined();
    expect(engineNode?.imports).toContain('lib/teamwork/types.ts');
    expect(engineNode?.imports).toContain('lib/teamwork/file-lock.ts');
    expect(engineNode?.imports).toContain('lib/teamwork/tools.ts');
  });

  it('correctly maps source files to matching test files', async () => {
    await graph.buildGraph();

    const testsForFileLock = graph.findAssociatedTests(['lib/teamwork/file-lock.ts']);
    expect(testsForFileLock.length).toBeGreaterThanOrEqual(1);
    expect(testsForFileLock.some((t) => t.includes('teamwork-file-lock'))).toBe(true);

    const testsForTools = graph.findAssociatedTests(['lib/teamwork/tools.ts']);
    expect(testsForTools.length).toBeGreaterThanOrEqual(1);
    expect(testsForTools.some((t) => t.includes('teamwork-tools'))).toBe(true);
  });

  it('generates optimal verifyCommand targeting relevant test suites', async () => {
    await graph.buildGraph();

    const verifyCmd = graph.generateVerifyCommand(['lib/teamwork/file-lock.ts']);
    expect(verifyCmd).toMatch(/^npx vitest run /);
    expect(verifyCmd).toContain('teamwork-file-lock');
  });

  it('computes coupled dependencies accurately', async () => {
    await graph.buildGraph();

    const coupled = graph.getCoupledFiles(['lib/teamwork/engine.ts'], 1);
    expect(coupled).toContain('lib/teamwork/engine.ts');
    expect(coupled).toContain('lib/teamwork/types.ts');
    expect(coupled).toContain('lib/teamwork/tools.ts');
  });

  it('validates file disjointness between milestones', () => {
    const scope1 = ['lib/teamwork/file-lock.ts'];
    const scope2 = ['lib/teamwork/summary.ts'];
    const overlapScope = ['lib/teamwork/file-lock.ts', 'lib/teamwork/engine.ts'];

    const disjointCheck = graph.validateDisjointness(scope1, scope2);
    expect(disjointCheck.disjoint).toBe(true);
    expect(disjointCheck.overlaps.length).toBe(0);

    const overlapCheck = graph.validateDisjointness(scope1, overlapScope);
    expect(overlapCheck.disjoint).toBe(false);
    expect(overlapCheck.overlaps).toContain('lib/teamwork/file-lock.ts');
  });
});
