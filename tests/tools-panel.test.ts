/**
 * Khóa panel "Công cụ & quyền" (components/tools-panel.tsx) vào catalog
 * (lib/tool-catalog.ts).
 *
 * Repo chạy vitest environment 'node' (không jsdom/testing-library) nên phần
 * logic được export thuần: builder sections, bộ lọc search, update quyền và
 * alias resolution. UI markup được khoanh theo pattern design-system.test.ts
 * (đọc nguồn, assert thuộc tính bắt buộc).
 *
 * Mỗi test ghi rõ đột biến mà nó chặn: "nếu tôi đảo/sửa điều kiện này thì
 * test nào đỏ" - đọc comment ngay trên từng `it`.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPanelSections,
  filterPanelSections,
  updateToolPermission,
} from '@/components/tools-panel';
import { TOOL_CATEGORY_ICON_COMPONENTS } from '@/components/tool-category-icons';
import {
  ALL_TOOL_CATEGORIES,
  TOOL_CATALOG,
  TOOL_CATEGORY_LABELS,
  resolveToolEntry,
  type ToolCategory,
} from '@/lib/tool-catalog';
import type { ToolPermissions } from '@/lib/store';

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const VIET_RE = /[ăâđêôơưáàảãạấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

/** Nhãn tiếng Việt mới (khoá localize: ai trả về nhãn English là đỏ ở đây). */
const EXPECTED_LABELS: Record<ToolCategory, { label: string; icon: string }> = {
  fs_read: { label: 'Đọc file', icon: 'folder-open' },
  fs_write: { label: 'Sửa & ghi file', icon: 'pencil' },
  shell: { label: 'Shell & tiến trình nền', icon: 'terminal' },
  git: { label: 'Git', icon: 'git-branch' },
  web: { label: 'Web', icon: 'globe' },
  memory: { label: 'Ghi nhớ & bài học', icon: 'bookmark' },
  plan: { label: 'Kế hoạch', icon: 'list-checks' },
  delegate: { label: 'Subagent', icon: 'users' },
};

/** Tên riêng không dấu được giữ nguyên; ngoài danh sách này phải có dấu. */
const ASCII_PROPER_NOUNS = new Set(['Git', 'Web', 'Subagent']);

describe('buildPanelSections - panel gồm đủ 8 nhóm, đúng thứ tự, đếm đủ catalog', () => {
  const sections = buildPanelSections();

  it('đủ 8 category theo đúng thứ tự ALL_TOOL_CATEGORIES', () => {
    // Đột biến bị chặn: đổi thứ tự section hoặc bỏ một nhóm trong builder
    // (ví dụ map theo Object.keys(TOOL_CATEGORY_LABELS)) → mảng category đỏ.
    expect(sections.map((s) => s.category)).toEqual([...ALL_TOOL_CATEGORIES]);
  });

  it('tổng số tool của các section bằng đúng số entry của catalog', () => {
    // Đột biến bị chặn: builder lọc thiếu/nhầm tool (ví dụ quên nhóm rỗng,
    // hoặc gom theo group sai) → tổng khác catalog là đỏ.
    const total = sections.reduce((acc, s) => acc + s.tools.length, 0);
    expect(total).toBe(TOOL_CATALOG.length);
  });

  it('tool trong mỗi section nằm đúng category và giữ thứ tự catalog', () => {
    // Đột biến bị chặn: sort trong nhóm theo tên thay vì giữ thứ tự catalog,
    // hoặc push tool vào nhầm nhóm → so sánh từng cặp là đỏ.
    for (const section of sections) {
      const expected = TOOL_CATALOG.filter((t) => t.category === section.category);
      expect(section.tools).toEqual(expected);
    }
  });

  it('xác định qua mọi lần gọi (hai lần build deep-equal)', () => {
    // Đột biến bị chặn: builder dựa state ngoài (Math.random, Date, map Mutable)
    // → hai kết quả khác nhau là đỏ.
    expect(buildPanelSections()).toEqual(buildPanelSections());
  });

  it('label/icon của section khớp TOOL_CATEGORY_LABELS', () => {
    // Đột biến bị chặn: panel tự viết nhãn riêng thay vì đọc catalog →
    // so với TOOL_CATEGORY_LABELS là lệch ngay.
    for (const section of sections) {
      expect(section.label).toBe(TOOL_CATEGORY_LABELS[section.category].label);
      expect(section.icon).toBe(TOOL_CATEGORY_LABELS[section.category].icon);
    }
  });
});

describe('filterPanelSections - lọc theo tên, mô tả, shortLabel', () => {
  const sections = buildPanelSections();

  it('query rỗng hoặc chỉ khoảng trắng trả nguyên 8 nhóm, đủ mọi tool', () => {
    // Đột biến bị chặn: bỏ nhánh `if (!q) return sections` (để query rỗng
    // vẫn chạy includes('') - may mắn vẫn khớp hết) HOẶC điều kiện trim sai →
    // test '   ' (chỉ whitespace) trả thiếu nhóm là đỏ.
    for (const q of ['', '   ']) {
      const out = filterPanelSections(sections, q);
      expect(out).toHaveLength(ALL_TOOL_CATEGORIES.length);
      expect(out.reduce((acc, s) => acc + s.tools.length, 0)).toBe(TOOL_CATALOG.length);
    }
  });

  it('khớp theo tên tool: "fs_read" chỉ trả nhóm Đọc file với đúng 1 tool', () => {
    // Đột biến bị chặn: bỏ dòng match `t.name` trong filter → kết quả rỗng đỏ.
    const out = filterPanelSections(sections, 'fs_read');
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('fs_read');
    expect(out[0].tools.map((t) => t.name)).toEqual(['fs_read']);
  });

  it('khớp theo mô tả: "tỷ giá" tìm ra exchange_rates', () => {
    // Đột biến bị chặn: bỏ dòng match `t.description` → exchange_rates
    // không khớp field nào khác → kết quả rỗng là đỏ.
    const out = filterPanelSections(sections, 'tỷ giá');
    expect(out.flatMap((s) => s.tools.map((t) => t.name))).toContain('exchange_rates');
  });

  it('khớp theo shortLabel: "git status" chỉ tìm được qua nhãn ngắn', () => {
    // git_status không chứa chuỗi "git status" ở tên (underscore) lẫn mô tả,
    // nên test này đỏ nếu bỏ dòng match `t.shortLabel`.
    const out = filterPanelSections(sections, 'git status');
    const names = out.flatMap((s) => s.tools.map((t) => t.name));
    expect(names).toEqual(['git_status']);
  });

  it('không phân biệt hoa thường: "GIT STATUS" cho kết quả như thường', () => {
    // Đột biến bị chặn: quên toLowerCase một phía → query hoa trả rỗng đỏ.
    expect(filterPanelSections(sections, 'GIT STATUS').flatMap((s) => s.tools.map((t) => t.name)))
      .toEqual(['git_status']);
  });

  it('không khớp gì thì trả mảng rỗng (không giữ lại section rỗng)', () => {
    // Đột biến bị chặn: bỏ `.filter(s => s.tools.length > 0)` → trả 8 section
    // header chết có 0 tool là đỏ.
    expect(filterPanelSections(sections, 'zzz-khong-co-tool-nay')).toEqual([]);
  });

  it('không sửa mảng đầu vào khi lọc', () => {
    // Đột biến bị chặn: filter dùng splice/sort trên mảng gốc → sections
    // thay đổi sau lời gọi là đỏ.
    const before = JSON.stringify(sections.map((s) => s.tools.map((t) => t.name)));
    filterPanelSections(sections, 'fs_read');
    expect(JSON.stringify(sections.map((s) => s.tools.map((t) => t.name)))).toBe(before);
  });
});

describe('resolveToolEntry - tra cả tên di sản TOOL_META của tool-trace', () => {
  it('tên chính xác trả đúng entry', () => {
    // Đột biến bị chặn: hàm luôn đi vào nhánh alias (bỏ TOOL_INDEX.get) →
    // vẫn đúng entry này, nhưng test alias dưới chặn ngược lại; test này
    // chặn bug "trả entry khác tên gọi".
    expect(resolveToolEntry('fs_read')?.name).toBe('fs_read');
    expect(resolveToolEntry('delegate')?.name).toBe('delegate');
  });

  it('alias kiểu TOOL_META (read, bash, read_file…) resolve về entry gốc', () => {
    // Đột biến bị chặn: resolveToolEntry chỉ tra tên chính xác (giữ nguyên
    // getToolEntry) → mọi dòng dưới trả undefined là đỏ.
    expect(resolveToolEntry('read')?.name).toBe('fs_read');
    expect(resolveToolEntry('bash')?.name).toBe('shell_run');
    expect(resolveToolEntry('read_file')?.name).toBe('fs_read');
    expect(resolveToolEntry('fs_readFile')?.name).toBe('fs_read');
    expect(resolveToolEntry('write_to_file')?.name).toBe('fs_write');
    expect(resolveToolEntry('replace_file_content')?.name).toBe('fs_edit');
    expect(resolveToolEntry('list_dir')?.name).toBe('fs_list');
    expect(resolveToolEntry('run_command')?.name).toBe('shell_run');
    expect(resolveToolEntry('shell')?.name).toBe('shell_run');
    expect(resolveToolEntry('search_web')?.name).toBe('web_search');
    expect(resolveToolEntry('read_url_content')?.name).toBe('web_fetch');
  });

  it('mọi key TOOL_META từng render chip đều tra được (tooltip không bao giờ trống)', () => {
    // Đột biến bị chặn: bỏ một alias khỏi catalog (hoặc đổi tên alias) →
    // key tương tự trong danh sách dưới trả undefined là đỏ.
    const traceNames = [
      'read', 'write', 'edit', 'bash', 'run_command', 'shell',
      'fs_readFile', 'fs_writeFile', 'fs_editFile', 'fs_listDir', 'list_dir',
      'read_file', 'write_to_file', 'replace_file_content',
      'web_search', 'search_web', 'web_fetch', 'read_url_content',
      'weather', 'exchange_rates', 'memory_search',
    ];
    for (const name of traceNames) {
      expect(resolveToolEntry(name), `"${name}" phải tra được entry`).toBeDefined();
    }
  });

  it('tên lạ trả undefined (không đoán bừa entry đầu tiên)', () => {
    // Đột biến bị chặn: fallback "??? name" thay vì undefined → đỏ.
    expect(resolveToolEntry('khong_co_tool_nay')).toBeUndefined();
    expect(resolveToolEntry('')).toBeUndefined();
  });
});

describe('updateToolPermission - update bất biến một nhóm quyền', () => {
  const base: ToolPermissions = {
    fs_read: 'default',
    fs_write: 'default',
    shell: 'ask',
    git: 'default',
    web: 'auto',
    memory: 'default',
    plan: 'default',
    delegate: 'deny',
  };

  it('đổi đúng một category, giữ nguyên 7 category còn lại', () => {
    // Đột biến bị chặn: update ghi đè cả record (mất giá trị cũ) hoặc đổi
    // nhầm key → một trong 8 expect dưới đỏ.
    const next = updateToolPermission(base, 'fs_read', 'auto');
    expect(next.fs_read).toBe('auto');
    expect(next.fs_write).toBe('default');
    expect(next.shell).toBe('ask');
    expect(next.git).toBe('default');
    expect(next.web).toBe('auto');
    expect(next.memory).toBe('default');
    expect(next.plan).toBe('default');
    expect(next.delegate).toBe('deny');
  });

  it('bất biến: không sửa object đầu vào, trả object mới', () => {
    // Đột biến bị chặn: `permissions[category] = value` (mutate trực tiếp) →
    // base.fs_read đổi thành 'auto' là đỏ.
    const snapshot = { ...base };
    const next = updateToolPermission(base, 'fs_read', 'auto');
    expect(next).not.toBe(base);
    expect(base).toEqual(snapshot);
  });

  it('chấp nhận đủ 4 giá trị hợp lệ của Settings', () => {
    // Đột biến bị chặn: PERMISSION_VALUES thiếu một giá trị ('deny' chẳng hạn)
    // → expect cuối cùng ném lỗi là đỏ.
    for (const value of ['default', 'auto', 'ask', 'deny'] as const) {
      expect(() => updateToolPermission(base, 'plan', value)).not.toThrow();
      expect(updateToolPermission(base, 'plan', value).plan).toBe(value);
    }
  });

  it('giá trị lạ ném lỗi thay vì lọt vào store persist', () => {
    // Đột biến bị chặn: bỏ nhánh validate → select UI bug vẫn ghi được
    // 'maybe' vào localStorage là đỏ.
    expect(() => updateToolPermission(base, 'shell', 'maybe' as never)).toThrow(/không hợp lệ/);
  });
});

describe('TOOL_CATEGORY_LABELS - localize tiếng Việt, bỏ emoji icon', () => {
  it('đủ 8 nhãn tiếng Việt đúng bảng (khoá bảng localize)', () => {
    // Đột biến bị chặn: ai trả label về English ('File Reading', 'Shell
    // Commands'…) hoặc đổi ký tự nào trong nhãn → so với bảng dưới là đỏ.
    for (const cat of ALL_TOOL_CATEGORIES) {
      expect(TOOL_CATEGORY_LABELS[cat].label).toBe(EXPECTED_LABELS[cat].label);
      expect(TOOL_CATEGORY_LABELS[cat].icon).toBe(EXPECTED_LABELS[cat].icon);
    }
  });

  it('nhãn không rỗng, không emoji, tên icon dạng lucide (chữ thường + gạch ngang)', () => {
    // Đột biến bị chặn: đưa emoji về làm icon (kiểu icon cũ) → EMOJI_RE đỏ; icon
    // chứa chữ hoa/khoảng trắng → regex tên icon đỏ.
    for (const cat of ALL_TOOL_CATEGORIES) {
      const info = TOOL_CATEGORY_LABELS[cat];
      expect(info.label.length, `${cat}: nhãn rỗng`).toBeGreaterThan(0);
      expect(info.label, `${cat}: nhãn chứa emoji`).not.toMatch(EMOJI_RE);
      expect(info.icon.length, `${cat}: tên icon rỗng`).toBeGreaterThan(0);
      expect(info.icon, `${cat}: tên icon phải là tên lucide`).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it('nhãn phải là tiếng Việt (có dấu) trừ tên riêng Git/Web/Subagent', () => {
    // Đột biến bị chặn: thay nhãn bằng từ English không dấu mới ('Files',
    // 'Commands') → VIET_RE không khớp và không nằm trong allowlist là đỏ.
    for (const cat of ALL_TOOL_CATEGORIES) {
      const label = TOOL_CATEGORY_LABELS[cat].label;
      const ok = VIET_RE.test(label) || ASCII_PROPER_NOUNS.has(label);
      expect(ok, `${cat}: nhãn "${label}" phải là tiếng Việt hoặc tên riêng`).toBe(true);
    }
  });
});

describe('TOOL_CATEGORY_ICON_COMPONENTS - icon map dùng chung cho hai UI', () => {
  it('mọi tên icon của 8 nhóm TOOL_CATEGORY_LABELS đều resolve được component', () => {
    // Đột biến bị chặn: thêm nhóm mới vào catalog mà quên thêm icon vào
    // map dùng chung → tên icon không có entry là đỏ (UI mất icon nhóm).
    for (const cat of ALL_TOOL_CATEGORIES) {
      const iconName = TOOL_CATEGORY_LABELS[cat].icon;
      expect(
        TOOL_CATEGORY_ICON_COMPONENTS[iconName],
        `${cat}: thiếu component cho icon "${iconName}"`,
      ).toBeDefined();
    }
  });

  it('hai UI dùng chung map icon, không tự dựng bản riêng', () => {
    /*
     * Đột biến bị chặn: một UI quay lại khai báo map component icon riêng →
     * thêm nhóm mới là phải sửa nhiều nơi và chúng lệch nhau.
     *
     * Danh sách file đã SỬA so với bản cũ: trước đây test trỏ vào
     * `settings-dialog.tsx`, nhưng map ở đó đã chết từ lâu (import không dùng).
     * Trong khi đó `tool-permissions-table.tsx` — UI thứ hai thật sự vẽ icon
     * nhóm — lại tự dựng `GROUP_ICONS` và KHÔNG bị test nào bắt. Nay trỏ đúng
     * file và bắt luôn cả `GROUP_ICONS`.
     */
    const CONSUMERS = [
      '../components/tools-panel.tsx',
      '../components/tool-permissions-table.tsx',
    ];
    for (const rel of CONSUMERS) {
      const code = fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
      expect(code, `${rel} phải import từ tool-category-icons`).toMatch(
        /TOOL_CATEGORY_ICON_COMPONENTS\s*\}?\s*from\s*'@\/components\/tool-category-icons'/,
      );
      expect(code, `${rel} không được tự khai báo map icon local`).not.toMatch(
        /(GROUP_ICONS|TOOL_CATEGORY_ICON_COMPONENTS)\s*:\s*Record<[^>]*(LucideIcon|ComponentType)/,
      );
    }
  });
});
