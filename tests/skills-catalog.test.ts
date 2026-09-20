/**
 * Skills catalog — danh mục kỹ năng curate sẵn + matcher theo yêu cầu.
 *
 * (Tách ra từ tests/p1-p2.test.ts khi các tính năng P1-E fanout, ast-search,
 * codegraph và project-terms bị gỡ khỏi sản phẩm — chỉ khối này còn tương ứng
 * với code đang chạy trong app/api/chat/route.ts.)
 */
import { describe, it, expect } from 'vitest';
import {
  SKILLS_CATALOG,
  matchSkillsForRequest,
  generateSkillsPrompt,
} from '@/lib/skills/catalog';
describe('P2 Skills Catalog & Request Matcher', () => {
  it('contains curated skills covering the full stack', () => {
    const ids = SKILLS_CATALOG.map((s) => s.id);
    expect(ids).toContain('next-app-router');
    expect(ids).toContain('react-perf');
    expect(ids).toContain('tailwind-ui');
    expect(ids).toContain('dexie-migration');
    expect(ids).toContain('vitest');
    expect(ids).toContain('security-review');
    expect(ids).toContain('api-route-hardening');
    expect(ids).toContain('refactor-plan');
  });

  it('matches skills based on explicit keywords and triggers', () => {
    const matched = matchSkillsForRequest('Cần tối ưu App Router và route handler streaming trong Next.js');
    expect(matched.some((s) => s.id === 'next-app-router')).toBe(true);

    const matchedDexie = matchSkillsForRequest('Cần nâng cấp database schema Dexie và migration IndexedDB');
    expect(matchedDexie.some((s) => s.id === 'dexie-migration')).toBe(true);
  });

  it('generates rich instruction prompts for matched skills', () => {
    const matched = matchSkillsForRequest('viết unit test vitest');
    const prompt = generateSkillsPrompt(matched);
    expect(prompt).toContain('KỸ NĂNG CHUYÊN MÔN KÍCH HOẠT');
    expect(prompt).toContain('Vitest Unit & Integration Testing');
  });
});
