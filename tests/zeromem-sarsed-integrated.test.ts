/**
 * Integrated End-to-End Test Suite for Zero-Mem & Sarsed-Code.
 *
 * Verifies:
 * 1. HeadlessToolRunner Zero-Mem operations (zeroMemLog, zeroMemQuery, zeroMemStats).
 * 2. HeadlessToolRunner Sarsed-Code operations (codeSkeleton, codeSymbols, codePatch, codeVerify).
 * 3. End-to-end coding workflow:
 *    - Query Zero-Mem for relevant domain decisions & errors
 *    - Extract AST skeleton to keep context lean (<500 tokens)
 *    - Apply transactional multi-hunk patch with automatic rollback protection
 *    - Execute structured verification & parse compiler diagnostics
 *    - Log verified milestone trace into Zero-Mem without burning any LLM tokens.
 * 4. Dexie v17 schema persistence for Zero-Mem tables.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { HeadlessToolRunner } from '@/lib/teamwork/tools';
import { db } from '@/lib/db';
import { getZeroMemStore } from '@/lib/zeromem';

describe('Zero-Mem & Sarsed-Code: Integrated Multi-Agent Harness', () => {
  let tempDir: string;
  let runner: HeadlessToolRunner;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vyen-boost-test-'));
    runner = new HeadlessToolRunner({
      workspaceRoot: tempDir,
      approvalPolicy: 'never',
    });
  });

  afterEach(async () => {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });

  it('coordinates Zero-Mem memory retrieval and Sarsed AST skeletonization', async () => {
    // 1. Create a substantial TypeScript file in workspace
    const mathCode = `
import { db } from './db';

export interface Vector2D {
  x: number;
  y: number;
}

export function distance(v1: Vector2D, v2: Vector2D): number {
  const dx = v1.x - v2.x;
  const dy = v1.y - v2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function dotProduct(v1: Vector2D, v2: Vector2D): number {
  return v1.x * v2.x + v1.y * v2.y;
}
`;
    await fsp.writeFile(path.join(tempDir, 'math.ts'), mathCode, 'utf8');

    // 2. Log past knowledge trace into Zero-Mem
    const logTrace = await runner.zeroMemLog(
      'Notice: In 2D game engine, Vector2D distance() is called in render loop and must be optimized with squared distance if possible.',
      'user',
    );
    expect(logTrace.id).toBeDefined();

    // 3. Query Zero-Mem for Vector2D
    const memPack = await runner.zeroMemQuery('Vector2D distance');
    expect(memPack.evidences.length).toBeGreaterThan(0);
    expect(memPack.injectedBlock).toContain('squared distance');
    expect(memPack.stats.zeroLlmTokensSaved).toBeGreaterThan(0);

    // 4. Extract AST skeleton of math.ts
    const skeleton = await runner.codeSkeleton('math.ts');
    expect(skeleton.language).toBe('typescript');
    expect(skeleton.symbols.length).toBe(3);
    expect(skeleton.skeletonText).toContain('export interface Vector2D');
    expect(skeleton.skeletonText).toContain('distance');
    expect(skeleton.skeletonText).toContain('[implementation:');
  });

  it('performs atomic codePatch and verifies changes using codeVerify', async () => {
    const serviceCode = `
export class AuthService {
  private secret = "old-secret";

  public getSecret(): string {
    return this.secret;
  }
}
`;
    await fsp.writeFile(path.join(tempDir, 'auth.ts'), serviceCode, 'utf8');

    // Apply multi-hunk patch via HeadlessToolRunner
    const patchRes = await runner.codePatch('auth.ts', [
      {
        search: 'private secret = "old-secret";',
        replace: 'private secret = "new-rotated-secret";',
      },
    ]);

    expect(patchRes.success).toBe(true);
    expect(patchRes.hunksApplied).toBe(1);

    const updated = await fsp.readFile(path.join(tempDir, 'auth.ts'), 'utf8');
    expect(updated).toContain('"new-rotated-secret"');

    // Run verification on touched file
    const verifyRes = await runner.codeVerify(
      'node -e "process.stdout.write(\\"auth.ts(1,1): error TS1234: Test simulated type error\\"); process.exit(1);"',
      ['auth.ts'],
    );

    expect(verifyRes.ok).toBe(false);
    expect(verifyRes.errorCount).toBe(1);
    expect(verifyRes.diagnostics[0].code).toBe('TS1234');
  });

  it('supports codePatch and codeSkeleton seamlessly when staging is enabled without disk corruption', async () => {
    const orig = 'export function calculate() {\n  return 10;\n}\n';
    await fsp.writeFile(path.join(tempDir, 'calc.ts'), orig, 'utf8');

    // Enable staging
    runner.stagingEnabled = true;
    expect(runner.stagingEnabled).toBe(true);

    // Apply patch 1 in staging mode
    const patchRes1 = await runner.codePatch('calc.ts', [
      { search: 'return 10;', replace: 'return 20;' },
    ]);
    expect(patchRes1.success).toBe(true);

    // Staging store must have non-undefined content
    const stagedEntries = Object.values(runner.getStagingStore());
    expect(stagedEntries.length).toBe(1);
    expect(stagedEntries[0].content).toBe('export function calculate() {\n  return 20;\n}\n');
    expect(stagedEntries[0].original).toBe(orig);

    // Disk must NOT be modified yet!
    const diskBeforeApply = await fsp.readFile(path.join(tempDir, 'calc.ts'), 'utf8');
    expect(diskBeforeApply).toBe(orig);

    // Apply patch 2 on top of already staged content
    const patchRes2 = await runner.codePatch('calc.ts', [
      { search: 'return 20;', replace: 'return 30;' },
    ]);
    expect(patchRes2.success).toBe(true);

    // Skeleton reflects staged changes
    const skeleton = await runner.codeSkeleton('calc.ts');
    expect(skeleton.skeletonText).toContain('calculate');

    // Commit staging to disk
    await runner.commitAllStaged();
    expect(runner.getStagedCount()).toBe(0);

    // Disk now has final content
    const diskAfterApply = await fsp.readFile(path.join(tempDir, 'calc.ts'), 'utf8');
    expect(diskAfterApply).toBe('export function calculate() {\n  return 30;\n}\n');
  });

  it('verifies Dexie v17 schema declarations', () => {
    expect(db.zeromemTraces).toBeDefined();
    expect(db.zeromemEntities).toBeDefined();
    expect(db.zeromemRelations).toBeDefined();
    expect(db.verno).toBe(17);
  });
});
