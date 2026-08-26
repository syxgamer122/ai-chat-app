import { describe, expect, it } from 'vitest';
import { formatSkillsBlock, matchActiveSkills, SKILL_LIMITS } from '@/lib/skills';
import type { SkillLike } from '@/lib/skills';

const SKILLS: SkillLike[] = [
  {
    id: 's1',
    name: 'Viết email công việc',
    description: 'soạn email gửi sếp, khách hàng, đơn từ nghỉ phép',
    body: 'BODY_EMAIL',
  },
  {
    id: 's2',
    name: 'Giải thích code',
    description: 'giải thích đoạn code, hàm, thuật toán cho người mới',
    body: 'BODY_CODE',
  },
];

describe('matchActiveSkills — matcher fold dấu tiếng Việt', () => {
  it('khớp từ khóa có dấu/không dấu ("soạn email" vs "soan email")', () => {
    const r = matchActiveSkills(SKILLS, 'giúp tớ soạn email xin nghỉ phép cho sếp');
    expect(r.map((s) => s.id)).toEqual(['s1']);
  });

  it('tên skill xuất hiện nguyên vẹn → cộng điểm mạnh', () => {
    const r = matchActiveSkills(SKILLS, 'giải thích code này giùm tôi');
    expect(r[0]?.id).toBe('s2');
  });

  it('không khớp gì → rỗng (không đốt token)', () => {
    expect(matchActiveSkills(SKILLS, 'thủ đô của Lào là đâu?')).toEqual([]);
    expect(matchActiveSkills(SKILLS, '')).toEqual([]);
  });

  it('tin nhắn ngắn generic không kích hoạt oan ("hello", "ok")', () => {
    expect(matchActiveSkills(SKILLS, 'hello ok')).toEqual([]);
  });

  it(`cap tối đa ${SKILL_LIMITS.maxPerTurn} skill mỗi lượt`, () => {
    const many: SkillLike[] = Array.from({ length: 5 }, (_, i) => ({
      id: `x${i}`,
      name: `skill xử lý chủ đề số ${i}`,
      description: 'chuyên gia phân tích báo cáo tài chính doanh nghiệp',
      body: 'B',
    }));
    const r = matchActiveSkills(many, 'phân tích báo cáo tài chính cho mọi chủ đề');
    expect(r.length).toBeLessThanOrEqual(SKILL_LIMITS.maxPerTurn);
  });
});

describe('formatSkillsBlock — khối system phía server', () => {
  it('rỗng khi không có skill', () => {
    expect(formatSkillsBlock([])).toBe('');
  });

  it('liệt kê tên + mô tả + body + quy tắc ưu tiên người dùng', () => {
    const block = formatSkillsBlock([
      { name: 'Viết email', description: 'email công việc', body: 'BODY Ở ĐÂY' },
    ]);
    expect(block).toContain('[KỸ NĂNG ĐANG KÍCH HOẠT');
    expect(block).toContain('## Viết email');
    expect(block).toContain('(email công việc)');
    expect(block).toContain('BODY Ở ĐÂY');
    expect(block).toContain('ý người dùng thắng');
  });

  it('trần tổng: skill sau không nhồi vượt ngân sách', () => {
    const big = { name: 'To', body: 'X'.repeat(SKILL_LIMITS.bodyChars + 1) };
    const block = formatSkillsBlock([big, big]);
    // Body bị cắt về bodyChars; hai skill vẫn không vượt totalChars*1.5 nhiều.
    expect(block.length).toBeLessThan(SKILL_LIMITS.totalChars * 2);
    expect(block.split('## To').length - 1).toBeLessThanOrEqual(2);
  });
});
