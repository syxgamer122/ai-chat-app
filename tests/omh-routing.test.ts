import { describe, it, expect } from 'vitest';
import {
  scoreRequest,
} from '@/lib/routing/score-request';
import {
  resolveRoute,
  validateModelChains,
  DEFAULT_CHAINS,
  ALL_CATEGORIES,
  type CategoryId,
} from '@/lib/routing/categories';

describe('Mixture-of-Models Routing & Request Scoring Protocol', () => {
  describe('scoreRequest - 20 Sample Requests and Edge Cases', () => {
    // 1-3. Architect category
    it('1. routes explicit architecture design to architect', () => {
      const res = scoreRequest({ text: 'Thiết kế kiến trúc hệ thống distributed cache' });
      expect(res.category).toBe('architect');
      expect(res.signals).toContain('architectural_signal');
    });

    it('2. routes Plan Mode to architect regardless of short text', () => {
      const res = scoreRequest({ text: 'Viết tính năng mới', isPlanMode: true });
      expect(res.category).toBe('architect');
      expect(res.signals).toContain('plan_mode_active');
    });

    it('3. routes broad file scope (>5 files) with refactor to architect', () => {
      const res = scoreRequest({
        text: 'Refactor module auth và session',
        fileScope: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      });
      expect(res.category).toBe('architect');
    });

    // 4-6. Ultrabrain category
    it('4. routes formal verification & distributed consensus to ultrabrain', () => {
      const res = scoreRequest({ text: 'Giải bài toán rất khó về formal verification của distributed consensus' });
      expect(res.category).toBe('ultrabrain');
      expect(res.signals).toContain('ultrabrain_signal');
    });

    it('5. routes NP-hard optimization to ultrabrain', () => {
      const res = scoreRequest({ text: 'Chứng minh toán học và tối ưu bài toán NP-hard' });
      expect(res.category).toBe('ultrabrain');
      expect(res.signals).toContain('ultrabrain_signal');
    });

    it('6. routes advanced cryptography to ultrabrain', () => {
      const res = scoreRequest({ text: 'Thiết kế thuật toán phức tạp với advanced cryptography' });
      expect(res.category).toBe('ultrabrain');
      expect(res.signals).toContain('ultrabrain_signal');
    });

    // 7-9. Deep reasoning category
    it('7. routes root cause analysis to deep', () => {
      const res = scoreRequest({ text: 'Suy luận sâu tìm root cause memory leak trong connection pool' });
      expect(res.category).toBe('deep');
      expect(res.signals).toContain('deep_reasoning_signal');
    });

    it('8. routes race condition debugging to deep', () => {
      const res = scoreRequest({ text: 'Debug lỗi race condition và deadlock giữa hai worker' });
      expect(res.category).toBe('deep');
      expect(res.signals).toContain('deep_reasoning_signal');
    });

    it('9. routes test failure investigation to deep', () => {
      const res = scoreRequest({ text: 'Điều tra nguyên nhân gốc rễ tại sao test này fail ngẫu nhiên' });
      expect(res.category).toBe('deep');
      expect(res.signals).toContain('deep_reasoning_signal');
    });

    // 10-12. Visual UI category
    it('10. routes CSS & Tailwind layout styling to visual-engineering', () => {
      const res = scoreRequest({ text: 'Chỉnh sửa CSS và tailwind cho responsive layout trên mobile' });
      expect(res.category).toBe('visual-engineering');
      expect(res.signals).toContain('visual_engineering_signal');
    });

    it('11. routes Dark mode & styling to visual-engineering', () => {
      const res = scoreRequest({ text: 'Thêm theme dark mode và chỉnh button style' });
      expect(res.category).toBe('visual-engineering');
      expect(res.signals).toContain('visual_engineering_signal');
    });

    it('12. routes UI component visual polish to visual-engineering', () => {
      const res = scoreRequest({ text: 'Cải thiện giao diện bảng điều khiển với animation mượt mà' });
      expect(res.category).toBe('visual-engineering');
      expect(res.signals).toContain('visual_engineering_signal');
    });

    // 13-14. Writing category
    it('13. routes README & documentation writing to writing', () => {
      const res = scoreRequest({ text: 'Viết tài liệu README hướng dẫn cài đặt và sử dụng API' });
      expect(res.category).toBe('writing');
      expect(res.signals).toContain('writing_signal');
    });

    it('14. routes translation to writing', () => {
      const res = scoreRequest({ text: 'Dịch sang tiếng Anh tài liệu release notes này' });
      expect(res.category).toBe('writing');
      expect(res.signals).toContain('writing_signal');
    });

    // 15-16. Quick category
    it('15. routes renaming symbols to quick', () => {
      const res = scoreRequest({ text: 'Đổi tên biến userId thành accountId' });
      expect(res.category).toBe('quick');
      expect(res.signals).toContain('rename_or_minor_tweak');
    });

    it('16. routes fixing typo in single file to quick', () => {
      const res = scoreRequest({ text: 'Sửa typo trong file này', fileScope: ['app.ts'] });
      expect(res.category).toBe('quick');
    });

    // 17. Simple work
    it('17. routes syntax checking or simple greeting to simple-work', () => {
      const res = scoreRequest({ text: 'Kiểm tra cú pháp' });
      expect(res.category).toBe('simple-work');
      expect(res.signals).toContain('simple_work_signal');
    });

    // 18. Capable (fallback)
    it('18. routes standard feature implementation to capable', () => {
      const res = scoreRequest({ text: 'Tạo hàm tiện ích parse query string và trả về URLSearchParams' });
      expect(res.category).toBe('capable');
      expect(res.signals).toContain('standard_coding_fallback');
    });

    // 19-20. Exhaustive search triggers & negative controls
    it('19. detects exhaustive search and sets flag', () => {
      const res = scoreRequest({ text: 'Tìm mọi chỗ dùng hàm executeCommand trong toàn bộ repo' });
      expect(res.exhaustiveSearch).toBe(true);
      expect(res.signals).toContain('exhaustive_search');
      expect(res.category).toBe('deep');
    });

    it('20. detects find all references exhaustive search trigger', () => {
      const res = scoreRequest({ text: 'Find all references of UserService and report usage' });
      expect(res.exhaustiveSearch).toBe(true);
      expect(res.signals).toContain('exhaustive_search');
    });
  });

  describe('resolveRoute & Fallback Chains', () => {
    it('provides valid default chains for all 8 categories', () => {
      for (const cat of ALL_CATEGORIES) {
        const chain = DEFAULT_CHAINS[cat];
        expect(chain).toBeDefined();
        expect(chain.length).toBeGreaterThanOrEqual(2);
        for (const entry of chain) {
          expect(entry.model).toBeDefined();
          expect(['low', 'medium', 'high', 'max']).toContain(entry.effort);
        }
      }
    });

    it('resolves primary entry (position 0) by default', () => {
      const receipt = resolveRoute('architect');
      expect(receipt.category).toBe('architect');
      expect(receipt.chainPosition).toBe(0);
      expect(receipt.selected.model).toBe(DEFAULT_CHAINS.architect[0].model);
    });

    it('resolves fallback entry when position > 0', () => {
      const receipt = resolveRoute('architect', { position: 1 });
      expect(receipt.chainPosition).toBe(1);
      expect(receipt.selected.model).toBe(DEFAULT_CHAINS.architect[1].model);
    });

    it('clamps position safely when out of range', () => {
      const receipt = resolveRoute('architect', { position: 999 });
      const lastIndex = DEFAULT_CHAINS.architect.length - 1;
      expect(receipt.chainPosition).toBe(lastIndex);
      expect(receipt.selected.model).toBe(DEFAULT_CHAINS.architect[lastIndex].model);
    });

    it('applies customChains override when provided', () => {
      const custom: Partial<Record<CategoryId, Array<{ model: string; effort: 'low' | 'medium' | 'high' | 'max' }>>> = {
        quick: [{ model: 'gpt-5-6-sol', effort: 'medium' }],
      };
      const receipt = resolveRoute('quick', { customChains: custom });
      expect(receipt.selected.model).toBe('gpt-5-6-sol');
      expect(receipt.selected.effort).toBe('medium');
    });

    it('enforces model contract effort floor during route resolution', () => {
      // o1 has effortFloor: 'medium'
      const custom: Partial<Record<CategoryId, Array<{ model: string; effort: 'low' | 'medium' | 'high' | 'max' }>>> = {
        quick: [{ model: 'o1', effort: 'low' }],
      };
      const receipt = resolveRoute('quick', { customChains: custom });
      expect(receipt.selected.model).toBe('o1');
      expect(receipt.selected.effort).toBe('medium'); // raised from low to medium
      expect(receipt.effortChange).toEqual({
        kind: 'floor_raised',
        from: 'low',
        to: 'medium',
      });
    });
  });

  describe('validateModelChains JSON Import Validation', () => {
    it('accepts a valid JSON chains payload', () => {
      const payload = {
        architect: [{ model: 'claude-opus-5', effort: 'high' }],
        quick: [{ model: 'gpt-4o-mini', effort: 'low' }],
      };
      const validated = validateModelChains(payload);
      expect(validated.architect).toEqual([{ model: 'claude-opus-5', effort: 'high' }]);
      expect(validated.quick).toEqual([{ model: 'gpt-4o-mini', effort: 'low' }]);
      // Untouched categories keep defaults
      expect(validated.ultrabrain).toEqual(DEFAULT_CHAINS.ultrabrain);
    });

    it('rejects array payloads', () => {
      expect(() => validateModelChains([1, 2, 3])).toThrow('JSON Object');
    });

    it('rejects null or non-object payloads', () => {
      expect(() => validateModelChains(null)).toThrow('JSON Object');
      expect(() => validateModelChains('hello')).toThrow('JSON Object');
    });

    it('rejects payloads with no recognized categories', () => {
      expect(() => validateModelChains({ unknown_cat: [] })).toThrow('Không tìm thấy cấu hình hạng mục hợp lệ');
    });

    it('rejects invalid effort levels', () => {
      const badPayload = {
        quick: [{ model: 'gpt-4o-mini', effort: 'super-ultra' }],
      };
      expect(() => validateModelChains(badPayload)).toThrow('không hợp lệ');
    });

    it('rejects entries missing model names', () => {
      const badPayload = {
        quick: [{ model: '', effort: 'low' }],
      };
      expect(() => validateModelChains(badPayload)).toThrow('thiếu tên model');
    });
  });
});
