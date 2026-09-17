import { describe, it, expect } from 'vitest';
import {
  proposeMemory,
  reviewMemory,
  buildRecallPack,
  formatRecallBanner,
  progressMemoryAge,
  formatRecalledMemoriesBlock,
} from '@/lib/memory/recall';
import type { MemoryRecord, MemoryScope } from '@/lib/memory/types';

describe('Long-term Memory with Reviewer Gate & Recall Pack', () => {
  const sampleScope: MemoryScope = {
    kind: 'project',
    ref: 'vyen',
  };

  const sampleProvenance = {
    threadId: 'th-123',
    messageId: 'msg-456',
    files: ['src/core.ts'],
  };

  describe('proposeMemory - Reviewer Gate Invariant', () => {
    it('always creates memories in "pending" status (NEVER direct "active")', () => {
      const candidate = proposeMemory({
        text: 'Luôn dùng vitest thay vì jest trong repo này',
        scope: sampleScope,
        kind: 'rule',
        provenance: sampleProvenance,
      });

      expect(candidate.status).toBe('pending');
      expect(candidate.id.startsWith('cand-')).toBe(true);
      expect(candidate.confirmCount).toBe(1);
      expect(candidate.digest.startsWith('mem-')).toBe(true);
    });

    it('clamps memory text to 400 characters', () => {
      const longText = 'x'.repeat(600);
      const candidate = proposeMemory({
        text: longText,
        scope: sampleScope,
        provenance: sampleProvenance,
      });

      expect(candidate.text.length).toBe(400);
    });
  });

  describe('reviewMemory - State Transitions', () => {
    it('promotes candidate to "active" upon "remember"', () => {
      const candidate = proposeMemory({
        text: 'Cần build trước khi package',
        scope: sampleScope,
        provenance: sampleProvenance,
      });

      const reviewed = reviewMemory(candidate, 'remember');
      expect(reviewed.status).toBe('active');
      expect(reviewed.confirmCount).toBe(2);
      expect(reviewed.lastUsedAt).toBeDefined();
      expect(reviewed.reviewDueAt).toBeDefined();
    });

    it('marks candidate as "refused" with mandatory reason', () => {
      const candidate = proposeMemory({
        text: 'Dùng global state tùy tiện',
        scope: sampleScope,
        provenance: sampleProvenance,
      });

      expect(() => reviewMemory(candidate, 'refuse')).toThrow('bắt buộc phải có lý do');

      const refused = reviewMemory(candidate, 'refuse', { reason: 'Vi phạm kiến trúc' });
      expect(refused.status).toBe('refused');
      expect(refused.reason).toBe('Vi phạm kiến trúc');
    });

    it('defers candidate with updated reviewDueAt', () => {
      const candidate = proposeMemory({
        text: 'Cần xem xét thêm quy chuẩn ESLint',
        scope: sampleScope,
        provenance: sampleProvenance,
      });

      const deferred = reviewMemory(candidate, 'defer', { reason: 'Đợi bản nâng cấp ESLint 9' });
      expect(deferred.status).toBe('pending');
      expect(deferred.reason).toBe('Đợi bản nâng cấp ESLint 9');
      expect(deferred.reviewDueAt).toBeDefined();
    });
  });

  describe('buildRecallPack - Ranking, Token Budget & Conflict Resolution', () => {
    const fixedNow = 1772500000000;

    const activeMemory1: MemoryRecord = {
      id: 'mem-1',
      scope: { kind: 'project', ref: 'vyen' },
      kind: 'rule',
      text: 'Vitest là test runner chính, không chạy jest',
      provenance: { threadId: 'th-1' },
      status: 'active',
      confirmCount: 3,
      createdAt: fixedNow - 86400_000, // 1 day ago
      digest: 'mem-1',
    };

    const activeMemory2: MemoryRecord = {
      id: 'mem-2',
      scope: { kind: 'thread', ref: 'th-curr' },
      kind: 'gotcha',
      text: 'File package.json cần dùng tab thay vì space',
      provenance: { threadId: 'th-curr' },
      status: 'active',
      confirmCount: 1,
      createdAt: fixedNow - 3600_000,
      digest: 'mem-2',
    };

    const pendingCandidate: MemoryRecord = {
      id: 'cand-9',
      scope: { kind: 'project', ref: 'vyen' },
      kind: 'rule',
      text: 'Không nên đưa vào pack vì chưa được duyệt',
      provenance: { threadId: 'th-1' },
      status: 'pending',
      confirmCount: 1,
      createdAt: fixedNow,
      digest: 'cand-9',
    };

    it('strictly filters out pending and refused records', () => {
      const pack = buildRecallPack([activeMemory1, pendingCandidate], {
        taskText: 'chạy test vitest',
        scope: { kind: 'project', ref: 'vyen' },
        now: fixedNow,
      });

      expect(pack.items.some((i) => i.id === 'mem-1')).toBe(true);
      expect(pack.items.some((i) => i.id === 'cand-9')).toBe(false);
    });

    it('enforces token budget and records droppedIds', () => {
      const pack = buildRecallPack([activeMemory1, activeMemory2], {
        taskText: 'vitest test runner package',
        scope: { kind: 'project', ref: 'vyen' },
        budgetTokens: 12, // small budget, only 1 will fit
        now: fixedNow,
      });

      expect(pack.items.length).toBe(1);
      expect(pack.budget.droppedIds.length).toBe(1);
      expect(pack.budget.usedTokens).toBeLessThanOrEqual(12);
    });

    it('resolves conflicts by preferring narrower scope (thread > project > user)', () => {
      const projectRule: MemoryRecord = {
        id: 'mem-proj-rule',
        scope: { kind: 'project', ref: 'vyen' },
        kind: 'rule',
        text: 'Quy chuẩn đặt tên file là kebab-case',
        provenance: { threadId: 'th-1' },
        status: 'active',
        confirmCount: 1,
        createdAt: fixedNow - 1000,
        digest: 'digest-rule',
      };

      const threadOverride: MemoryRecord = {
        id: 'mem-thread-rule',
        scope: { kind: 'thread', ref: 'th-special' },
        kind: 'rule',
        text: 'Quy chuẩn đặt tên file là kebab-case', // duplicate text with narrower scope
        provenance: { threadId: 'th-special' },
        status: 'active',
        confirmCount: 1,
        createdAt: fixedNow,
        digest: 'digest-rule-2',
      };

      const pack = buildRecallPack([projectRule, threadOverride], {
        taskText: 'đặt tên file',
        scope: { kind: 'thread', ref: 'th-special' },
        now: fixedNow,
      });

      expect(pack.items).toHaveLength(1);
      expect(pack.items[0].id).toBe('mem-thread-rule'); // thread scope won
      expect(pack.conflicts).toHaveLength(1);
      expect(pack.conflicts[0].rule).toBe('narrower_scope_wins');
      expect(pack.conflicts[0].keptId).toBe('mem-thread-rule');
      expect(pack.conflicts[0].droppedId).toBe('mem-proj-rule');
    });

    it('resolves conflicts by preferring newer reviewed record when scope is identical', () => {
      const olderRecord: MemoryRecord = {
        id: 'mem-older',
        scope: { kind: 'project', ref: 'vyen' },
        kind: 'rule',
        text: 'Quy chuẩn đặt tên file là kebab-case',
        provenance: { threadId: 'th-1' },
        status: 'active',
        confirmCount: 5, // higher confirm count gives higher score
        createdAt: fixedNow - 100_000,
        digest: 'digest-old',
      };

      const newerRecord: MemoryRecord = {
        id: 'mem-newer',
        scope: { kind: 'project', ref: 'vyen' },
        kind: 'rule',
        text: 'Quy chuẩn đặt tên file là kebab-case',
        provenance: { threadId: 'th-2' },
        status: 'active',
        confirmCount: 1, // lower score but newer createdAt
        createdAt: fixedNow,
        digest: 'digest-new',
      };

      const pack = buildRecallPack([olderRecord, newerRecord], {
        taskText: 'đặt tên file',
        scope: { kind: 'project', ref: 'vyen' },
        now: fixedNow,
      });

      expect(pack.items).toHaveLength(1);
      expect(pack.items[0].id).toBe('mem-newer'); // newer wins
      expect(pack.conflicts).toHaveLength(1);
      expect(pack.conflicts[0].rule).toBe('newer_reviewed_wins');
      expect(pack.conflicts[0].keptId).toBe('mem-newer');
      expect(pack.conflicts[0].droppedId).toBe('mem-older');
    });

    it('rejects whitespace-only refusal reason', () => {
      const candidate = proposeMemory({
        text: 'Quy chuẩn kiểm thử',
        scope: sampleScope,
        provenance: sampleProvenance,
      });

      expect(() => reviewMemory(candidate, 'refuse', { reason: '   ' })).toThrow('bắt buộc phải có lý do');
    });

    it('progresses memory age through active -> reference -> archive', () => {
      const activeRecord: MemoryRecord = {
        id: 'mem-active',
        scope: sampleScope,
        kind: 'rule',
        text: 'Kiểm tra tuổi thọ',
        provenance: sampleProvenance,
        status: 'active',
        confirmCount: 1,
        createdAt: fixedNow - 60 * 86400_000,
        reviewDueAt: new Date(fixedNow - 86400_000).toISOString(), // expired
        digest: 'digest-age',
      };

      const aged1 = progressMemoryAge(activeRecord, fixedNow);
      expect(aged1.status).toBe('reference');

      const aged2 = progressMemoryAge({
        ...aged1,
        reviewDueAt: new Date(fixedNow - 86400_000).toISOString(),
      }, fixedNow);
      expect(aged2.status).toBe('archive');
    });

    it('formats recall prompt block for non-lesson memories', () => {
      const block = formatRecalledMemoriesBlock([
        { text: 'Tuân thủ quy ước TypeScript nghiêm ngặt' },
        { text: '[LESSON:RULE] Bài học lesson sẽ bị loại khỏi block chung' },
      ]);

      expect(block).toContain('BỘ NHỚ DÀI HẠN ĐÃ DUYỆT');
      expect(block).toContain('Tuân thủ quy ước TypeScript nghiêm ngặt');
      expect(block).not.toContain('[LESSON:RULE]');
    });

    it('formats recall banner correctly', () => {
      const bannerWithItems = formatRecallBanner({
        items: [{ id: '1', text: 'test', why: 'why', score: 10 }],
        budget: { limitTokens: 100, usedTokens: 10, droppedIds: [] },
        conflicts: [],
      });
      expect(bannerWithItems).toBe('🧠 Đã nhớ 1 ghi chú');

      const emptyBanner = formatRecallBanner({
        items: [],
        budget: { limitTokens: 100, usedTokens: 0, droppedIds: [] },
        conflicts: [],
      });
      expect(emptyBanner).toBeNull();
    });
  });
});
