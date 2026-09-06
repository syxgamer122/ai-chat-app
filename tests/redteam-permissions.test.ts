/**
 * RED TEAM — updateToolPermission (components/tools-panel.tsx).
 *
 * Giá trị lạ phải ném lỗi (bug UI nổ ở dev thay vì lọt vào localStorage);
 * đủ 8 category đổi từng cái mà 7 cái còn lại nguyên vẹn; category '__proto__'
 * không được ô nhiễm Object.prototype. Lý do UI không sinh được giá trị lạ:
 * select chỉ có 4 <option> với value đúng union, e.target.value của select
 * không thể trả giá trị ngoài option — lớp throw là hàng rào thứ hai cho
 * caller khác (auto-pilot, script).
 */
import { describe, expect, it } from 'vitest';
import { updateToolPermission } from '@/components/tools-panel';
import { ALL_TOOL_CATEGORIES, type ToolCategory } from '@/lib/tool-catalog';
import type { ToolPermissions } from '@/lib/store';

const base: ToolPermissions = {
  fs_read: 'default',
  fs_write: 'ask',
  shell: 'default',
  git: 'deny',
  web: 'auto',
  memory: 'default',
  plan: 'ask',
  delegate: 'default',
};

describe('RED TEAM updateToolPermission — giá trị lạ ném lỗi', () => {
  it('DEFAULT / Auto / null / chuỗi rỗng / giá trị có khoảng trắng đều throw', () => {
    for (const bad of ['DEFAULT', 'Auto', 'null', '', 'ask ', '0', 'inherit']) {
      expect(() => updateToolPermission(base, 'shell', bad as never), `giá trị "${bad}"`).toThrow(
        /không hợp lệ/,
      );
    }
  });

  it('giá trị hợp lệ không bao giờ throw', () => {
    for (const ok of ['default', 'auto', 'ask', 'deny'] as const) {
      expect(() => updateToolPermission(base, 'shell', ok)).not.toThrow();
    }
  });
});

describe('RED TEAM updateToolPermission — đổi đủ 8 category, giữ 7 cái còn lại', () => {
  it("mỗi category một lần với 'deny': chỉ key đó đổi", () => {
    for (const cat of ALL_TOOL_CATEGORIES) {
      const next = updateToolPermission(base, cat, 'deny');
      expect(next[cat], `${cat} phải thành 'deny'`).toBe('deny');
      for (const other of ALL_TOOL_CATEGORIES) {
        if (other === cat) continue;
        expect(next[other], `${cat}: ${other} bị đổi`).toBe(base[other]);
      }
    }
  });

  it('category kế tiếp thấy kết quả của lần trước (chuỗi cập nhật nối tiếp)', () => {
    let current = base;
    for (const cat of ALL_TOOL_CATEGORIES) {
      current = updateToolPermission(current, cat, 'auto');
    }
    for (const cat of ALL_TOOL_CATEGORIES) {
      expect(current[cat]).toBe('auto');
    }
  });
});

describe('RED TEAM updateToolPermission — tấn công prototype', () => {
  it("category '__proto__' không ô nhiễm Object.prototype", () => {
    const next = updateToolPermission(base, '__proto__' as ToolCategory, 'auto');
    expect(({} as Record<string, unknown>).fs_read).toBeUndefined();
    expect(({} as Record<string, unknown>).auto).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('fs_read');
    // 8 key gốc vẫn nguyên
    for (const cat of ALL_TOOL_CATEGORIES) {
      expect(next[cat]).toBe(base[cat]);
    }
  });
});
