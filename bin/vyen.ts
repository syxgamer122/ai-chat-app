#!/usr/bin/env node
/**
 * Unified CLI Entrypoint for Vyen (Pi / Goose Architecture).
 *
 * Hỗ trợ đồng thời:
 * 1. `vyen cli`: Terminal Coding Harness tương tác trực tiếp (theo chuẩn Pi).
 * 2. `vyen teamwork`: Điều phối đa tác tử 2-phase (theo chuẩn OpenCode / PROJECT.md).
 * 3. `vyen app`: Khởi chạy giao diện Desktop siêu nhẹ qua Edge/Chrome App Mode.
 * 4. `vyen serve`: Khởi chạy headless server cho Web UI và Universal Bridge.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

const APP_ROOT = path.resolve(__dirname, '..');

async function main(argv: string[]) {
  const command = argv[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(`
Vyen AI Coding Agent Suite (Claude Code, Pi & Goose architecture)

Cách dùng:
  vyen <lệnh> [tùy chọn]

Các lệnh khả dụng:
  cli                  Mở terminal coding agent tương tác (theo chuẩn Claude Code / Pi)
  teamwork [args...]   Khởi chạy Teamwork Multi-Agent Runtime Engine (Phase 1 & 2)
  doctor               Kiểm tra chẩn đoán môi trường & trạng thái hệ thống
  audit                Kiểm tra an ninh mã nguồn & cấu hình (chuẩn MonkeyCode)
  init                 Khởi tạo context dự án & cấu hình workspace (Claude Code)
  status               Xem trạng thái Git hiện tại
  diff [path]          Xem thay đổi Git diff
  read <path> [st] [n] Đọc nội dung file với đánh số dòng
  write <path> <text>  Ghi nội dung vào file
  edit <p> <old> <new> Sửa file (SEARCH / REPLACE)
  bash <cmd>           Thực thi câu lệnh shell cục bộ
  find <pattern>       Tìm kiếm nhanh file trong workspace
  grep <query>         Tìm kiếm nhanh chuỗi/regex trong mã nguồn
  app, desktop         Mở giao diện Vyen Desktop siêu nhẹ (Edge/WebView2, <0.3s)
  serve                Khởi chạy local server cho trình duyệt web (Universal Bridge)
  -v, --version        Hiển thị phiên bản hiện tại
  help, --help, -h     Hiển thị trợ giúp này

Ví dụ:
  npx tsx bin/vyen.ts --version
  npx tsx bin/vyen.ts doctor
  npx tsx bin/vyen.ts audit
  npx tsx bin/vyen.ts status
  npx tsx bin/vyen.ts diff
  npx tsx bin/vyen.ts read package.json 1 20
  npx tsx bin/vyen.ts find "*.ts"
  npx tsx bin/vyen.ts grep "TeamworkEngine"
  npx tsx bin/vyen.ts teamwork --goal "Tối ưu hóa harness"
  npx tsx bin/vyen.ts app --port 3000
`);
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    const pkgPath = path.join(APP_ROOT, 'package.json');
    let version = '0.1.0';
    try {
      const fs = await import('node:fs');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      version = pkg.version || version;
    } catch {}
    console.log(`vyen v${version}`);
    return;
  }

  if (command === 'doctor') {
    const { CliCodingHarness } = await import('../lib/cli/interactive-agent');
    const harness = new CliCodingHarness();
    console.log(harness.doctor().output);
    return;
  }

  if (command === 'audit') {
    const jsonOutput = argv.includes('--json');
    const targetArg = argv.slice(1).find((a) => !a.startsWith('--'));
    const { runMonkeyCodeSast } = await import('../lib/security-sast');
    const report = runMonkeyCodeSast(process.cwd(), { targetPath: targetArg });
    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(report.textReport);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (command === 'init') {
    const { CliCodingHarness } = await import('../lib/cli/interactive-agent');
    const harness = new CliCodingHarness();
    const res = harness.init();
    console.log(res.output);
    return;
  }

  if (command === 'status' || command === 'git:status') {
    const { CliCodingHarness } = await import('../lib/cli/interactive-agent');
    const harness = new CliCodingHarness();
    const res = harness.gitStatus();
    console.log(res.output || 'Working directory clean.');
    return;
  }

  if (command === 'diff' || command === 'git:diff') {
    const target = argv[1];
    if (target === '--help' || target === '-h') {
      console.log('Cách dùng: vyen diff [path]');
      return;
    }
    const { CliCodingHarness } = await import('../lib/cli/interactive-agent');
    const harness = new CliCodingHarness();
    const res = harness.gitDiff(target);
    console.log(res.output || 'No changes.');
    return;
  }

  if (command === 'read') {
    const target = argv[1];
    if (target === '--help' || target === '-h') {
      console.log('Cách dùng: vyen read <path> [startLine] [count]');
      return;
    }
    if (!target) {
      console.error('[vyen read] Cần cung cấp đường dẫn file. Ví dụ: vyen read package.json');
      process.exitCode = 1;
      return;
    }
    const startLine = argv[2] ? parseInt(argv[2], 10) : 1;
    const count = argv[3] ? parseInt(argv[3], 10) : 200;
    const { CliCodingHarness } = await import('../lib/cli/interactive-agent');
    const harness = new CliCodingHarness();
    const res = harness.read(target, startLine, count);
    if (res.ok) {
      console.log(res.output);
    } else {
      console.error(`[vyen read lỗi] ${res.error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'write') {
    const target = argv[1];
    if (target === '--help' || target === '-h') {
      console.log('Cách dùng: vyen write <file> <content>');
      return;
    }
    const content = argv.slice(2).join(' ');
    if (!target) {
      console.error('[vyen write] Cách dùng: vyen write <file> <content>');
      process.exitCode = 1;
      return;
    }
    const { CliCodingHarness } = await import('../lib/cli/interactive-agent');
    const harness = new CliCodingHarness();
    const res = harness.write(target, content);
    if (res.ok) {
      console.log(res.output);
    } else {
      console.error(`[vyen write lỗi] ${res.error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'edit') {
    const target = argv[1];
    if (target === '--help' || target === '-h') {
      console.log('Cách dùng: vyen edit <path> <oldText> <newText>');
      return;
    }
    const oldText = argv[2];
    const newText = argv[3];
    if (!target || oldText === undefined || newText === undefined) {
      console.error('[vyen edit] Cách dùng: vyen edit <path> <oldText> <newText>');
      process.exitCode = 1;
      return;
    }
    const { CliCodingHarness } = await import('../lib/cli/interactive-agent');
    const harness = new CliCodingHarness();
    const res = harness.edit(target, oldText, newText);
    if (res.ok) {
      console.log(res.output);
    } else {
      console.error(`[vyen edit lỗi] ${res.error}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'bash' || command === 'exec') {
    const cmdStr = argv.slice(1).join(' ');
    if (cmdStr === '--help' || cmdStr === '-h') {
      console.log('Cách dùng: vyen bash <câu_lệnh_shell>');
      return;
    }
    if (!cmdStr) {
      console.error('[vyen bash] Cần cung cấp câu lệnh shell. Ví dụ: vyen bash "npm test"');
      process.exitCode = 1;
      return;
    }
    const { CliCodingHarness } = await import('../lib/cli/interactive-agent');
    const harness = new CliCodingHarness();
    const res = harness.bash(cmdStr);
    console.log(res.output);
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (command === 'find') {
    const pattern = argv[1];
    if (pattern === '--help' || pattern === '-h') {
      console.log('Cách dùng: vyen find [pattern]');
      return;
    }
    const { CliCodingHarness } = await import('../lib/cli/interactive-agent');
    const harness = new CliCodingHarness();
    console.log(harness.find(pattern).output);
    return;
  }

  if (command === 'grep') {
    const query = argv.slice(1).join(' ');
    if (query === '--help' || query === '-h') {
      console.log('Cách dùng: vyen grep <chuỗi_tìm_kiếm>');
      return;
    }
    if (!query) {
      console.error('[vyen grep] Cần cung cấp chuỗi tìm kiếm. Ví dụ: vyen grep "function"');
      process.exitCode = 1;
      return;
    }
    const { CliCodingHarness } = await import('../lib/cli/interactive-agent');
    const harness = new CliCodingHarness();
    console.log(harness.grep(query).output);
    return;
  }

  if (
    command === 'teamwork' ||
    command === '--goal' ||
    command === '-g' ||
    argv.some((a) => a.startsWith('--goal') || a === '--dry-run' || a === '--auto-approve')
  ) {
    const { main: runTeamwork } = await import('../lib/teamwork/cli');
    const teamworkArgs = command === 'teamwork' ? argv.slice(1) : argv;
    await runTeamwork(teamworkArgs);
    return;
  }

  if (command === 'cli' || command === 'run') {
    const { startInteractiveCli } = await import('../lib/cli/interactive-agent');
    const promptArg = argv.slice(1).join(' ').trim();
    await startInteractiveCli(process.cwd(), promptArg || undefined);
    return;
  }

  if (command === 'app' || command === 'desktop') {
    const launcherScript = path.join(APP_ROOT, 'scripts', 'launch-desktop.cjs');
    const launcherArgs = argv.slice(1);
    const child = spawn(process.execPath, [launcherScript, ...launcherArgs], {
      cwd: APP_ROOT,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
    return;
  }

  if (command === 'serve') {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = process.platform === 'win32'
      ? spawn(`${npmCmd} run dev`, {
          cwd: APP_ROOT,
          stdio: 'inherit',
          shell: true,
        })
      : spawn(npmCmd, ['run', 'dev'], {
          cwd: APP_ROOT,
          stdio: 'inherit',
        });
    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
    return;
  }

  // Nếu truyền prompt trực tiếp: vyen "Mục tiêu cần làm"
  if (argv.length > 0 && !command.startsWith('-')) {
    const { startInteractiveCli } = await import('../lib/cli/interactive-agent');
    await startInteractiveCli(process.cwd(), argv.join(' '));
    return;
  }

  console.warn(`[vyen] Lệnh không nhận diện: "${command}". Sử dụng --help để xem hướng dẫn.`);
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
