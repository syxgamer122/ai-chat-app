/**
 * Comprehensive Unit Test Suite for TeamworkCritic (Milestone 3).
 * Conforms strictly to ORIGINAL_REQUEST.md R1 & R3, PROJECT.md, and .opencode/agents/teamwork-critic.md.
 *
 * Covers:
 * 1. Zero-Trust Real Command Execution & Exit Code Verification:
 *    - Real command pass (exit 0) -> verdict PASS, passCriteriaMet true.
 *    - Real command failure (exit non-zero) -> verdict FAIL-BLOCKED, passCriteriaMet false.
 *    - Captures real exit codes and stdout/stderr output preview.
 *    - Worker self-claims ("all tests passed") ignored when real command fails.
 * 2. Missing verifyCommand handling:
 *    - Empty or whitespace command -> immediate FAIL-BLOCKED with blocker issue.
 * 3. Integrity Mode Auditing ('development', 'demo', 'benchmark'):
 *    - 'development': blocks empty function bodies, arrow facades, TODO stubs, and not-implemented throws.
 *    - 'development': allows genuine code logic with state and calculations.
 *    - 'development': ignores non-code files (e.g. markdown todo lists).
 *    - 'demo': blocks external OSS license copy-paste and test constant reverse-engineering.
 *    - 'benchmark': blocks third-party package imports, permits standard library only.
 * 4. Structured Remediation Feedback:
 *    - Generates actionable instructions for worker retry on FAIL-BLOCKED.
 * 5. Staging Sandbox Integration:
 *    - Detects integrity violations in staged in-memory edits before disk commit.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditDiffForIntegrity,
  buildRemediationFeedback,
  formatOutputPreview,
  TeamworkCritic,
} from '@/lib/teamwork/critic';
import { HeadlessToolRunner } from '@/lib/teamwork/tools';
import { Milestone } from '@/lib/teamwork/types';

describe('TeamworkCritic (Adversarial Verifier)', () => {
  let workspaceRoot: string;
  let tools: HeadlessToolRunner;
  let critic: TeamworkCritic;

  beforeEach(async () => {
    workspaceRoot = path.resolve(os.tmpdir(), `teamwork-critic-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(workspaceRoot, { recursive: true });
    tools = new HeadlessToolRunner({
      workspaceRoot,
      stagingEnabled: true,
      approvalPolicy: 'never',
    });
    critic = new TeamworkCritic(tools);
  });

  afterEach(async () => {
    try {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('Zero-Trust Command Execution & Exit Code Auditing', () => {
    it('emits PASS verdict when real command exits with 0', async () => {
      const milestone: Milestone = {
        id: 'M1',
        title: 'Verify Passing Command',
        goal: 'Run passing test',
        ownedFiles: ['lib/calc.ts'],
        verifyCommand: "node -e \"process.stdout.write('All 5 tests passed'); process.exit(0);\"",
        status: 'doing',
        retryCount: 0,
      };

      const result = await critic.verifyMilestone(milestone, 'development');

      expect(result.verdict).toBe('PASS');
      expect(result.exitCode).toBe(0);
      expect(result.passCriteriaMet).toBe(true);
      expect(result.outputPreview).toContain('All 5 tests passed');
      expect(result.issues.filter((i) => i.severity === 'blocker')).toHaveLength(0);
      expect(result.remediation).toBeUndefined();
    });

    it('emits FAIL-BLOCKED verdict when real command exits non-zero', async () => {
      const milestone: Milestone = {
        id: 'M1',
        title: 'Verify Failing Command',
        goal: 'Run failing test',
        ownedFiles: ['lib/auth.ts'],
        verifyCommand: "node -e \"process.stderr.write('AssertionError: expected true to be false'); process.exit(1);\"",
        status: 'doing',
        retryCount: 0,
      };

      const result = await critic.verifyMilestone(milestone, 'development');

      expect(result.verdict).toBe('FAIL-BLOCKED');
      expect(result.exitCode).toBe(1);
      expect(result.passCriteriaMet).toBe(false);
      expect(result.outputPreview).toContain('AssertionError');
      const blockers = result.issues.filter((i) => i.severity === 'blocker');
      expect(blockers.length).toBeGreaterThanOrEqual(1);
      expect(blockers[0].description).toContain('failed with exit code 1');
      expect(result.remediation).toBeDefined();
      expect(result.remediation).toContain('Command Failure');
    });

    it('enforces zero trust: ignores worker optimistic claims if real command fails', async () => {
      const milestone: Milestone = {
        id: 'M2',
        title: 'Worker Claimed Pass',
        goal: 'Verify zero trust',
        ownedFiles: ['lib/service.ts'],
        verifyCommand: "node -e \"process.stderr.write('TypeError: undefined is not a function'); process.exit(2);\"",
        status: 'doing',
        retryCount: 0,
        notes: 'Worker claims: 100% test pass rate, 24/24 tests succeeded flawlessly!',
      };

      const result = await critic.verifyMilestone(milestone, 'development');

      // Despite worker claim, Critic runs command independently and rejects
      expect(result.verdict).toBe('FAIL-BLOCKED');
      expect(result.exitCode).toBe(2);
      expect(result.passCriteriaMet).toBe(false);
      expect(result.outputPreview).toContain('TypeError');
    });

    it('handles missing or empty verifyCommand as a blocker', async () => {
      const milestone: Milestone = {
        id: 'M3',
        title: 'Milestone Missing Command',
        goal: 'Verify missing command handling',
        ownedFiles: ['lib/index.ts'],
        verifyCommand: '   ',
        status: 'doing',
        retryCount: 0,
      };

      const result = await critic.verifyMilestone(milestone);

      expect(result.verdict).toBe('FAIL-BLOCKED');
      expect(result.exitCode).toBeNull();
      expect(result.passCriteriaMet).toBe(false);
      expect(result.issues[0].severity).toBe('blocker');
      expect(result.issues[0].description).toContain('does not specify a verifyCommand');
      expect(result.remediation).toBeDefined();
    });
  });

  describe('Output Preview Formatting', () => {
    it('truncates long command outputs while preserving head and tail', () => {
      const longOutput = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: output details`).join('\n');
      const preview = formatOutputPreview(longOutput, 20);

      expect(preview.split('\n').length).toBeLessThanOrEqual(25);
      expect(preview).toContain('Line 1:');
      expect(preview).toContain('Line 60:');
      expect(preview).toContain('omitted');
    });

    it('preserves short outputs in full without alteration', () => {
      const shortOutput = 'Line 1: pass\nLine 2: pass';
      const preview = formatOutputPreview(shortOutput, 10);
      expect(preview).toBe(shortOutput);
    });

    it('handles empty or whitespace-only outputs gracefully', () => {
      expect(formatOutputPreview('')).toBe('(no output recorded)');
      expect(formatOutputPreview('   \n  ')).toBe('(no output recorded)');
    });
  });

  describe('Integrity Mode Rubric Auditing: Development Mode', () => {
    it('blocks empty function facades (function foo() {})', () => {
      const diff = `
--- a/lib/math.ts
+++ b/lib/math.ts
@@ -1,1 +1,3 @@
+export function calculateTax(amount: number) {}
`;
      const issues = auditDiffForIntegrity(diff, 'development');
      expect(issues.some((i) => i.description.includes('empty function facade'))).toBe(true);
    });

    it('blocks empty arrow function facades (const foo = () => {})', () => {
      const diff = `
--- a/lib/handler.ts
+++ b/lib/handler.ts
@@ -0,0 +1,2 @@
+export const handleRequest = (req: unknown) => {};
`;
      const issues = auditDiffForIntegrity(diff, 'development');
      expect(issues.some((i) => i.description.includes('empty arrow function facade'))).toBe(true);
    });

    it('blocks dummy stub comments and TODO implementations', () => {
      const diff = `
--- a/lib/solver.ts
+++ b/lib/solver.ts
@@ -1,1 +1,3 @@
+// TODO: implement genuine logic
+return 42;
`;
      const issues = auditDiffForIntegrity(diff, 'development');
      expect(issues.some((i) => i.description.includes('dummy stub comment'))).toBe(true);
    });

    it('blocks placeholder "not implemented" error throws', () => {
      const diff = `
--- a/lib/engine.ts
+++ b/lib/engine.ts
@@ -1,1 +1,3 @@
+export function execute() {
+  throw new Error("not implemented");
+}
`;
      const issues = auditDiffForIntegrity(diff, 'development');
      expect(issues.some((i) => i.description.includes('"not implemented" exception'))).toBe(true);
    });

    it('blocks trivial stub returns that mock behavior without logic', () => {
      const diff = `
--- a/lib/check.ts
+++ b/lib/check.ts
@@ -1,1 +1,3 @@
+export function isValid() { return false; }
`;
      const issues = auditDiffForIntegrity(diff, 'development');
      expect(issues.some((i) => i.description.includes('trivial stub return'))).toBe(true);
    });

    it('permits genuine implementations containing real computation and state', () => {
      const diff = `
--- a/lib/calc.ts
+++ b/lib/calc.ts
@@ -1,1 +1,9 @@
+export function computeSum(items: number[]): number {
+  let total = 0;
+  for (const item of items) {
+    if (item > 0) {
+      total += item * 1.05;
+    }
+  }
+  return total;
+}
`;
      const issues = auditDiffForIntegrity(diff, 'development');
      const blockers = issues.filter((i) => i.severity === 'blocker');
      expect(blockers).toHaveLength(0);
    });

    it('does not flag markdown documentation containing todo status as a code facade', () => {
      const diff = `
--- a/teamwork/PROGRESS.md
+++ b/teamwork/PROGRESS.md
@@ -1,1 +1,3 @@
+| M1: Login | worker | todo | src/login.ts | - | 0/2 | - |
`;
      const issues = auditDiffForIntegrity(diff, 'development');
      expect(issues).toHaveLength(0);
    });
  });

  describe('Integrity Mode Rubric Auditing: Demo Mode', () => {
    it('blocks copying third-party OSS license headers into workspace code', () => {
      const diff = `
--- a/lib/crypto-helper.ts
+++ b/lib/crypto-helper.ts
@@ -0,0 +1,5 @@
+// SPDX-License-Identifier: Apache-2.0
+// Licensed under the Apache License, Version 2.0
+export function encrypt(data: string) { return data; }
`;
      const issues = auditDiffForIntegrity(diff, 'demo');
      expect(issues.some((i) => i.description.includes('external open-source copy-paste signature'))).toBe(true);
    });

    it('blocks reverse-engineering markers from test assertions', () => {
      const diff = `
--- a/lib/parser.ts
+++ b/lib/parser.ts
@@ -1,1 +1,4 @@
+export function parseConfig() {
+  // hardcoded for test
+  return { enabled: true, maxRetries: 3 };
+}
`;
      const issues = auditDiffForIntegrity(diff, 'demo');
      expect(issues.some((i) => i.description.includes('hardcoded test reverse-engineering marker'))).toBe(true);
    });
  });

  describe('Integrity Mode Rubric Auditing: Benchmark Mode', () => {
    it('blocks third-party library imports in benchmark clean-room mode', () => {
      const diff = `
--- a/lib/algo.ts
+++ b/lib/algo.ts
@@ -0,0 +1,3 @@
+import _ from 'lodash';
+export function dedupe(arr: unknown[]) { return _.uniq(arr); }
`;
      const issues = auditDiffForIntegrity(diff, 'benchmark');
      expect(issues.some((i) => i.description.includes('unauthorized third-party library import "lodash"'))).toBe(true);
    });

    it('permits Node.js built-in standard library in benchmark mode', () => {
      const diff = `
--- a/lib/file-helper.ts
+++ b/lib/file-helper.ts
@@ -0,0 +1,5 @@
+import fs from 'node:fs';
+import path from 'path';
+import { createHash } from 'crypto';
+export function hashFile(p: string) { return createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
`;
      const issues = auditDiffForIntegrity(diff, 'benchmark');
      const blockers = issues.filter((i) => i.severity === 'blocker');
      expect(blockers).toHaveLength(0);
    });

    it('permits internal relative imports in benchmark mode', () => {
      const diff = `
--- a/lib/caller.ts
+++ b/lib/caller.ts
@@ -0,0 +1,3 @@
+import { computeSum } from './calc';
+import { helper } from '@/lib/utils';
+export function run() { return computeSum([1, 2]); }
`;
      const issues = auditDiffForIntegrity(diff, 'benchmark');
      const blockers = issues.filter((i) => i.severity === 'blocker');
      expect(blockers).toHaveLength(0);
    });
  });

  describe('Remediation Feedback Generation', () => {
    it('generates clear, actionable guidance on command failure and blocking issues', () => {
      const issues = [
        {
          severity: 'blocker' as const,
          fileLocation: 'lib/service.ts',
          description: 'Integrity violation: empty function facade detected ("solve").',
          reproduction: 'Inspect function definition in lib/service.ts.',
        },
        {
          severity: 'major' as const,
          fileLocation: 'lib/other.ts',
          description: 'Code modifications detected outside assigned files.',
        },
      ];

      const feedback = buildRemediationFeedback(issues, 'npm test tests/service.test.ts', 1, 'Tests failed');

      expect(feedback).toContain('### Critic Remediation Guidance');
      expect(feedback).toContain('npm test tests/service.test.ts');
      expect(feedback).toContain('exited with code 1');
      expect(feedback).toContain('Blocking Integrity Issues');
      expect(feedback).toContain('empty function facade');
      expect(feedback).toContain('Conditions for PASS on Next Attempt');
    });
  });

  describe('Staging Overlay Integration with Critic', () => {
    it('detects dummy facade violations in staged files before disk commit', async () => {
      // Stage an edit in memory that contains an empty facade
      await tools.fsWrite('lib/staged-facade.ts', 'export function dummyMethod() {}');

      const milestone: Milestone = {
        id: 'M1',
        title: 'Test Staged Facade',
        goal: 'Detect staged facade',
        ownedFiles: ['lib/staged-facade.ts'],
        verifyCommand: 'node -e "process.exit(0);"',
        status: 'doing',
        retryCount: 0,
      };

      const result = await critic.verifyMilestone(milestone, 'development');

      expect(result.verdict).toBe('FAIL-BLOCKED');
      expect(result.passCriteriaMet).toBe(false);
      expect(result.issues.some((i) => i.description.includes('empty function facade'))).toBe(true);
    });
  });
});
