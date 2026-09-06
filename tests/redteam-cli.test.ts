/**
 * RED TEAM — lib/cli/cli-surface.ts.
 *
 * Tấn công bảng băm: '__proto__', 'constructor', 'toString', chuỗi rỗng,
 * tham số chứa khoảng trắng thừa và unicode. Registry là static data nên
 * injection mô tả đa dòng không thể xảy ra từ ngoài — test khóa bất biến
 * đó (mô tả một dòng, cột help thẳng hàng). main([]) và main(['--help'])
 * phải in help và không đặt exitCode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMANDS,
  buildHelpText,
  buildToolListing,
  renderToolsCommand,
  resolveCommand,
  resolveToolCommand,
  main,
} from '@/lib/cli/cli-surface';

describe('RED TEAM resolveCommand — khóa prototype của object registry', () => {
  it("'__proto__', 'constructor', 'toString' trả undefined (index là Map, không phải object)", () => {
    expect(resolveCommand('__proto__')).toBeUndefined();
    expect(resolveCommand('constructor')).toBeUndefined();
    expect(resolveCommand('toString')).toBeUndefined();
    expect(resolveCommand('hasOwnProperty')).toBeUndefined();
    expect(resolveCommand('')).toBeUndefined();
  });

  it("-h và --help trỏ về cùng entry 'help' (một reference)", () => {
    expect(resolveCommand('-h')).toBe(COMMANDS.help);
    expect(resolveCommand('--help')).toBe(COMMANDS.help);
    expect(resolveCommand('help')).toBe(COMMANDS.help);
  });
});

describe('RED TEAM resolveToolCommand — tên tool độc hại', () => {
  it("'__proto__' và 'constructor' là unknown, error liệt kê tool hợp lệ, không throw", () => {
    for (const evil of ['__proto__', 'constructor', 'toString']) {
      const res = resolveToolCommand(evil);
      expect(res.kind, `"${evil}" phải là unknown`).toBe('unknown');
      if (res.kind !== 'unknown') continue;
      expect(res.error).toContain(evil);
      expect(res.error).toContain('fs_read');
      expect(res.error).toContain('vyen tool list');
    }
  });

  it("'list' không phải tên tool: resolve trả unknown (listing là việc của runTool)", () => {
    const res = resolveToolCommand('list');
    expect(res.kind).toBe('unknown');
  });

  it("chuỗi rỗng là unknown, không về nhầm entry đầu tiên", () => {
    const res = resolveToolCommand('');
    expect(res.kind).toBe('unknown');
    if (res.kind !== 'unknown') return;
    expect(res.error).toContain('Không nhận diện');
  });
});

describe('RED TEAM renderToolsCommand — khoảng trắng và unicode', () => {
  it('tham số bao quanh khoảng trắng được trim trước khi tra', () => {
    expect(renderToolsCommand('  list  ')).toBe(buildToolListing());
    expect(renderToolsCommand('  fs_read  ')).toBe(renderToolsCommand('fs_read'));
  });

  it('tên_tool xen khoảng trắng bên trong (đã trim) vẫn là unknown, message giữ nguyên tên', () => {
    const out = renderToolsCommand('  fs read  ');
    expect(out).toContain('Không nhận diện');
    expect(out).toContain('fs read');
  });

  it('tên unicode tiếng Việt không phá format message', () => {
    const out = renderToolsCommand('đọc file');
    expect(out).toContain('Không nhận diện');
    expect(out).toContain('đọc file');
    expect(out).toContain('/tools');
  });

  it('tên tool thật với emoji/zero-width quanh nó là unknown (không match mờ)', () => {
    expect(renderToolsCommand('\u200Bfs_read')).toContain('Không nhận diện');
    expect(renderToolsCommand('fs_read\u200B')).toContain('Không nhận diện');
  });
});

describe('RED TEAM buildHelpText — injection đa dòng qua mô tả là bất khả thi', () => {
  it('mô tả mọi lệnh là một dòng duy nhất (registry static, không \\n)', () => {
    for (const entry of Object.values(COMMANDS)) {
      expect(entry.description, `${entry.name}: mô tả chứa \\n`).not.toContain('\n');
    }
  });

  it('cột mô tả của mọi dòng lệnh bắt đầu ở cùng một vị trí (bảng không bị bẻ)', () => {
    const help = buildHelpText();
    const nameWidth = Math.max(...Object.values(COMMANDS).map((c) => c.name.length));
    const lines = help.split('\n');
    for (const entry of Object.values(COMMANDS)) {
      const prefix = `  ${entry.name.padEnd(nameWidth)}  `;
      const line = lines.find((l) => l.startsWith(prefix));
      expect(line, `thiếu dòng lệnh ${entry.name}`).toBeDefined();
      expect(line!.slice(prefix.length).startsWith(entry.description), `${entry.name}: mô tả lệch cột`).toBe(true);
    }
  });
});

describe('RED TEAM main — argv rỗng và --help', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it('main([]) in help và không đặt exitCode lỗi', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main([]);
    expect(spy).toHaveBeenCalled();
    const printed = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('Vyen AI Coding Agent Suite');
    expect(process.exitCode !== 1).toBe(true);
  });

  it("main(['--help']) đi qua resolveCommand về help entry, in help, không spawn tiến trình", async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--help']);
    expect(spy).toHaveBeenCalled();
    const printed = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('vyen <lệnh> [tùy chọn]');
    expect(process.exitCode !== 1).toBe(true);
  });
});
