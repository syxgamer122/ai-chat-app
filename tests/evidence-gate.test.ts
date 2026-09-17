import { describe, it, expect } from 'vitest';
import {
  computeEnvFingerprint,
  isReusable,
  captureStdoutTail,
  type VerificationReceipt,
} from '@/lib/verification';
import {
  evaluateCompletionIntegrity,
} from '@/lib/completion-gate';
import {
  createInitialEvidence,
  transitionEvidence,
  type EvidenceState,
} from '@/lib/evidence';

describe('Evidence Ladder, Verification Receipts & Completion Gate', () => {
  describe('Verification Receipts & isReusable', () => {
    const validReceipt: VerificationReceipt = {
      revision: 'git-commit-abc1234',
      command: 'npm test -- tests/auth.test.ts',
      envFingerprint: 'win32::v20.10.0::lock-hash-1',
      exitCode: 0,
      stdoutTail: 'Test Files 1 passed (1)\nTests 10 passed (10)',
      observedAt: '2026-03-01T10:00:00Z',
    };

    it('allows reuse when revision, command, and envFingerprint match exactly', () => {
      const canReuse = isReusable(validReceipt, {
        revision: 'git-commit-abc1234',
        command: 'npm test -- tests/auth.test.ts',
        envFingerprint: 'win32::v20.10.0::lock-hash-1',
      });
      expect(canReuse).toBe(true);
    });

    it('rejects reuse if revision changes', () => {
      const canReuse = isReusable(validReceipt, {
        revision: 'git-commit-new9999',
        command: 'npm test -- tests/auth.test.ts',
        envFingerprint: 'win32::v20.10.0::lock-hash-1',
      });
      expect(canReuse).toBe(false);
    });

    it('rejects reuse if command changes', () => {
      const canReuse = isReusable(validReceipt, {
        revision: 'git-commit-abc1234',
        command: 'npm test -- tests/other.test.ts',
        envFingerprint: 'win32::v20.10.0::lock-hash-1',
      });
      expect(canReuse).toBe(false);
    });

    it('rejects reuse if envFingerprint changes', () => {
      const canReuse = isReusable(validReceipt, {
        revision: 'git-commit-abc1234',
        command: 'npm test -- tests/auth.test.ts',
        envFingerprint: 'linux::v20.10.0::lock-hash-1',
      });
      expect(canReuse).toBe(false);
    });

    it('rejects reuse if receipt has non-zero exit code', () => {
      const failingReceipt: VerificationReceipt = {
        ...validReceipt,
        exitCode: 1,
      };
      const canReuse = isReusable(failingReceipt, {
        revision: 'git-commit-abc1234',
        command: 'npm test -- tests/auth.test.ts',
        envFingerprint: 'win32::v20.10.0::lock-hash-1',
      });
      expect(canReuse).toBe(false);
    });

    it('computes deterministic envFingerprint', () => {
      const fp1 = computeEnvFingerprint({ nodeVersion: 'v20.0.0', platform: 'win32', lockfileHash: 'xyz' });
      const fp2 = computeEnvFingerprint({ nodeVersion: 'v20.0.0', platform: 'win32', lockfileHash: 'xyz' });
      expect(fp1).toBe(fp2);
      expect(fp1).toBe('win32::v20.0.0::xyz');
    });

    it('captures stdout tail correctly', () => {
      const stdout = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
      const tail = captureStdoutTail(stdout, 10);
      const tailLines = tail.split('\n');
      expect(tailLines.length).toBe(10);
      expect(tailLines[0]).toBe('line 91');
      expect(tailLines[9]).toBe('line 100');
    });
  });

  describe('Completion Gate (evaluateCompletionIntegrity)', () => {
    it('catches throw new Error("not implemented") and stubs', () => {
      const code = `
        export function computeTotal() {
          throw new Error("not implemented");
        }
      `;
      const res = evaluateCompletionIntegrity(code);
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.includes('throw new Error("not implemented")'))).toBe(true);
    });

    it('catches it.skip and test.skip evasions', () => {
      const code = `
        describe('auth', () => {
          it.skip('should verify password', () => {
            expect(true).toBe(true);
          });
        });
      `;
      const res = evaluateCompletionIntegrity(code);
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.includes('.skip'))).toBe(true);
    });

    it('catches xit and xtest disablements', () => {
      const code = `
        xit('temporarily disabled test', () => {
          expect(1).toBe(1);
        });
      `;
      const res = evaluateCompletionIntegrity(code);
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.includes('xit/xtest'))).toBe(true);
    });

    it('catches deferred implementation comments (TODO: implement later)', () => {
      const code = `
        // TODO: implement later
        function syncDatabase() {}
      `;
      const res = evaluateCompletionIntegrity(code);
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.includes('TODO/FIXME'))).toBe(true);
    });

    it('catches deletion of test suites without adding new ones in diff', () => {
      const diff = `
- it('should calculate tax', () => {
-   expect(calculateTax(100)).toBe(10);
- });
- it('should handle negative values', () => {
-   expect(calculateTax(-1)).toBe(0);
- });
+ // removed flaky tests
      `;
      const res = evaluateCompletionIntegrity(diff);
      expect(res.ok).toBe(false);
      expect(res.violations.some((v) => v.includes('Xóa bỏ 2 bài kiểm thử'))).toBe(true);
    });

    it('passes legitimate, clean code and diffs', () => {
      const cleanDiff = `
+ export function add(a: number, b: number): number {
+   return a + b;
+ }
+ test('adds two numbers', () => {
+   expect(add(1, 2)).toBe(3);
+ });
      `;
      const res = evaluateCompletionIntegrity(cleanDiff);
      expect(res.ok).toBe(true);
      expect(res.violations).toHaveLength(0);
    });
  });

  describe('Evidence Ladder (transitionEvidence)', () => {
    it('initializes at prepared state', () => {
      const state = createInitialEvidence();
      expect(state.level).toBe('prepared');
      expect(state.history).toHaveLength(1);
    });

    it('fails closed to reported_done if target is verified but receipt is missing', () => {
      const current = createInitialEvidence('running');
      const { state, error } = transitionEvidence(current, 'verified');
      expect(state.level).toBe('reported_done');
      expect(error).toContain('Thiếu VerificationReceipt');
    });

    it('fails closed to failed if receipt has non-zero exit code', () => {
      const current = createInitialEvidence('running');
      const badReceipt: VerificationReceipt = {
        revision: 'rev-1',
        command: 'npm test',
        envFingerprint: 'fp-1',
        exitCode: 1,
        stdoutTail: 'FAIL tests/example.test.ts',
        observedAt: '2026-03-01T10:00:00Z',
      };
      const { state, error } = transitionEvidence(current, 'verified', { receipt: badReceipt });
      expect(state.level).toBe('failed');
      expect(error).toContain('Kiểm thử thất bại');
      expect(state.failureReason).toContain('exit code 1');
    });

    it('fails closed to reported_done if diff violates Completion Gate', () => {
      const current = createInitialEvidence('running');
      const goodReceipt: VerificationReceipt = {
        revision: 'rev-1',
        command: 'npm test',
        envFingerprint: 'fp-1',
        exitCode: 0,
        stdoutTail: 'PASS tests/example.test.ts',
        observedAt: '2026-03-01T10:00:00Z',
      };
      const stubDiff = '+ function stub() { throw new Error("not implemented"); }';
      const { state, error } = transitionEvidence(current, 'verified', {
        receipt: goodReceipt,
        diff: stubDiff,
      });
      expect(state.level).toBe('reported_done');
      expect(error).toContain('Completion Gate từ chối xác minh');
      expect(state.integrityViolations?.length).toBeGreaterThan(0);
    });

    it('successfully transitions to verified when receipt passes and diff is clean', () => {
      const current = createInitialEvidence('running');
      const goodReceipt: VerificationReceipt = {
        revision: 'rev-1',
        command: 'npm test',
        envFingerprint: 'fp-1',
        exitCode: 0,
        stdoutTail: 'PASS tests/example.test.ts\nAll tests passed',
        observedAt: '2026-03-01T10:00:00Z',
      };
      const cleanDiff = '+ const res = 42;\n+ expect(res).toBe(42);';
      const { state, error } = transitionEvidence(current, 'verified', {
        receipt: goodReceipt,
        diff: cleanDiff,
      });
      expect(error).toBeUndefined();
      expect(state.level).toBe('verified');
      expect(state.receipt).toBe(goodReceipt);
      expect(state.history.at(-1)?.level).toBe('verified');
    });

    it('records transitions to blocked and running in history', () => {
      let state = createInitialEvidence('prepared');
      const runningRes = transitionEvidence(state, 'running', { note: 'Started executing' });
      state = runningRes.state;
      expect(state.level).toBe('running');

      const blockedRes = transitionEvidence(state, 'blocked', {
        blockedReason: 'Thiếu quyền ghi thư mục /etc',
      });
      state = blockedRes.state;
      expect(state.level).toBe('blocked');
      expect(state.blockedReason).toContain('Thiếu quyền ghi');
      expect(state.history).toHaveLength(3); // prepared -> running -> blocked
    });
  });
});
