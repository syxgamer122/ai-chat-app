/**
 * Bảng lệnh CLI của Vyen (tổ chức theo nhóm lệnh).
 *
 * Trước đây bin/vyen.ts rải dispatch qua một chuỗi if dài: danh sách lệnh in
 * cứng trong help, thêm lệnh phải sửa nhiều chỗ và help drift ngay. Giờ bảng
 * lệnh là DATA (COMMANDS), help và tool-listing là pure builder dùng chung cho
 * cả CLI lẫn REPL (/tools), còn bin/vyen.ts chỉ còn là entry gọi main().
 *
 * Registry sống ở lib (không phải bin) để test import trực tiếp mà không
 * tự chạy tiến trình. Handler nhận argv ĐÃ BỎ tên lệnh.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  ALL_TOOL_CATEGORIES,
  TOOL_CATALOG,
  TOOL_CATEGORY_LABELS,
  getToolEntry,
  toolsByCategory,
  type ToolCatalogEntry,
} from '../tool-catalog';

const APP_ROOT = path.resolve(__dirname, '..', '..');

export type CommandGroupKey = 'session' | 'agent' | 'workspace' | 'system';

export interface CommandGroupInfo {
  key: CommandGroupKey;
  label: string;
}

/** Thứ tự nhóm in trong help: phiên làm việc trước, lệnh hệ thống cuối. */
export const COMMAND_GROUPS: readonly CommandGroupInfo[] = [
  { key: 'session', label: 'PHIÊN' },
  { key: 'agent', label: 'TÁC VỤ AGENT' },
  { key: 'workspace', label: 'TIỆN ÍCH WORKSPACE' },
  { key: 'system', label: 'HỆ THỐNG' },
];

export interface CommandEntry {
  readonly name: string;
  readonly group: CommandGroupKey;
  /** Mô tả tiếng Việt một dòng, tối đa 80 ký tự, không gạch ngang dài. */
  readonly description: string;
  /** Tên cũ/tên viết tắt trỏ về cùng handler, giữ backward compat. */
  readonly aliases: readonly string[];
  readonly run: (argv: string[]) => Promise<void>;
}

async function makeHarness() {
  const { CliCodingHarness } = await import('./interactive-agent');
  return new CliCodingHarness();
}

const runHelp = async (): Promise<void> => {
  console.log(buildHelpText());
};

const runVersion = async (): Promise<void> => {
  const pkgPath = path.join(APP_ROOT, 'package.json');
  let version = '0.1.0';
  try {
    const fs = await import('node:fs');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    version = pkg.version || version;
  } catch {}
  console.log(`vyen v${version}`);
};

const runDoctor = async (): Promise<void> => {
  const harness = await makeHarness();
  console.log(harness.doctor().output);
};

const runAudit = async (argv: string[]): Promise<void> => {
  const jsonOutput = argv.includes('--json');
  const targetArg = argv.find((a) => !a.startsWith('--'));
  const { runSecuritySast } = await import('../security-sast');
  const report = runSecuritySast(process.cwd(), { targetPath: targetArg });
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report.textReport);
  }
  if (!report.ok) process.exitCode = 1;
};

const runInit = async (): Promise<void> => {
  const harness = await makeHarness();
  console.log(harness.init().output);
};

const runStatus = async (): Promise<void> => {
  const harness = await makeHarness();
  const res = harness.gitStatus();
  console.log(res.output || 'Working directory clean.');
};

const runDiff = async (argv: string[]): Promise<void> => {
  const target = argv[0];
  if (target === '--help' || target === '-h') {
    console.log('Cách dùng: vyen diff [path]');
    return;
  }
  const harness = await makeHarness();
  const res = harness.gitDiff(target);
  console.log(res.output || 'No changes.');
};

const runRead = async (argv: string[]): Promise<void> => {
  const target = argv[0];
  if (target === '--help' || target === '-h') {
    console.log('Cách dùng: vyen read <path> [startLine] [count]');
    return;
  }
  if (!target) {
    console.error('[vyen read] Cần cung cấp đường dẫn file. Ví dụ: vyen read package.json');
    process.exitCode = 1;
    return;
  }
  const startLine = argv[1] ? parseInt(argv[1], 10) : 1;
  const count = argv[2] ? parseInt(argv[2], 10) : 200;
  const harness = await makeHarness();
  const res = harness.read(target, startLine, count);
  if (res.ok) {
    console.log(res.output);
  } else {
    console.error(`[vyen read lỗi] ${res.error}`);
    process.exitCode = 1;
  }
};

const runWrite = async (argv: string[]): Promise<void> => {
  const target = argv[0];
  if (target === '--help' || target === '-h') {
    console.log('Cách dùng: vyen write <file> <content>');
    return;
  }
  const content = argv.slice(1).join(' ');
  if (!target) {
    console.error('[vyen write] Cách dùng: vyen write <file> <content>');
    process.exitCode = 1;
    return;
  }
  const harness = await makeHarness();
  const res = harness.write(target, content);
  if (res.ok) {
    console.log(res.output);
  } else {
    console.error(`[vyen write lỗi] ${res.error}`);
    process.exitCode = 1;
  }
};

const runEdit = async (argv: string[]): Promise<void> => {
  const target = argv[0];
  if (target === '--help' || target === '-h') {
    console.log('Cách dùng: vyen edit <path> <oldText> <newText>');
    return;
  }
  const oldText = argv[1];
  const newText = argv[2];
  if (!target || oldText === undefined || newText === undefined) {
    console.error('[vyen edit] Cách dùng: vyen edit <path> <oldText> <newText>');
    process.exitCode = 1;
    return;
  }
  const harness = await makeHarness();
  const res = harness.edit(target, oldText, newText);
  if (res.ok) {
    console.log(res.output);
  } else {
    console.error(`[vyen edit lỗi] ${res.error}`);
    process.exitCode = 1;
  }
};

const runBash = async (argv: string[]): Promise<void> => {
  const cmdStr = argv.join(' ');
  if (cmdStr === '--help' || cmdStr === '-h') {
    console.log('Cách dùng: vyen bash <câu_lệnh_shell>');
    return;
  }
  if (!cmdStr) {
    console.error('[vyen bash] Cần cung cấp câu lệnh shell. Ví dụ: vyen bash "npm test"');
    process.exitCode = 1;
    return;
  }
  const harness = await makeHarness();
  const res = harness.bash(cmdStr);
  console.log(res.output);
  if (!res.ok) process.exitCode = 1;
};

const runFind = async (argv: string[]): Promise<void> => {
  const pattern = argv[0];
  if (pattern === '--help' || pattern === '-h') {
    console.log('Cách dùng: vyen find [pattern]');
    return;
  }
  const harness = await makeHarness();
  console.log(harness.find(pattern).output);
};

const runGrep = async (argv: string[]): Promise<void> => {
  const query = argv.join(' ');
  if (query === '--help' || query === '-h') {
    console.log('Cách dùng: vyen grep <chuỗi_tìm_kiếm>');
    return;
  }
  if (!query) {
    console.error('[vyen grep] Cần cung cấp chuỗi tìm kiếm. Ví dụ: vyen grep "function"');
    process.exitCode = 1;
    return;
  }
  const harness = await makeHarness();
  console.log(harness.grep(query).output);
};

const runTeamwork = async (argv: string[]): Promise<void> => {
  const { main: runTeamworkEngine } = await import('../teamwork/cli');
  await runTeamworkEngine(argv);
};

export const runSession = async (argv: string[]): Promise<void> => {
  const { listCliSessions, getLatestCliSession, loadCliSession } = await import('./session-manager');
  const { startInteractiveCli } = await import('./interactive-agent');

  const isResume = argv.includes('-r') || argv.includes('--resume');
  const nameIndex = argv.findIndex((a) => a === '--name' || a === '-n');
  const nameArg = nameIndex !== -1 && argv[nameIndex + 1] ? argv[nameIndex + 1] : undefined;

  if (isResume) {
    let session = null;
    if (nameArg) {
      session = loadCliSession(process.cwd(), nameArg);
      if (!session) {
        console.error(`[vyen session] Không tìm thấy phiên nào có tên khớp với: "${nameArg}".`);
        console.error('Dùng "vyen session list" để xem danh sách các phiên có sẵn.');
        process.exitCode = 1;
        return;
      }
    } else {
      session = getLatestCliSession(process.cwd());
      if (!session) {
        console.log('[vyen session] Chưa có phiên nào được lưu. Khởi tạo phiên mới...');
      }
    }

    if (session) {
      console.log(`[vyen session] Tiếp tục phiên: "${session.name}" (${session.id}) — ${session.history.length} tin nhắn.`);
    }
    await startInteractiveCli(process.cwd(), undefined, { resumeSession: session || undefined });
    return;
  }

  const sub = argv[0];
  if (sub === 'list' || sub === 'ls' || !sub) {
    const sessions = listCliSessions(process.cwd());
    if (sessions.length === 0) {
      console.log('Chưa có phiên làm việc CLI nào được lưu trong workspace này.');
      console.log('Chạy "vyen cli" để bắt đầu một phiên làm việc mới.');
      return;
    }
    console.log(`\nDANH SÁCH PHIÊN LÀM VIỆC CLI (${sessions.length} phiên):`);
    console.log('─'.repeat(70));
    for (const s of sessions) {
      const dateStr = new Date(s.updatedAt || s.createdAt).toLocaleString('vi-VN');
      console.log(`• ID:      ${s.id}`);
      console.log(`  Tên:     ${s.name}`);
      console.log(`  Tin:     ${s.history.length} tin nhắn | Cập nhật: ${dateStr}`);
      console.log('─'.repeat(70));
    }
    console.log('\nĐể tiếp tục một phiên:');
    console.log('  vyen session -r               (phiên gần nhất)');
    console.log('  vyen session -r --name <tên>   (tìm theo tên)');
    return;
  }

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    console.log([
      'Cách dùng: vyen session [tùy_chọn]',
      '  vyen session list                  — Liệt kê các phiên đã lưu',
      '  vyen session -r                    — Tiếp tục phiên gần nhất',
      '  vyen session -r --name <tên>       — Tiếp tục phiên theo tên',
      'Lối tắt: npm run cli -- session -r',
    ].join('\n'));
    return;
  }

  console.error(`[vyen session] Tùy chọn không nhận diện: "${sub}". Dùng --help để xem hướng dẫn.`);
  process.exitCode = 1;
};

const runCli = async (argv: string[]): Promise<void> => {
  if (argv[0] === 'session') {
    await runSession(argv.slice(1));
    return;
  }
  const { startInteractiveCli } = await import('./interactive-agent');
  const promptArg = argv.join(' ').trim();
  await startInteractiveCli(process.cwd(), promptArg || undefined);
};

/** `vyen recipe list|run` và `vyen run --recipe ...` (headless). */
const runRecipe = async (argv: string[]): Promise<void> => {
  const [sub, ...rest] = argv;
  if (sub === 'list' || sub === 'ls' || !sub) {
    const { listWorkspaceRecipes } = await import('./recipe-list');
    console.log(listWorkspaceRecipes(process.cwd()));
    return;
  }
  if (sub === 'run') {
    const { parseRecipeRunArgv, runRecipeHeadless } = await import('./recipe-runner');
    const parsed = parseRecipeRunArgv(rest);
    if (!parsed.ok) {
      console.error(`[vyen recipe] ${parsed.error}`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runRecipeHeadless(parsed.args);
    return;
  }
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    console.log([
      'Cách dùng:',
      '  vyen recipe list                       — liệt kê .vyen/recipes/*.yaml',
      '  vyen recipe run --recipe <file> [cờ]   — chạy headless (CI dùng được)',
      '  vyen run --recipe <file> [cờ]          — lối tắt của dòng trên',
      'Cờ: --params k=v (lặp được / phân cách bằng ",") · --output json|text',
      '    --no-session · --model <id> · exit code: 0 pass, 1 checks fail, 2 lỗi cấu hình',
    ].join('\n'));
    return;
  }
  console.error(`[vyen recipe] Sub lệnh không nhận diện: "${sub}". Dùng: list | run.`);
  process.exitCode = 2;
};

export const runSchedule = async (argv: string[]): Promise<void> => {
  const {
    loadSchedulesFromFile,
    executeScheduledRun,
    startSchedulerDaemon,
  } = await import('../scheduler/runner');
  const { describeCron, getNextCronRun } = await import('../scheduler/cron');

  const sub = argv[0];

  if (sub === 'list' || sub === 'ls' || !sub) {
    const list = loadSchedulesFromFile(process.cwd());
    if (list.length === 0) {
      console.log('Chưa có lịch trình nào được lưu. Tạo lịch trình trong giao diện hoặc qua .vyen/schedules.json.');
      return;
    }
    console.log(`\nDanh sách lịch trình (${list.length}):\n`);
    for (const s of list) {
      const statusIcon =
        s.lastStatus === 'success'
          ? '✅'
          : s.lastStatus === 'failure'
            ? '❌'
            : s.lastStatus === 'running'
              ? '⏳'
              : '⚪';
      const enableText = s.enabled ? 'Đang bật' : 'Đang tạm dừng';
      const nextRun = getNextCronRun(s.cron);
      const nextRunStr = nextRun ? nextRun.toLocaleString('vi-VN') : 'Không có';
      console.log(`- [${s.id}] ${s.recipeName || s.recipeId} (${enableText})`);
      console.log(`  Cron: ${s.cron} (${describeCron(s.cron)})`);
      console.log(
        `  Lần chạy cuối: ${s.lastRunAt ? new Date(s.lastRunAt).toLocaleString('vi-VN') : 'Chưa chạy'} ${statusIcon}`,
      );
      console.log(`  Lần chạy kế: ${nextRunStr}`);
      console.log(`  Số session: ${s.sessions?.length || 0}\n`);
    }
    return;
  }

  if (sub === 'run') {
    const id = argv[1];
    if (!id) {
      console.error('[vyen schedule] Cần ID lịch trình cần chạy: vyen schedule run <id>');
      process.exitCode = 1;
      return;
    }
    const list = loadSchedulesFromFile(process.cwd());
    const item = list.find((s) => s.id === id);
    if (!item) {
      console.error(`[vyen schedule] Không tìm thấy lịch trình với ID: "${id}".`);
      process.exitCode = 1;
      return;
    }
    console.log(`[vyen schedule] Bắt đầu thực thi: "${item.recipeName || item.recipeId}"...`);
    const res = await executeScheduledRun(process.cwd(), item);
    if (res.ok) {
      console.log(`[vyen schedule] ✅ Thành công! Đã tạo phiên: ${res.sessionId}`);
    } else {
      console.error(`[vyen schedule] ❌ Thất bại: ${res.error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === 'daemon') {
    console.log('[vyen schedule] Khởi động scheduler daemon (tick mỗi 30s)... Nhấn Ctrl+C để dừng.');
    startSchedulerDaemon(process.cwd(), 30_000);
    await new Promise(() => {});
    return;
  }

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    console.log([
      'Cách dùng: vyen schedule [lệnh]',
      '  vyen schedule list         — Liệt kê các lịch trình',
      '  vyen schedule run <id>     — Chạy ngay một lịch trình',
      '  vyen schedule daemon       — Chạy tiến trình scheduler daemon (30s tick)',
    ].join('\n'));
    return;
  }

  console.error(`[vyen schedule] Lệnh không hợp lệ: "${sub}". Dùng --help để xem hướng dẫn.`);
  process.exitCode = 1;
};

const runApp = async (argv: string[]): Promise<void> => {
  const launcherScript = path.join(APP_ROOT, 'scripts', 'launch-desktop.cjs');
  const child = spawn(process.execPath, [launcherScript, ...argv], {
    cwd: APP_ROOT,
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
};

const runServe = async (): Promise<void> => {
  /*
   * S3: KHÔNG dùng `shell: true` ở đây nữa.
   *
   * Windows không spawn được `npm.cmd` trực tiếp (đây là batch shim, Node cố tình
   * chặn). Cách đúng là gọi `cmd.exe` với argv TƯỜNG MINH — không nối chuỗi, không
   * nội suy biến, và `/d` tắt AutoRun của cmd.exe (một vector persist gổ).
   * Lệnh là hằng số trong source nên không có dữ liệu người dùng để bị inject.
   * POSIX dùng đường dẫn tuyệt đối, không phụ thuộc PATH.
   */
  const isWin = process.platform === 'win32';
  const child = isWin
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', 'run', 'dev'], {
        cwd: APP_ROOT,
        stdio: 'inherit',
        shell: false,
      })
    : spawn('/usr/bin/npm', ['run', 'dev'], {
        cwd: APP_ROOT,
        stdio: 'inherit',
        shell: false,
      });
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
};

/**
 * Tool catalog map về verb CLI one-shot. Chỉ map tool có handler thật trong
 * bảng lệnh; tool không có map thì `vyen tool <tên>` hiện metadata thay vì
 * giả vờ chạy được (introspection trung thực).
 */
export const TOOL_CLI_COMMANDS: Readonly<Record<string, string>> = {
  fs_read: 'read',
  fs_write: 'write',
  fs_edit: 'edit',
  fs_list: 'find',
  fs_search: 'grep',
  shell_run: 'bash',
  git_status: 'status',
  git_diff: 'diff',
};

export type ToolCommandResolution =
  | { kind: 'command'; command: CommandEntry; tool: ToolCatalogEntry; args: string[] }
  | { kind: 'catalog-only'; tool: ToolCatalogEntry }
  | { kind: 'unknown'; name: string; error: string };

function findToolEntry(name: string): ToolCatalogEntry | undefined {
  return getToolEntry(name) ?? TOOL_CATALOG.find((t) => t.aliases.includes(name));
}

/**
 * `vyen tool <tên>` dùng đây: trúng tool có verb CLI thì trả chính entry
 * trong COMMANDS (cùng reference, cùng handler) nên không thể drift với
 * lệnh one-shot ở bảng lệnh. Tên lạ trả error liệt kê đủ tên hợp lệ.
 */
export function resolveToolCommand(name: string, args: string[] = []): ToolCommandResolution {
  const tool = findToolEntry(name);
  if (!tool) {
    const valid = Object.keys(TOOL_CLI_COMMANDS).join(', ');
    return {
      kind: 'unknown',
      name,
      error: `[vyen tool] Không nhận diện tool "${name}". Tool chạy được qua CLI: ${valid}. Xem toàn bộ catalog: vyen tool list`,
    };
  }
  const commandName = TOOL_CLI_COMMANDS[tool.name];
  if (!commandName) {
    return { kind: 'catalog-only', tool };
  }
  return { kind: 'command', command: COMMANDS[commandName], tool, args };
}

const runTool = async (argv: string[]): Promise<void> => {
  const [name, ...rest] = argv;
  if (!name || name === 'list' || name === '--help' || name === '-h') {
    console.log(buildToolListing());
    return;
  }
  const res = resolveToolCommand(name, rest);
  if (res.kind === 'command') {
    await res.command.run(res.args);
    return;
  }
  if (res.kind === 'catalog-only') {
    console.log(buildToolDetail(res.tool));
    console.log(`Tool "${res.tool.name}" chưa có lệnh CLI one-shot; dùng nó trong phiên tương tác (vyen cli) hoặc bản desktop.`);
    return;
  }
  console.error(res.error);
  process.exitCode = 1;
};

export const COMMANDS: Readonly<Record<string, CommandEntry>> = {
  cli: {
    name: 'cli',
    group: 'session',
    description: 'Mở terminal coding agent tương tác ',
    aliases: ['run'],
    run: runCli,
  },
  session: {
    name: 'session',
    group: 'session',
    description: 'Quản lý phiên CLI: danh sách, resume (-r, -r --name <tên>)',
    aliases: ['sessions'],
    run: runSession,
  },
  app: {
    name: 'app',
    group: 'session',
    description: 'Mở giao diện Vyen Desktop siêu nhẹ (Edge/WebView2, <0.3s)',
    aliases: ['desktop'],
    run: runApp,
  },
  serve: {
    name: 'serve',
    group: 'session',
    description: 'Khởi chạy local server cho trình duyệt web (Universal Bridge)',
    aliases: [],
    run: runServe,
  },
  teamwork: {
    name: 'teamwork',
    group: 'agent',
    description: 'Khởi chạy Teamwork Multi-Agent Runtime Engine (Phase 1 & 2)',
    aliases: [],
    run: runTeamwork,
  },
  recipe: {
    name: 'recipe',
    group: 'agent',
    description: 'Workflow đóng gói tái sử dụng: list/run headless theo schema',
    aliases: [],
    run: runRecipe,
  },
  schedule: {
    name: 'schedule',
    group: 'agent',
    description: 'Quản lý lịch chạy recipe tự động theo cron (P2-9)',
    aliases: ['cron', 'scheduler'],
    run: runSchedule,
  },
  audit: {
    name: 'audit',
    group: 'agent',
    description: 'Kiểm tra an ninh mã nguồn & cấu hình',
    aliases: [],
    run: runAudit,
  },
  doctor: {
    name: 'doctor',
    group: 'agent',
    description: 'Kiểm tra chẩn đoán môi trường & trạng thái hệ thống',
    aliases: [],
    run: runDoctor,
  },
  init: {
    name: 'init',
    group: 'workspace',
    description: 'Khởi tạo context dự án & cấu hình workspace ',
    aliases: [],
    run: runInit,
  },
  status: {
    name: 'status',
    group: 'workspace',
    description: 'Xem trạng thái Git hiện tại',
    aliases: ['git:status'],
    run: runStatus,
  },
  diff: {
    name: 'diff',
    group: 'workspace',
    description: 'Xem thay đổi Git diff',
    aliases: ['git:diff'],
    run: runDiff,
  },
  read: {
    name: 'read',
    group: 'workspace',
    description: 'Đọc nội dung file với đánh số dòng',
    aliases: [],
    run: runRead,
  },
  write: {
    name: 'write',
    group: 'workspace',
    description: 'Ghi nội dung vào file',
    aliases: [],
    run: runWrite,
  },
  edit: {
    name: 'edit',
    group: 'workspace',
    description: 'Sửa file bằng khối SEARCH / REPLACE',
    aliases: [],
    run: runEdit,
  },
  bash: {
    name: 'bash',
    group: 'workspace',
    description: 'Thực thi câu lệnh shell cục bộ',
    aliases: ['exec'],
    run: runBash,
  },
  find: {
    name: 'find',
    group: 'workspace',
    description: 'Tìm kiếm nhanh file trong workspace',
    aliases: [],
    run: runFind,
  },
  grep: {
    name: 'grep',
    group: 'workspace',
    description: 'Tìm kiếm nhanh chuỗi/regex trong mã nguồn',
    aliases: [],
    run: runGrep,
  },
  tool: {
    name: 'tool',
    group: 'workspace',
    description: 'Xem catalog tool hoặc chạy tool có lệnh CLI (vyen tool list)',
    aliases: [],
    run: runTool,
  },
  version: {
    name: 'version',
    group: 'system',
    description: 'Hiển thị phiên bản hiện tại',
    aliases: ['-v', '--version'],
    run: runVersion,
  },
  help: {
    name: 'help',
    group: 'system',
    description: 'Hiển thị trợ giúp này',
    aliases: ['--help', '-h'],
    run: runHelp,
  },
};

const COMMAND_INDEX: ReadonlyMap<string, CommandEntry> = (() => {
  const map = new Map<string, CommandEntry>();
  for (const entry of Object.values(COMMANDS)) {
    map.set(entry.name, entry);
    for (const alias of entry.aliases) map.set(alias, entry);
  }
  return map;
})();

/** Tra lệnh theo tên chính hoặc alias; trả undefined nếu không thuộc registry. */
export function resolveCommand(name: string): CommandEntry | undefined {
  return COMMAND_INDEX.get(name);
}

export function buildHelpText(): string {
  const entries = Object.values(COMMANDS);
  const nameWidth = Math.max(...entries.map((c) => c.name.length));
  const lines: string[] = [
    'Vyen AI Coding Agent Suite',
    '',
    'Cách dùng: vyen <lệnh> [tùy chọn]',
    '',
  ];
  for (const group of COMMAND_GROUPS) {
    const groupEntries = entries.filter((c) => c.group === group.key);
    if (groupEntries.length === 0) continue;
    lines.push(group.label);
    for (const entry of groupEntries) {
      const aliasSuffix = entry.aliases.length > 0 ? `  [còn: ${entry.aliases.join(', ')}]` : '';
      lines.push(`  ${entry.name.padEnd(nameWidth)}  ${entry.description}${aliasSuffix}`);
    }
    lines.push('');
  }
  lines.push('Chi tiết một lệnh: vyen <lệnh> --help');
  lines.push('Chế độ tương tác: vyen cli, trong phiên gõ /help xem lệnh slash và /tools xem catalog tool');
  return lines.join('\n');
}

/** Listing catalog dùng chung cho `vyen tool list` và /tools trong REPL. */
export function buildToolListing(): string {
  const byCategory = toolsByCategory();
  const nameWidth = Math.max(...TOOL_CATALOG.map((t) => t.name.length));
  const lines: string[] = [
    `Catalog tool Vyen: ${TOOL_CATALOG.length} tool trong ${ALL_TOOL_CATEGORIES.length} nhóm`,
    'Chạy tool có lệnh one-shot: vyen tool <tên> [tham_số...] (ví dụ: vyen tool fs_read package.json)',
    '',
  ];
  for (const category of ALL_TOOL_CATEGORIES) {
    lines.push(TOOL_CATEGORY_LABELS[category].label.toUpperCase());
    for (const tool of byCategory[category]) {
      const marker = tool.desktopOnly ? ' (chỉ bản desktop)' : '';
      lines.push(`  ${tool.name.padEnd(nameWidth)}  ${tool.shortLabel} - ${tool.description}${marker}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function buildToolDetail(tool: ToolCatalogEntry): string {
  const categoryLabel = TOOL_CATEGORY_LABELS[tool.category].label;
  const commandName = TOOL_CLI_COMMANDS[tool.name];
  const cliLine = commandName
    ? `Lệnh CLI: vyen tool ${tool.name} [tham_số...] (tương đương vyen ${commandName})`
    : 'Lệnh CLI: chưa có one-shot, dùng trong phiên tương tác (vyen cli) hoặc bản desktop';
  return [
    `Tool: ${tool.name}`,
    `Nhóm: ${categoryLabel} (${tool.category})`,
    `Loại: ${tool.kind === 'server' ? 'server (chạy trên backend)' : 'client (chạy trên máy người dùng)'}`,
    `Mô tả: ${tool.description}`,
    `Tên gọi khác: ${tool.aliases.length > 0 ? tool.aliases.join(', ') : '(không có)'}`,
    `Phạm vi: ${tool.desktopOnly ? 'chỉ bản desktop (cần desktop bridge)' : 'web và desktop'}`,
    cliLine,
  ].join('\n');
}

/** Handler /tools của REPL: rỗng hoặc "list" in listing, tên tool in chi tiết. */
export function renderToolsCommand(arg: string): string {
  const name = arg.trim();
  if (!name || name === 'list') {
    return buildToolListing();
  }
  const tool = findToolEntry(name);
  if (!tool) {
    return `[vyen cli] Không nhận diện tool "${name}". Gõ /tools (không tham số) để xem danh sách ${TOOL_CATALOG.length} tool.`;
  }
  return buildToolDetail(tool);
}

export type DispatchBranch = 'help' | 'command' | 'teamwork' | 'repl-prompt' | 'unknown';

export interface DispatchResolution {
  readonly branch: DispatchBranch;
  /** Entry sẽ chạy: lệnh match được (command), help mặc định, hoặc verb teamwork. */
  readonly command?: CommandEntry;
}

/**
 * Quyết định điều phối THUẦN (không side effect, không await) tách khỏi
 * main() để test khóa trực tiếp thứ tự ưu tiên legacy: các verb không thuộc
 * nhóm session dispatch TRƯỚC cờ teamwork, nên "vyen status --dry-run" vẫn
 * là status; chỉ "vyen --goal x" hoặc verb nhóm phiên kèm cờ ("vyen cli
 * --goal x") mới rơi vào teamwork runtime. Prompt trực tiếp ("vyen sửa bug
 * giúp tôi") vào REPL; token lạ bắt đầu bằng "-" là unknown.
 */
export function resolveDispatch(argv: string[]): DispatchResolution {
  const command = argv[0];

  if (!command) {
    return { branch: 'help', command: COMMANDS.help };
  }

  const entry = resolveCommand(command);
  if (entry && entry.group !== 'session') {
    return { branch: 'command', command: entry };
  }

  /* `run` là alias của `cli` (session) — nhưng kèm --recipe thì là headless
     recipe runner. Nhánh này phải đứng TRƯỚC nhánh session để cờ không rơi
     vào REPL tương tác. */
  if (command === 'run' && argv.slice(1).some((a) => a === '--recipe' || a.startsWith('--recipe='))) {
    return {
      branch: 'command',
      command: { ...COMMANDS.recipe, run: (rest: string[]) => COMMANDS.recipe.run(['run', ...rest]) },
    };
  }

  const teamworkFlags =
    command === '--goal' ||
    command === '-g' ||
    argv.some((a) => a.startsWith('--goal') || a === '--dry-run' || a === '--auto-approve');
  if (teamworkFlags) {
    return { branch: 'teamwork', command: COMMANDS.teamwork };
  }

  if (entry) {
    return { branch: 'command', command: entry };
  }

  // Nếu truyền prompt trực tiếp: vyen "Mục tiêu cần làm"
  if (argv.length > 0 && !command.startsWith('-')) {
    return { branch: 'repl-prompt' };
  }

  return { branch: 'unknown' };
}

/**
 * Điều phối chính; argv là toàn bộ args sau "vyen" (argv[0] là command).
 * Toàn bộ quyết định nhánh nằm trong resolveDispatch; hàm này chỉ thực thi.
 */
export async function main(argv: string[]): Promise<void> {
  const res = resolveDispatch(argv);

  if (res.branch === 'command' && res.command) {
    await res.command.run(argv.slice(1));
    return;
  }

  if (res.branch === 'teamwork' && res.command) {
    await res.command.run(argv);
    return;
  }

  if (res.branch === 'help') {
    await COMMANDS.help.run([]);
    return;
  }

  if (res.branch === 'repl-prompt') {
    const { startInteractiveCli } = await import('./interactive-agent');
    await startInteractiveCli(process.cwd(), argv.join(' '));
    return;
  }

  console.warn(`[vyen] Lệnh không nhận diện: "${argv[0]}". Sử dụng --help để xem hướng dẫn.`);
  process.exitCode = 1;
}
