/**
 * Khóa bảng lệnh CLI (tổ chức goose-style) và các pure builder của
 * lib/cli/cli-surface.ts.
 *
 * Sau khi tái cấu trúc từ chuỗi if trong bin/vyen.ts sang registry dữ liệu,
 * nguy hiểm lớn nhất là mất tên legacy hoặc help/catalog drift giữa CLI và
 * REPL. Mọi test ở đây chạy thuần trong node (không spawn tiến trình) bằng
 * cách import trực tiếp registry và builder.
 */

import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  COMMAND_GROUPS,
  TOOL_CLI_COMMANDS,
  buildHelpText,
  buildToolDetail,
  buildToolListing,
  renderToolsCommand,
  resolveCommand,
  resolveDispatch,
  resolveToolCommand,
} from '@/lib/cli/cli-surface';
import { ALL_TOOL_CATEGORIES, TOOL_CATALOG, TOOL_CATEGORY_LABELS, getToolEntry } from '@/lib/tool-catalog';
import { renderToolsCommand as renderToolsFromRepl } from '@/lib/cli/interactive-agent';

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const VIET_RE = /[ăâđêôơưáàảãạấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i;

/** Mọi tên gọi đã từng chạy được trước tái cấu trúc, kể cả alias và cờ. */
const LEGACY_INVOCATIONS = [
  'cli', 'run',
  'teamwork',
  'doctor', 'audit',
  'init', 'status', 'git:status', 'diff', 'git:diff',
  'read', 'write', 'edit', 'bash', 'exec', 'find', 'grep',
  'app', 'desktop', 'serve',
  'version', '-v', '--version',
  'help', '--help', '-h',
];

describe('COMMANDS registry là nguồn sự thật duy nhất của bảng lệnh', () => {
  it('mọi tên legacy resolve được và không tên nào trùng lặp', () => {
    for (const name of LEGACY_INVOCATIONS) {
      expect(resolveCommand(name), `legacy "${name}" phải resolve được`).toBeDefined();
    }
    const allKeys = Object.values(COMMANDS).flatMap((c) => [c.name, ...c.aliases]);
    expect(new Set(allKeys).size, 'tên/alias không được trỏ về 2 entry').toBe(allKeys.length);
  });

  it('đủ 4 nhóm, nhóm nào cũng có lệnh, entry nào cũng có run handler', () => {
    expect(COMMAND_GROUPS.map((g) => g.key)).toEqual(['session', 'agent', 'workspace', 'system']);
    for (const group of COMMAND_GROUPS) {
      const members = Object.values(COMMANDS).filter((c) => c.group === group.key);
      expect(members.length, `nhóm ${group.label} không được rỗng`).toBeGreaterThan(0);
    }
    for (const entry of Object.values(COMMANDS)) {
      expect(typeof entry.run, `${entry.name}: thiếu run handler`).toBe('function');
    }
  });

  it('mô tả tiếng Việt ngắn gọn: không rỗng, tối đa 80 ký tự, có dấu, không gạch ngang dài, không emoji', () => {
    for (const entry of Object.values(COMMANDS)) {
      expect(entry.description.length, `${entry.name}: mô tả rỗng`).toBeGreaterThan(0);
      expect(entry.description.length, `${entry.name}: dài ${entry.description.length} ký tự`).toBeLessThanOrEqual(80);
      expect(VIET_RE.test(entry.description), `${entry.name}: phải là mô tả tiếng Việt`).toBe(true);
      expect(entry.description, `${entry.name}: chứa '—'`).not.toContain('—');
      expect(entry.description, `${entry.name}: chứa emoji`).not.toMatch(EMOJI_RE);
    }
  });

  it('tool là verb mới của registry, thuộc nhóm workspace', () => {
    const tool = COMMANDS.tool;
    expect(tool).toBeDefined();
    expect(tool.group).toBe('workspace');
  });
});

describe('resolveToolCommand: vyen tool <tên> trùng handler verb one-shot', () => {
  it('tool có lệnh CLI map về đúng run handler của verb tương ứng (cùng reference)', () => {
    for (const [toolName, verb] of Object.entries(TOOL_CLI_COMMANDS)) {
      const res = resolveToolCommand(toolName, ['tham-so-a', 'tham-so-b']);
      expect(res.kind, `${toolName} phải kind "command"`).toBe('command');
      if (res.kind !== 'command') continue;
      expect(res.command, `${toolName} phải trùng entry ${verb}`).toBe(COMMANDS[verb]);
      expect(res.args).toEqual(['tham-so-a', 'tham-so-b']);
    }
  });

  it('alias của tool cũng resolve được (read, bash là alias của fs_read, shell_run)', () => {
    const byRead = resolveToolCommand('read');
    expect(byRead.kind).toBe('command');
    if (byRead.kind === 'command') expect(byRead.command).toBe(COMMANDS.read);

    const byBash = resolveToolCommand('bash');
    expect(byBash.kind).toBe('command');
    if (byBash.kind === 'command') expect(byBash.command).toBe(COMMANDS.bash);
  });

  it('tool thuộc catalog nhưng chưa có lệnh CLI thì kind là catalog-only', () => {
    for (const toolName of ['web_search', 'memory_save', 'delegate', 'bg_run']) {
      const res = resolveToolCommand(toolName);
      expect(res.kind, `${toolName} phải là "catalog-only"`).toBe('catalog-only');
    }
  });

  it('tên lạ trả error liệt kê đủ các tool chạy được qua CLI', () => {
    const res = resolveToolCommand('tool-khong-ton-tai');
    expect(res.kind).toBe('unknown');
    if (res.kind !== 'unknown') return;
    for (const toolName of Object.keys(TOOL_CLI_COMMANDS)) {
      expect(res.error, `error phải liệt kê ${toolName}`).toContain(toolName);
    }
    expect(res.error).toContain('vyen tool list');
  });
});

describe('buildToolListing: catalog hiển thị đủ và trung thực', () => {
  const listing = buildToolListing();

  it('chứa đủ 24 tên tool và mô tả đầy đủ của từng tool', () => {
    for (const tool of TOOL_CATALOG) {
      expect(listing, `thiếu tên ${tool.name}`).toContain(tool.name);
      expect(listing, `thiếu mô tả của ${tool.name}`).toContain(tool.description);
    }
  });

  it('có đủ nhãn 8 nhóm (in hoa) và dấu hiệu "(chỉ bản desktop)" cho tool cần bridge', () => {
    for (const category of ALL_TOOL_CATEGORIES) {
      expect(listing, `thiếu nhãn nhóm ${category}`).toContain(
        TOOL_CATEGORY_LABELS[category].label.toUpperCase(),
      );
    }
    expect(listing).toContain('chỉ bản desktop');
    expect(listing).toContain('shell_run');
  });

  it('không chứa emoji hay gạch ngang dài', () => {
    expect(listing).not.toMatch(EMOJI_RE);
    expect(listing).not.toContain('—');
  });
});

describe('buildHelpText: help nhóm theo nhóm lệnh', () => {
  const help = buildHelpText();

  it('chứa đủ nhãn 4 nhóm và mọi tên lệnh', () => {
    for (const group of COMMAND_GROUPS) {
      expect(help, `thiếu nhãn nhóm ${group.label}`).toContain(group.label);
    }
    for (const entry of Object.values(COMMANDS)) {
      expect(help, `thiếu tên lệnh ${entry.name}`).toContain(entry.name);
    }
  });

  it('kết thúc bằng hint xem chi tiết lệnh và vào REPL với /help', () => {
    expect(help).toContain('vyen <lệnh> --help');
    expect(help).toContain('vyen cli');
    expect(help).toContain('/help');
  });

  it('copy thuần: không emoji, không gạch ngang dài', () => {
    expect(help).not.toMatch(EMOJI_RE);
    expect(help).not.toContain('—');
  });
});

describe('renderToolsCommand: handler /tools của REPL dùng chung builder', () => {
  it('tham số rỗng hoặc "list" in đúng listing dùng chung với vyen tool list', () => {
    expect(renderToolsCommand('')).toBe(buildToolListing());
    expect(renderToolsCommand('list')).toBe(buildToolListing());
  });

  it('tên tool in chi tiết đầy đủ: nhóm, loại, mô tả, alias, phạm vi', () => {
    const detail = renderToolsCommand('fs_read');
    expect(detail).toContain('Tool: fs_read');
    expect(detail).toContain('Mô tả:');
    expect(detail).toContain('read_file');
    expect(detail).not.toContain('chỉ bản desktop');

    const shellDetail = renderToolsCommand('shell_run');
    expect(shellDetail).toContain('chỉ bản desktop');
    expect(shellDetail).toContain('vyen tool shell_run');
  });

  it('lookup qua cả alias của tool (read_file trúng fs_read)', () => {
    expect(renderToolsCommand('read_file')).toContain('Tool: fs_read');
  });

  it('tên lạ trả thông báo không nhận diện, gợi ý xem danh sách', () => {
    const out = renderToolsCommand('khong-co-tool-nay');
    expect(out).toContain('Không nhận diện');
    expect(out).toContain('/tools');
  });

  it('REPL import cùng một hàm với CLI nên không thể drift', () => {
    expect(renderToolsFromRepl).toBe(renderToolsCommand);
  });
});

describe('buildToolDetail: renderer chi tiết một tool', () => {
  it('in đủ các trường metadata của entry', () => {
    const detail = buildToolDetail(getToolEntry('delegate')!);
    expect(detail).toContain('Tool: delegate');
    expect(detail).toContain('Subagent');
    expect(detail).toContain('Mô tả:');
    expect(detail).toContain('chưa có one-shot');
  });
});

describe('resolveDispatch: thứ tự ưu tiên điều phối của main()', () => {
  // main() chỉ thực thi, mọi quyết định nhánh nằm trong resolveDispatch thuần.
  // Mỗi test ghi rõ mutation nó giết: ai đảo thứ tự nhánh hay thêm/bỏ điều
  // kiện legacy trong resolveDispatch là đỏ đúng test này.

  it('argv rỗng nhánh help (giết mutation: argv rỗng rơi vào unknown/warn)', () => {
    const res = resolveDispatch([]);
    expect(res.branch).toBe('help');
    expect(res.command).toBe(COMMANDS.help);
  });

  it('"help" là verb hệ thống nên đi nhánh command, không phải nhánh help của argv rỗng (giết mutation: special-case help thành nhánh help)', () => {
    const res = resolveDispatch(['help']);
    expect(res.branch).toBe('command');
    expect(res.command).toBe(COMMANDS.help);
  });

  it('verb non-session NUỐT cờ teamwork: status --dry-run vẫn là status (giết mutation: kiểm cờ teamwork trước verb workspace)', () => {
    const res = resolveDispatch(['status', '--dry-run']);
    expect(res.branch).toBe('command');
    expect(res.command).toBe(COMMANDS.status);
  });

  it('verb workspace với cờ --auto-approve kèm tham số vị trí vẫn là read (giết mutation: --auto-approve chi phối cả verb non-session)', () => {
    const res = resolveDispatch(['read', 'x', '--auto-approve']);
    expect(res.branch).toBe('command');
    expect(res.command).toBe(COMMANDS.read);
  });

  it('verb session + cờ teamwork chuyển sang teamwork: cli --goal y (giết mutation: verb session luôn chạy như command)', () => {
    const res = resolveDispatch(['cli', '--goal', 'y']);
    expect(res.branch).toBe('teamwork');
    expect(res.command).toBe(COMMANDS.teamwork);
  });

  it('cờ teamwork đứng đầu argv: --goal y (giết mutation: argv chỉ toàn cờ rơi vào unknown vì bắt đầu bằng "-")', () => {
    const res = resolveDispatch(['--goal', 'y']);
    expect(res.branch).toBe('teamwork');
  });

  it('cờ --dry-run đứng một mình vẫn vào teamwork (giết mutation: bỏ "--dry-run" khỏi tập cờ hoặc coi token "-" là unknown)', () => {
    const res = resolveDispatch(['--dry-run']);
    expect(res.branch).toBe('teamwork');
  });

  it('cờ viết tắt -g đứng đầu cũng vào teamwork (giết mutation: bỏ guard command === "-g")', () => {
    const res = resolveDispatch(['-g']);
    expect(res.branch).toBe('teamwork');
  });

  it('verb session KHÔNG cờ chạy như command: bare cli (giết mutation: verb session bị đẩy hết sang teamwork)', () => {
    const res = resolveDispatch(['cli']);
    expect(res.branch).toBe('command');
    expect(res.command).toBe(COMMANDS.cli);
  });

  it('verb teamwork literal đi nhánh command như verb agent khác (giết mutation: special-case "teamwork" vào nhánh teamwork, làm đổi argv truyền cho handler)', () => {
    const res = resolveDispatch(['teamwork']);
    expect(res.branch).toBe('command');
    expect(res.command).toBe(COMMANDS.teamwork);
  });

  it('prompt tiếng Việt nhiều token vào repl-prompt và không có command (giết mutation: token lạ bị coi unknown thay vì prompt)', () => {
    const res = resolveDispatch(['sửa', 'bug', 'giúp', 'tôi']);
    expect(res.branch).toBe('repl-prompt');
    expect(res.command).toBeUndefined();
  });

  it('tên lạ KHÔNG phải cờ được coi prompt trực tiếp: khong-co vào repl-prompt (giết mutation: token lạ bị đẩy sang unknown, làm mất tính prompt trực tiếp của legacy)', () => {
    const res = resolveDispatch(['khong-co']);
    expect(res.branch).toBe('repl-prompt');
    expect(res.command).toBeUndefined();
  });

  it('cờ lạ không nhận diện vào unknown, không phải repl-prompt (giết mutation: bỏ điều kiện startsWith("-") khi tách prompt)', () => {
    const res = resolveDispatch(['--khong-co']);
    expect(res.branch).toBe('unknown');
  });

  it('alias legacy dispatch như tên chính: git:status trúng status (giết mutation: resolveCommand bỏ index alias)', () => {
    const res = resolveDispatch(['git:status']);
    expect(res.branch).toBe('command');
    expect(res.command).toBe(COMMANDS.status);
  });
});
