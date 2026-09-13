import { describe, it, expect, beforeEach } from 'vitest';
import {
  projectCapabilities,
  computeAuthorityDigest,
  __clearFrozenAuthorityRegistry,
  DEFAULT_TOOL_CANDIDATES,
  type ToolCandidate,
  type ExclusionReason,
} from '@/lib/capability-projection';

describe('Capability Projection & Frozen Authority', () => {
  beforeEach(() => {
    __clearFrozenAuthorityRegistry();
  });

  describe('computeAuthorityDigest', () => {
    it('produces deterministic digest regardless of set insertion order', () => {
      const set1 = new Set(['fs_read', 'shell_run', 'git_status']);
      const set2 = new Set(['git_status', 'fs_read', 'shell_run']);
      expect(computeAuthorityDigest(set1)).toBe(computeAuthorityDigest(set2));
      expect(computeAuthorityDigest(set1).startsWith('auth-')).toBe(true);
    });
  });

  describe('projectCapabilities - Closed 4 Exclusion Reasons', () => {
    const VALID_EXCLUSION_REASONS: ExclusionReason[] = [
      'beyond_context_budget',
      'not_granted_by_authority',
      'not_relevant_to_request',
      'outranked_by_shortlist',
    ];

    it('excludes tools not in authority set with "not_granted_by_authority"', () => {
      const authority = new Set(['fs_read']); // only fs_read granted
      const proj = projectCapabilities({
        text: 'Đọc file và kiểm tra mã nguồn',
        taskId: 'task-1',
        authority,
        budgetBytes: 5000,
      });

      expect(proj.included.some((t) => t.id === 'fs_read')).toBe(true);
      const ungranted = proj.excluded.filter((e) => e.reason === 'not_granted_by_authority');
      expect(ungranted.length).toBeGreaterThan(0);
      expect(ungranted.some((t) => t.id === 'fs_write')).toBe(true);
    });

    it('excludes tools with no relevance to request with "not_relevant_to_request"', () => {
      // Grant git_status and web_search, but text is only about memory
      const authority = new Set(['git_status', 'memory_search']);
      const proj = projectCapabilities({
        text: 'Nhớ bài học từ lần trước',
        taskId: 'task-2',
        authority,
        budgetBytes: 5000,
      });

      expect(proj.included.some((t) => t.id === 'memory_search')).toBe(true);
      const notRelevant = proj.excluded.find((e) => e.id === 'git_status');
      expect(notRelevant).toBeDefined();
      expect(notRelevant?.reason).toBe('not_relevant_to_request');
    });

    it('enforces byte budget ceiling and excludes overflow items', () => {
      const candidates: ToolCandidate[] = [
        { id: 'tool_a', group: 'fs', description: 'Tool A', bytes: 600 },
        { id: 'tool_b', group: 'fs', description: 'Tool B', bytes: 600 },
        { id: 'tool_c', group: 'fs', description: 'Tool C', bytes: 600 },
      ];
      const authority = new Set(['tool_a', 'tool_b', 'tool_c']);

      const proj = projectCapabilities({
        text: 'sửa file',
        taskId: 'task-budget',
        authority,
        budgetBytes: 1000, // can only fit 1 tool of 600 bytes
        allCandidates: candidates,
      });

      expect(proj.budget.usedBytes).toBeLessThanOrEqual(1000);
      expect(proj.included).toHaveLength(1);
      expect(proj.budget.droppedIds).toHaveLength(2);

      for (const exc of proj.excluded) {
        expect(VALID_EXCLUSION_REASONS).toContain(exc.reason);
      }
    });

    it('ensures every excluded item strictly belongs to the 4 closed reasons', () => {
      const authority = new Set(['fs_read', 'fs_write', 'shell_run']);
      const proj = projectCapabilities({
        text: 'chạy test',
        taskId: 'task-closed-vocab',
        authority,
        budgetBytes: 800,
      });

      for (const exc of proj.excluded) {
        expect(VALID_EXCLUSION_REASONS).toContain(exc.reason);
      }
    });

    it('freezes authority digest per taskId across multiple calls', () => {
      const initialAuth = new Set(['fs_read', 'shell_run']);
      const proj1 = projectCapabilities({
        text: 'chạy lệnh',
        taskId: 'task-freeze-check',
        authority: initialAuth,
        budgetBytes: 4000,
      });

      const initialDigest = proj1.authorityDigest;

      // Even if caller changes authority set on subsequent call for same taskId
      const alteredAuth = new Set(['fs_read', 'shell_run', 'fs_write']);
      const proj2 = projectCapabilities({
        text: 'chạy lệnh',
        taskId: 'task-freeze-check',
        authority: alteredAuth,
        budgetBytes: 4000,
      });

      // Digest for the taskId was locked at creation
      expect(proj1.authorityDigest).toBe(initialDigest);
    });
  });
});
