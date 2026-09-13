/**
 * Khóa catalog tool về một nguồn sự thật duy nhất (lib/tool-catalog.ts).
 *
 * Bug gốc: ALL_TOOL_PROTOCOL_NAMES viết tay thiếu delegate + bg_run/bg_status/
 * bg_stop nên manual emulated không bao giờ document chúng; TOOL_CATEGORY_MAP
 * thiếu bg_* nên lệnh nền không bị chính sách quyền quản. Ở đây mọi nhóm test
 * đều đối chiếu chéo với TOOL_CATALOG: bỏ/rời một tool khỏi catalog là đỏ ít
 * nhất 3 chỗ (tập tên, manual, desktopOnly/tổng số).
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_TOOL_CATEGORIES,
  TOOL_CATALOG,
  TOOL_CATEGORY_LABELS,
  TOOL_CATEGORY_MAP,
  getToolEntry,
  toolShortLabel,
  toolsByCategory,
} from '@/lib/tool-catalog';
import {
  ALL_TOOL_PROTOCOL_NAMES,
  CLIENT_TOOL_DEFS,
  TOOL_SHORT_LABELS,
  buildAgentTools,
  formatToolProtocolManual,
} from '@/lib/agent-tools';

/** 30 tên mong đợi, viết tường minh để bắt cả thêm lẫn xoá tool một cách vô ý. */
const EXPECTED_NAMES = [
  'fs_list', 'fs_read', 'fs_search', 'skill_load', 'fs_edit', 'fs_write',
  'shell_run', 'bg_run', 'bg_status', 'bg_stop',
  'git_status', 'git_diff', 'git_log', 'git_add', 'git_commit',
  'web_search', 'web_fetch', 'weather', 'exchange_rates',
  'memory_search', 'memory_save', 'lesson_save',
  'remember_memory', 'retrieve_memories', 'remove_memory_category', 'remove_specific_memory',
  'chat_recall',
  'plan_create', 'plan_update',
  'delegate',
].sort();

/** Đúng tập tool chat-interface chặn khi thiếu desktop bridge (dòng desktopOnly). */
const EXPECTED_DESKTOP_ONLY = [
  'shell_run', 'git_status', 'git_diff', 'git_log', 'git_add', 'git_commit',
  'bg_run', 'bg_status', 'bg_stop',
].sort();

const EMOJI_RE = /\p{Extended_Pictographic}/u;

describe('TOOL_CATALOG - đủ 30 tool, không thừa không thiếu', () => {
  it('tập tên khớp đúng 30 tên mong đợi', () => {
    expect(TOOL_CATALOG).toHaveLength(30);
    expect(TOOL_CATALOG.map((t) => t.name).sort()).toEqual(EXPECTED_NAMES);
  });

  it('tên không trùng nhau', () => {
    const names = TOOL_CATALOG.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('thứ tự xác định: nhóm theo category (thứ tự ALL_TOOL_CATEGORIES) rồi tên tăng dần', () => {
    const catRank = new Map(ALL_TOOL_CATEGORIES.map((c, i) => [c, i]));
    const expected = [...TOOL_CATALOG].sort((a, b) => {
      const d = catRank.get(a.category)! - catRank.get(b.category)!;
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
    expect(TOOL_CATALOG.map((t) => t.name)).toEqual(expected.map((t) => t.name));
  });

  it('kind: đúng 6 server + 24 client', () => {
    const server = TOOL_CATALOG.filter((t) => t.kind === 'server');
    const client = TOOL_CATALOG.filter((t) => t.kind === 'client');
    expect(server.map((t) => t.name).sort()).toEqual(
      ['exchange_rates', 'memory_save', 'memory_search', 'weather', 'web_fetch', 'web_search'],
    );
    expect(client).toHaveLength(24);
  });

  it('desktopOnly: đúng 9 tool cần desktop bridge, phần còn lại chạy được trên web', () => {
    expect(TOOL_CATALOG.filter((t) => t.desktopOnly).map((t) => t.name).sort()).toEqual(
      EXPECTED_DESKTOP_ONLY,
    );
  });
});

describe('chất lượng metadata từng entry', () => {
  it('mô tả một dòng, không rỗng, tối đa 100 ký tự, không gạch ngang dài, không emoji', () => {
    for (const t of TOOL_CATALOG) {
      expect(t.description.length, `${t.name}: mô tả rỗng`).toBeGreaterThan(0);
      expect(t.description.length, `${t.name}: mô tả dài ${t.description.length} ký tự`).toBeLessThanOrEqual(100);
      expect(t.description, `${t.name}: chứa '—'`).not.toContain('—');
      expect(t.description, `${t.name}: chứa emoji`).not.toMatch(EMOJI_RE);
      expect(t.description.includes('\n'), `${t.name}: mô tả nhiều dòng`).toBe(false);
    }
  });

  it('shortLabel không rỗng, tối đa 24 ký tự', () => {
    for (const t of TOOL_CATALOG) {
      expect(t.shortLabel.length, `${t.name}: shortLabel rỗng`).toBeGreaterThan(0);
      expect(t.shortLabel.length, `${t.name}: shortLabel dài`).toBeLessThanOrEqual(24);
    }
  });

  it('category và kind hợp lệ', () => {
    const cats = new Set<string>(ALL_TOOL_CATEGORIES);
    for (const t of TOOL_CATALOG) {
      expect(cats.has(t.category), `${t.name}: category lạ "${t.category}"`).toBe(true);
      expect(['server', 'client'], `${t.name}: kind lạ`).toContain(t.kind);
    }
  });

  it('mô tả bám hành vi thật (con số neo từ implementation)', () => {
    expect(getToolEntry('fs_read')!.description).toContain('24.000');
    expect(getToolEntry('fs_search')!.description).toContain('5000');
    expect(getToolEntry('shell_run')!.description).toContain('120');
    expect(getToolEntry('fs_write')!.description).toContain('200');
  });

  it('memory_search ghi rõ chỉ xuất hiện khi có dữ liệu ghi nhớ', () => {
    expect(getToolEntry('memory_search')!.description).toContain('chỉ có mặt');
  });
});

describe('taxonomy category - map phủ toàn bộ catalog', () => {
  it('mọi tên trong catalog đều có category', () => {
    for (const t of TOOL_CATALOG) {
      expect(TOOL_CATEGORY_MAP[t.name], `${t.name}: thiếu trong TOOL_CATEGORY_MAP`).toBeDefined();
      expect(TOOL_CATEGORY_MAP[t.name]).toBe(t.category);
    }
  });

  it('bg_run/bg_status/bg_stop thuộc nhóm shell (lệnh nền bị chính sách shell quản)', () => {
    expect(TOOL_CATEGORY_MAP.bg_run).toBe('shell');
    expect(TOOL_CATEGORY_MAP.bg_status).toBe('shell');
    expect(TOOL_CATEGORY_MAP.bg_stop).toBe('shell');
  });

  it('8 category giữ nguyên thứ tự - khoá persist toolPermissions không được đổi', () => {
    expect([...ALL_TOOL_CATEGORIES]).toEqual([
      'fs_read', 'fs_write', 'shell', 'git', 'web', 'memory', 'plan', 'delegate',
    ]);
  });

  it('mỗi category đều có label/icon/tools, tools khớp đúng các tên trong map', () => {
    for (const cat of ALL_TOOL_CATEGORIES) {
      const info = TOOL_CATEGORY_LABELS[cat];
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.icon.length).toBeGreaterThan(0);
      const expected = Object.entries(TOOL_CATEGORY_MAP)
        .filter(([, c]) => c === cat)
        .map(([n]) => n)
        .sort();
      expect(info.tools.split(', ').sort()).toEqual(expected);
    }
  });
});

describe('helpers', () => {
  it('getToolEntry: trúng trả entry, trượt trả undefined', () => {
    expect(getToolEntry('fs_read')?.name).toBe('fs_read');
    expect(getToolEntry('khong_ton_tai')).toBeUndefined();
  });

  it('toolShortLabel: trúng trả nhãn, tên lạ trả nguyên tên', () => {
    expect(toolShortLabel('bg_run')).toBe('chạy nền');
    expect(toolShortLabel('shell_run')).toBe('chạy shell');
    expect(toolShortLabel('tool_la')).toBe('tool_la');
  });

  it('toolsByCategory: đủ 8 khoá, tổng số entry bằng catalog, entry nằm đúng nhóm', () => {
    const byCat = toolsByCategory();
    expect(Object.keys(byCat).sort()).toEqual([...ALL_TOOL_CATEGORIES].sort());
    const total = ALL_TOOL_CATEGORIES.reduce((acc, c) => acc + byCat[c].length, 0);
    expect(total).toBe(TOOL_CATALOG.length);
    for (const cat of ALL_TOOL_CATEGORIES) {
      for (const entry of byCat[cat]) {
        expect(entry.category).toBe(cat);
      }
    }
  });
});

describe('chống drift với agent-tools - đối chiếu chéo', () => {
  it('ALL_TOOL_PROTOCOL_NAMES deep-equal tên catalog theo đúng thứ tự', () => {
    expect([...ALL_TOOL_PROTOCOL_NAMES]).toEqual(TOOL_CATALOG.map((t) => t.name));
  });

  it('TOOL_SHORT_LABELS sinh từ catalog, có nhãn cho delegate + bg_*', () => {
    for (const t of TOOL_CATALOG) {
      expect(TOOL_SHORT_LABELS[t.name], `${t.name}: thiếu short label`).toBe(t.shortLabel);
    }
    expect(TOOL_SHORT_LABELS.bg_run).toBe('chạy nền');
    expect(TOOL_SHORT_LABELS.bg_status).toBe('trạng thái nền');
    expect(TOOL_SHORT_LABELS.bg_stop).toBe('dừng nền');
    expect(TOOL_SHORT_LABELS.delegate).toBe('giao subagent');
  });

  it('regression bug drift: manual emulated có mặt bg_run, bg_stop và delegate', () => {
    const manual = formatToolProtocolManual(ALL_TOOL_PROTOCOL_NAMES);
    expect(manual).toContain('- bg_run:');
    expect(manual).toContain('- bg_stop:');
    expect(manual).toContain('- delegate:');
  });
});

describe('phân loại alias - tương lai thay TOOL_META của tool-trace', () => {
  it('alias không trùng tên chính thức của tool khác trong catalog', () => {
    const names = new Set(TOOL_CATALOG.map((t) => t.name));
    for (const t of TOOL_CATALOG) {
      for (const alias of t.aliases) {
        expect(names.has(alias), `alias "${alias}" trùng tên tool chính thức`).toBe(false);
      }
    }
  });

  it('fs_read/fs_write/fs_edit/shell_run/fs_list mang đúng alias di sản của TOOL_META', () => {
    expect(getToolEntry('fs_read')!.aliases).toEqual(['read', 'fs_readFile', 'read_file']);
    expect(getToolEntry('fs_write')!.aliases).toEqual(['write', 'fs_writeFile', 'write_to_file']);
    expect(getToolEntry('fs_edit')!.aliases).toEqual(['edit', 'fs_editFile', 'replace_file_content']);
    expect(getToolEntry('fs_list')!.aliases).toEqual(['fs_listDir', 'list_dir']);
    expect(getToolEntry('shell_run')!.aliases).toEqual(['bash', 'run_command', 'shell']);
    expect(getToolEntry('web_search')!.aliases).toEqual(['search_web']);
    expect(getToolEntry('web_fetch')!.aliases).toEqual(['read_url_content']);
  });
});

/* Chuyển lên từ tests/redteam-catalog.test.ts (bản redteam sẽ xoá theo lượt
   riêng): đây là nhà PERMANENT của các test chống-drift cho bug gốc. */
describe('parity CLIENT_TOOL_DEFS ⇔ catalog kind client (nhà permanent)', () => {
  const clientCatalogNames = TOOL_CATALOG.filter((t) => t.kind === 'client').map((t) => t.name);

  it('tập key CLIENT_TOOL_DEFS bằng đúng tập tên tool client của catalog, không thừa không thiếu', () => {
    const defKeys = Object.keys(CLIENT_TOOL_DEFS);
    expect(defKeys.length, 'số key định nghĩa client').toBe(clientCatalogNames.length);
    expect([...defKeys].sort()).toEqual([...clientCatalogNames].sort());
  });

  it('key mồ côi: định nghĩa client mà catalog không biết đến thì đỏ tại đây', () => {
    const catalogSet = new Set(clientCatalogNames);
    for (const key of Object.keys(CLIENT_TOOL_DEFS)) {
      expect(catalogSet.has(key), `CLIENT_TOOL_DEFS["${key}"] không phải tool client của catalog`).toBe(true);
    }
  });
});

describe('parity TOOL_CATEGORY_MAP phủ cả catalog lẫn CLIENT_TOOL_DEFS (nhà permanent)', () => {
  it('mọi key CLIENT_TOOL_DEFS có trong TOOL_CATEGORY_MAP (tool client không được lọt ngoài chính sách quyền)', () => {
    for (const key of Object.keys(CLIENT_TOOL_DEFS)) {
      expect(TOOL_CATEGORY_MAP[key], `CLIENT_TOOL_DEFS["${key}"]: thiếu trong TOOL_CATEGORY_MAP`).toBeDefined();
    }
  });

  it('mọi tên catalog có trong TOOL_CATEGORY_MAP và category khớp entry', () => {
    for (const entry of TOOL_CATALOG) {
      expect(TOOL_CATEGORY_MAP[entry.name], `${entry.name}: thiếu trong TOOL_CATEGORY_MAP`).toBeDefined();
      expect(TOOL_CATEGORY_MAP[entry.name]).toBe(entry.category);
    }
  });
});

describe('parity buildAgentTools ⇔ catalog kind server (nhà permanent)', () => {
  /* buildAgentTools dựng tool tại chỗ, chỉ đóng gói execute closure nên
     gọi với memories giả (để memory_search có mặt) không chạm mạng. */
  it('tên tool server sinh từ buildAgentTools bằng đúng tên kind server của catalog', () => {
    const built = buildAgentTools({ memories: [{ id: '__parity__', text: '__parity__' }] });
    const builtNames = Object.keys(built).sort();
    const serverNames = TOOL_CATALOG.filter((t) => t.kind === 'server').map((t) => t.name).sort();
    expect(builtNames).toEqual(serverNames);
  });

  it('không có tool server nào biến mất khi build lại (giết mutation: deleteProperty includeWeb mặc định)', () => {
    const built = buildAgentTools({ memories: [{ id: '__parity__', text: '__parity__' }] }) as unknown as Record<string, unknown>;
    for (const name of TOOL_CATALOG.filter((t) => t.kind === 'server').map((t) => t.name)) {
      expect(built[name], `${name}: catalog nói có nhưng buildAgentTools không sinh`).toBeDefined();
    }
  });
});
