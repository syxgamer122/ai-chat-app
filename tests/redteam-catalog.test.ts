/**
 * RED TEAM — lib/tool-catalog.ts đối chéo lib/agent-tools.ts.
 *
 * Bug gốc của refactoring này chính là drift: danh sách viết tay ở nơi khác
 * thiếu delegate + bg_* nên tool lọt ngoài chính sách quyền. Ở đây import
 * CẢ HAI module và đối chiếu chéo mọi chiều:
 *   TOOL_CATEGORY_MAP  ⇔  TOOL_CATALOG (tên ↔ category)
 *   CLIENT_TOOL_DEFS   ⇔  catalog kind 'client'
 *   ALL_TOOL_PROTOCOL_NAMES / TOOL_SHORT_LABELS ⇔ catalog
 *   formatToolProtocolManual phải mô tả đủ 24 tên (kể cả bg_run/bg_stop/delegate)
 * Alias phải là namespace sạch: không đụng tên tool, không trùng nhau.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_TOOL_CATEGORIES,
  TOOL_CATALOG,
  TOOL_CATEGORY_MAP,
  getToolEntry,
  resolveToolEntry,
  toolsByCategory,
} from '@/lib/tool-catalog';
import {
  ALL_TOOL_PROTOCOL_NAMES,
  CLIENT_TOOL_DEFS,
  TOOL_SHORT_LABELS,
  formatToolProtocolManual,
} from '@/lib/agent-tools';

describe('RED TEAM catalog — getToolEntry / resolveToolEntry trên mọi tên và alias', () => {
  it('getToolEntry trả đúng entry cho đủ 29 tên chính', () => {
    expect(TOOL_CATALOG).toHaveLength(29);
    for (const entry of TOOL_CATALOG) {
      expect(getToolEntry(entry.name), `${entry.name}: tra không ra`).toBeDefined();
      expect(getToolEntry(entry.name)!.name).toBe(entry.name);
    }
  });

  it('resolveToolEntry tra được MỌI alias về đúng entry cha', () => {
    for (const entry of TOOL_CATALOG) {
      for (const alias of entry.aliases) {
        const resolved = resolveToolEntry(alias);
        expect(resolved, `alias "${alias}" của ${entry.name} tra không ra`).toBeDefined();
        expect(resolved!.name, `alias "${alias}" trỏ nhầm ${resolved?.name}`).toBe(entry.name);
      }
    }
  });

  it('namespace sạch: alias không trùng tên tool khác, không alias dùng 2 lần', () => {
    const allNames = TOOL_CATALOG.map((t) => t.name);
    const seenAlias = new Set<string>();
    for (const entry of TOOL_CATALOG) {
      for (const alias of entry.aliases) {
        expect(allNames, `alias "${alias}" đụng tên tool chính`).not.toContain(alias);
        expect(seenAlias.has(alias), `alias "${alias}" bị khai báo 2 lần`).toBe(false);
        seenAlias.add(alias);
      }
    }
  });

  it('tên lạ và prototype-key trả undefined (Map index, không đoán bừa)', () => {
    expect(resolveToolEntry('__proto__')).toBeUndefined();
    expect(resolveToolEntry('constructor')).toBeUndefined();
    expect(getToolEntry('__proto__')).toBeUndefined();
  });
});

describe('RED TEAM catalog — TOOL_CATEGORY_MAP phủ một-một mọi tên', () => {
  it('mọi tên trong map là tên catalog (không có key mồ côi)', () => {
    const names = new Set(TOOL_CATALOG.map((t) => t.name));
    for (const key of Object.keys(TOOL_CATEGORY_MAP)) {
      expect(names.has(key), `key "${key}" không thuộc catalog`).toBe(true);
    }
  });

  it('mọi tên catalog có trong map VÀ category của map khớp entry', () => {
    for (const entry of TOOL_CATALOG) {
      expect(TOOL_CATEGORY_MAP[entry.name], `${entry.name}: thiếu trong TOOL_CATEGORY_MAP`).toBeDefined();
      expect(TOOL_CATEGORY_MAP[entry.name]).toBe(entry.category);
    }
  });

  it('toolsByCategory phân hoạch đúng: đủ 29, mỗi entry đúng 1 nhóm', () => {
    const byCategory = toolsByCategory();
    const total = ALL_TOOL_CATEGORIES.reduce((acc, cat) => acc + byCategory[cat].length, 0);
    expect(total).toBe(29);
    for (const cat of ALL_TOOL_CATEGORIES) {
      for (const entry of byCategory[cat]) {
        expect(entry.category, `${entry.name} đứng nhầm nhóm ${cat}`).toBe(cat);
      }
    }
  });
});

describe('RED TEAM — CLIENT_TOOL_DEFS đối chéo catalog (bug drift gốc)', () => {
  it('mọi key CLIENT_TOOL_DEFS phải là tool client của catalog', () => {
    const clientNames = new Set(
      TOOL_CATALOG.filter((t) => t.kind === 'client').map((t) => t.name),
    );
    for (const key of Object.keys(CLIENT_TOOL_DEFS)) {
      expect(clientNames.has(key), `CLIENT_TOOL_DEFS["${key}"] không phải tool client của catalog`).toBe(true);
    }
  });

  it('mọi tool client của catalog phải có định nghĩa thật trong CLIENT_TOOL_DEFS', () => {
    const defKeys = new Set(Object.keys(CLIENT_TOOL_DEFS));
    for (const entry of TOOL_CATALOG.filter((t) => t.kind === 'client')) {
      expect(defKeys.has(entry.name), `${entry.name}: thiếu định nghĩa client (catalog nói có, code không có)`).toBe(true);
    }
  });

  it('số lượng khớp: không tool client nào bị định nghĩa trùng hay thiếu', () => {
    const defKeys = Object.keys(CLIENT_TOOL_DEFS);
    expect(new Set(defKeys).size).toBe(defKeys.length);
    expect(defKeys.length).toBe(TOOL_CATALOG.filter((t) => t.kind === 'client').length);
  });
});

describe('RED TEAM — bản export suy sinh của agent-tools không drift khỏi catalog', () => {
  it('ALL_TOOL_PROTOCOL_NAMES frozen và deep-equal tên catalog theo thứ tự', () => {
    expect(Object.isFrozen(ALL_TOOL_PROTOCOL_NAMES)).toBe(true);
    expect([...ALL_TOOL_PROTOCOL_NAMES]).toEqual(TOOL_CATALOG.map((t) => t.name));
  });

  it('TOOL_SHORT_LABELS có đủ 29 key, nhãn khớp catalog từng entry', () => {
    expect(Object.keys(TOOL_SHORT_LABELS)).toHaveLength(29);
    for (const entry of TOOL_CATALOG) {
      expect(TOOL_SHORT_LABELS[entry.name], `${entry.name}: thiếu nhãn`).toBe(entry.shortLabel);
    }
  });

  it('TOOL_SHORT_LABELS không có key mồ côi ngoài catalog', () => {
    const names = new Set(TOOL_CATALOG.map((t) => t.name));
    for (const key of Object.keys(TOOL_SHORT_LABELS)) {
      expect(names.has(key), `key nhãn mồ côi "${key}"`).toBe(true);
    }
  });
});

describe('RED TEAM — formatToolProtocolManual mô tả đủ 29 tool', () => {
  const manual = formatToolProtocolManual(ALL_TOOL_PROTOCOL_NAMES);

  it('mỗi tên catalog có một dòng "- tên:" trong manual', () => {
    for (const entry of TOOL_CATALOG) {
      expect(manual, `${entry.name}: thiếu dòng manual`).toContain(`- ${entry.name}:`);
    }
  });

  it('manual nhắc đủ bg_run, bg_stop, delegate (những tên đã từng bị drift)', () => {
    expect(manual).toContain('- bg_run:');
    expect(manual).toContain('- bg_stop:');
    expect(manual).toContain('- delegate:');
  });

  it('mỗi dòng manual có mô tả không rỗng sau dấu hai chấm', () => {
    for (const line of manual.split('\n')) {
      const desc = line.replace(/^- [a-z_]+:\s*/, '');
      expect(desc.length, `dòng "${line.slice(0, 40)}..." mô tả rỗng`).toBeGreaterThan(0);
    }
  });
});
