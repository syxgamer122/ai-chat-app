import { describe, it, expect } from 'vitest';
import {
  freezeContract,
  computeTopologicalOrder,
  type FanoutContract,
  type UnitContract,
} from '@/lib/fanout/contract';
import {
  classifyFailure,
  probeReplaySafety,
  computeBackoffMs,
} from '@/lib/fanout/retry';
import {
  DependencyFrontierScheduler,
} from '@/lib/fanout/scheduler';

describe('Fanout Contracts, Replay Safety & Frontier Scheduler', () => {
  describe('freezeContract & Topological Validation', () => {
    it('successfully freezes valid DAG and computes topological mergeOrder', () => {
      const contract: FanoutContract = {
        id: 'fanout-1',
        goalDigest: 'goal-123',
        baseRevision: 'git-rev-1',
        safetyProfileRevision: 'sp-1',
        units: [
          {
            id: 'unit-b',
            title: 'Unit B',
            owner: 'subagent',
            fileScope: ['src/b.ts'],
            dependsOn: ['unit-a'],
            doneCriteria: ['Done B'],
          },
          {
            id: 'unit-a',
            title: 'Unit A',
            owner: 'subagent',
            fileScope: ['src/a.ts'],
            dependsOn: [],
            doneCriteria: ['Done A'],
          },
        ],
        mergeOrder: [],
      };

      const res = freezeContract(contract);
      expect(res.ok).toBe(true);
      expect(res.errors).toHaveLength(0);
      expect(res.frozenContract?.mergeOrder).toEqual(['unit-a', 'unit-b']);
    });

    it('rejects dependency cycles with hard error', () => {
      const cyclicContract: FanoutContract = {
        id: 'fanout-cycle',
        goalDigest: 'goal-123',
        baseRevision: 'git-rev-1',
        safetyProfileRevision: 'sp-1',
        units: [
          {
            id: 'unit-1',
            title: 'Unit 1',
            owner: 'subagent',
            fileScope: ['src/1.ts'],
            dependsOn: ['unit-2'],
            doneCriteria: ['1'],
          },
          {
            id: 'unit-2',
            title: 'Unit 2',
            owner: 'subagent',
            fileScope: ['src/2.ts'],
            dependsOn: ['unit-1'],
            doneCriteria: ['2'],
          },
        ],
        mergeOrder: [],
      };

      const res = freezeContract(cyclicContract);
      expect(res.ok).toBe(false);
      expect(res.errors.some((e) => e.includes('chu trình phụ thuộc'))).toBe(true);
    });

    it('rejects overlapping fileScope without explicit dependsOn', () => {
      const overlapContract: FanoutContract = {
        id: 'fanout-overlap',
        goalDigest: 'goal-123',
        baseRevision: 'git-rev-1',
        safetyProfileRevision: 'sp-1',
        units: [
          {
            id: 'unit-x',
            title: 'Unit X',
            owner: 'subagent',
            fileScope: ['src/shared.ts'],
            dependsOn: [],
            doneCriteria: ['x'],
          },
          {
            id: 'unit-y',
            title: 'Unit Y',
            owner: 'subagent',
            fileScope: ['src/shared.ts'],
            dependsOn: [], // Missing dependsOn!
            doneCriteria: ['y'],
          },
        ],
        mergeOrder: [],
      };

      const res = freezeContract(overlapContract);
      expect(res.ok).toBe(false);
      expect(res.errors.some((e) => e.includes('Xung đột phạm vi file'))).toBe(true);
    });

    it('allows overlapping fileScope when explicit dependsOn is declared', () => {
      const sequencedContract: FanoutContract = {
        id: 'fanout-seq',
        goalDigest: 'goal-123',
        baseRevision: 'git-rev-1',
        safetyProfileRevision: 'sp-1',
        units: [
          {
            id: 'unit-1',
            title: 'Unit 1',
            owner: 'subagent',
            fileScope: ['src/shared.ts'],
            dependsOn: [],
            doneCriteria: ['1'],
          },
          {
            id: 'unit-2',
            title: 'Unit 2',
            owner: 'subagent',
            fileScope: ['src/shared.ts'],
            dependsOn: ['unit-1'], // Declared dependency!
            doneCriteria: ['2'],
          },
        ],
        mergeOrder: [],
      };

      const res = freezeContract(sequencedContract);
      expect(res.ok).toBe(true);
      expect(res.errors).toHaveLength(0);
    });

    it('enforces SpawnPlan requirements when units count > 4', () => {
      const makeUnits = (n: number): UnitContract[] =>
        Array.from({ length: n }, (_, i) => ({
          id: `u-${i}`,
          title: `Unit ${i}`,
          owner: 'subagent',
          fileScope: [`src/${i}.ts`],
          dependsOn: [],
          doneCriteria: [`Done ${i}`],
        }));

      const bigContract: FanoutContract = {
        id: 'fanout-big',
        goalDigest: 'goal-123',
        baseRevision: 'git-rev-1',
        safetyProfileRevision: 'sp-1',
        units: makeUnits(5),
        mergeOrder: [],
      };

      // Missing plan
      const resMissing = freezeContract(bigContract);
      expect(resMissing.ok).toBe(false);
      expect(resMissing.errors.some((e) => e.includes('Bắt buộc phải có SpawnPlan'))).toBe(true);

      // Incomplete plan
      bigContract.spawnPlan = {
        why_parallel: 'Speed',
        why_not_single_unit: 'Too big',
        independence: 'Separate files',
        expected_evidence_shape: '', // missing
      };
      const resIncomplete = freezeContract(bigContract);
      expect(resIncomplete.ok).toBe(false);
      expect(resIncomplete.errors.some((e) => e.includes('thiếu trường bắt buộc'))).toBe(true);

      // Exceeding 280 chars
      bigContract.spawnPlan.expected_evidence_shape = 'x'.repeat(300);
      const resTooLong = freezeContract(bigContract);
      expect(resTooLong.ok).toBe(false);
      expect(resTooLong.errors.some((e) => e.includes('vượt quá giới hạn 280 ký tự'))).toBe(true);

      // Valid plan
      bigContract.spawnPlan.expected_evidence_shape = 'Vitest report per module';
      const resValid = freezeContract(bigContract);
      expect(resValid.ok).toBe(true);
      expect(resValid.errors).toHaveLength(0);
    });
  });

  describe('classifyFailure, probeReplaySafety & Backoff', () => {
    it('classifies exitCode !== 0 as terminal test_failure (never transient)', () => {
      const res = classifyFailure(new Error('Test crashed'), 1);
      expect(res.isTransient).toBe(false);
      expect(res.category).toBe('test_failure');
    });

    it('classifies HTTP 429 and rate limits as transient', () => {
      const res = classifyFailure(new Error('Rate limit exceeded: 429 Too Many Requests'));
      expect(res.isTransient).toBe(true);
      expect(res.category).toBe('rate_limit');
    });

    it('classifies network connection drops as transient transport', () => {
      const res = classifyFailure(new Error('fetch failed: ECONNRESET'));
      expect(res.isTransient).toBe(true);
      expect(res.category).toBe('transport');
    });

    it('detects side-effects and blocks replay safety', () => {
      const dirtyState = {
        filesModified: 1,
        bytesWritten: 120,
        gitStatusDirty: true,
      };
      const probeDirty = probeReplaySafety(dirtyState);
      expect(probeDirty.replaySafe).toBe(false);
      expect(probeDirty.reason).toContain('Phát hiện side effect');

      const cleanState = {
        filesModified: 0,
        bytesWritten: 0,
        gitStatusDirty: false,
      };
      const probeClean = probeReplaySafety(cleanState);
      expect(probeClean.replaySafe).toBe(true);
    });

    it('computes exponential backoff with jitter within bounded range', () => {
      const b1 = computeBackoffMs(1);
      expect(b1).toBeGreaterThanOrEqual(1500); // 2000 * 0.75
      expect(b1).toBeLessThanOrEqual(2000);

      const b3 = computeBackoffMs(3);
      expect(b3).toBeGreaterThanOrEqual(6000); // 8000 * 0.75
      expect(b3).toBeLessThanOrEqual(8000);
    });
  });

  describe('DependencyFrontierScheduler & Adaptive Admission', () => {
    it('dispatches ready units immediately along the frontier without waiting for waves', () => {
      const contract: FanoutContract = {
        id: 'fanout-frontier',
        goalDigest: 'g-1',
        baseRevision: 'r-1',
        safetyProfileRevision: 's-1',
        units: [
          { id: 'u1', title: 'U1', owner: 'subagent', fileScope: ['1.ts'], dependsOn: [], doneCriteria: [] },
          { id: 'u2', title: 'U2', owner: 'subagent', fileScope: ['2.ts'], dependsOn: ['u1'], doneCriteria: [] },
          { id: 'u3', title: 'U3', owner: 'subagent', fileScope: ['3.ts'], dependsOn: [], doneCriteria: [] },
        ],
        mergeOrder: [],
      };

      const scheduler = new DependencyFrontierScheduler(contract, { initialConcurrency: 2 });
      expect(scheduler.getAdmission()).toBe(2);

      // Initially, u1 and u3 have no deps -> dispatched
      const wave1 = scheduler.pullReadyUnits();
      expect(wave1.map((u) => u.id).sort()).toEqual(['u1', 'u3']);
      expect(scheduler.getRunningCount()).toBe(2);

      // u1 completes -> admission increases (+1), u2 becomes ready because u1 is done!
      scheduler.reportSuccess('u1');
      expect(scheduler.getAdmission()).toBe(3);

      const wave2 = scheduler.pullReadyUnits();
      expect(wave2.map((u) => u.id)).toEqual(['u2']);

      scheduler.reportSuccess('u3');
      scheduler.reportSuccess('u2');
      expect(scheduler.isDone()).toBe(true);
    });

    it('cascades failure to downstream dependents when upstream fails', () => {
      const contract: FanoutContract = {
        id: 'fanout-cascade',
        goalDigest: 'g-1',
        baseRevision: 'r-1',
        safetyProfileRevision: 's-1',
        units: [
          { id: 'u-base', title: 'Base', owner: 'subagent', fileScope: ['base.ts'], dependsOn: [], doneCriteria: [] },
          { id: 'u-down', title: 'Down', owner: 'subagent', fileScope: ['down.ts'], dependsOn: ['u-base'], doneCriteria: [] },
        ],
        mergeOrder: [],
      };

      const scheduler = new DependencyFrontierScheduler(contract);
      const ready = scheduler.pullReadyUnits();
      expect(ready[0].id).toBe('u-base');

      scheduler.reportFailure('u-base');

      // Now pullReadyUnits: u-down depends on failed u-base -> cascaded to fail
      const next = scheduler.pullReadyUnits();
      expect(next).toHaveLength(0);
      const status = scheduler.getStatus();
      expect(status.failed).toContain('u-base');
      expect(status.failed).toContain('u-down');
      expect(scheduler.isDone()).toBe(true);
    });

    it('halves admission concurrency on rate-limit pressure with a floor of 1', () => {
      const contract: FanoutContract = {
        id: 'fanout-rl',
        goalDigest: 'g-1',
        baseRevision: 'r-1',
        safetyProfileRevision: 's-1',
        units: [
          { id: 'u1', title: 'U1', owner: 'subagent', fileScope: ['1.ts'], dependsOn: [], doneCriteria: [] },
        ],
        mergeOrder: [],
      };

      const scheduler = new DependencyFrontierScheduler(contract, { initialConcurrency: 4 });
      expect(scheduler.getAdmission()).toBe(4);

      scheduler.pullReadyUnits();
      scheduler.reportRateLimit('u1');
      expect(scheduler.getAdmission()).toBe(2);

      scheduler.reportRateLimit('u1');
      expect(scheduler.getAdmission()).toBe(1);

      // Floor of 1
      scheduler.reportRateLimit('u1');
      expect(scheduler.getAdmission()).toBe(1);
    });
  });
});
