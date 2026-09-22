'use strict';

/**
 * Shell Execution Policy (High-Assurance Hardening).
 *
 * Replaces naive string-based regex denylists with:
 * 1. Tokenized argv parsing (rejecting all shell metacharacters, operators, substitutions, redirections).
 * 2. Strict allowlist for binaries and subcommands.
 * 3. Environment scrubbing (SAFE_ENV stripped of NODE_OPTIONS, LD_PRELOAD, GIT_*, npm_config_*).
 * 4. Safe spawn configuration (shell: false, detached: true, group-kill).
 */

const os = require('node:os');
const { spawnSync } = require('node:child_process');

class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyError';
  }
}

/**
 * Tokenize a command line string into an array of string arguments.
 * Rejects any command that attempts to use shell operators, pipes, redirections,
 * command substitutions, backticks, newlines, or process substitutions.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function tokenizeCommandLine(raw) {
  if (typeof raw !== 'string') {
    throw new PolicyError('Lệnh shell phải là chuỗi ký tự.');
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new PolicyError('Lệnh rỗng.');
  }

  // Chặn ngay các ký tự phân cách dòng hoặc NUL
  if (/[\r\n\0]/.test(trimmed)) {
    throw new PolicyError('Dấu xuống dòng hoặc ký tự NUL không được phép trong lệnh shell.');
  }

  const tokens = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    const nextChar = trimmed[i + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    // Kiểm tra các shell operator và metacharacter nguy hiểm
    if (inDoubleQuote) {
      // Trong double quote, shell vẫn thực thi substitution: `cmd`, $(cmd), ${var}
      if (char === '`') {
        throw new PolicyError('Command substitution bằng backtick (`) bị cấm tuyệt đối.');
      }
      if (char === '$' && (nextChar === '(' || nextChar === '{')) {
        throw new PolicyError('Command / variable substitution ($(..), ${..}) bị cấm tuyệt đối.');
      }
      current += char;
      continue;
    }

    if (inSingleQuote) {
      current += char;
      continue;
    }

    // Ngoài quote: kiểm tra toán tử shell
    if (char === '`') {
      throw new PolicyError('Command substitution bằng backtick (`) bị cấm tuyệt đối.');
    }
    if (char === '$' && (nextChar === '(' || nextChar === '{')) {
      throw new PolicyError('Command / variable substitution ($(..), ${..}) bị cấm tuyệt đối.');
    }
    if (char === ';' || char === '&' || char === '|' || char === '>' || char === '<' || char === '(' || char === ')') {
      throw new PolicyError(`Shell operator hoặc redirection ('${char}') không được phép.`);
    }
    if (char === '#') {
      throw new PolicyError("Ký tự ghi chú shell ('#') không được phép trong lệnh.");
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (inSingleQuote || inDoubleQuote) {
    throw new PolicyError('Dấu nháy đóng chưa hoàn tất (unclosed quote).');
  }
  if (escaped) {
    throw new PolicyError('Dấu escape (\\) ở cuối chuỗi.');
  }
  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Danh sách allowlist các binary và quy tắc tham số hợp lệ.
 */
const GIT_ALLOWED_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'add',
  'commit',
  'branch',
  'checkout',
  'rev-parse',
  'stash',
]);

const DANGEROUS_GIT_OPTIONS = [
  '-c',
  '--config',
  '--config-env',
  '--exec-path',
  '--paginate',
  '--no-pager',
  '--upload-pack',
  '--receive-pack',
];

const NPM_ALLOWED_SCRIPTS = new Set(['test', 'build', 'lint', 'typecheck', 'check']);
const NPX_ALLOWED_BINS = new Set(['vitest', 'jest', 'eslint', 'tsc', 'prettier', 'webpack']);

/**
 * Tool dưới `npx` chỉ được phép khi đi kèm ĐÚNG subcommand.
 * `npx vite build` / `npx next build` (xuất ra dist rồi thoát) hợp lệ;
 * `npx vite dev` (mở server dài hạn) thì không.
 */
const NPX_REQUIRED_SUBCOMMANDS = { vite: 'build', next: 'build' };

/**
 * Binary CHỈ đọc / in ra stdout: không ghi đĩa, không tự chạy lệnh con.
 *
 * Cố ý KHÔNG xếp `find`/`fd` vào đây dù `SAFE_COMMAND_PATTERNS` của
 * lib/auto-pilot.ts có liệt kê chúng: `find ... -exec <cmd> +` và `-delete`
 * vẫn chạy/ghi được mà tokenizer không chặn (không cần dấu `;`), nên hai
 * binary này phải đòi phê duyệt thay vì auto-approve.
 */
const READ_ONLY_BINS = new Set([
  'rg',
  'ls',
  'dir',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'file',
  'stat',
  'grep',
  'echo',
  'printf',
]);

/**
 * Phân tích và biên dịch lệnh shell thô sang cấu trúc argv an toàn.
 *
 * @param {string} rawCommand
 * @returns {{ bin: string; args: string[] }}
 */
function compileShellCommand(rawCommand) {
  const tokens = tokenizeCommandLine(rawCommand);
  if (tokens.length === 0) {
    throw new PolicyError('Lệnh rỗng.');
  }

  const rawBin = tokens[0];
  const args = tokens.slice(1);

  // Không cho phép binary có chứa đường dẫn (/ hoặc \)
  if (rawBin.includes('/') || rawBin.includes('\\')) {
    throw new PolicyError(`Đường dẫn binary tùy ý bị cấm: ${rawBin}`);
  }

  // Chuẩn hóa tên binary về lowercase (cho Windows case-insensitivity)
  const bin = rawBin.toLowerCase();

  // 1. Git
  if (bin === 'git') {
    // Kiểm tra xem có flag config nguy hiểm nào không
    for (const arg of args) {
      for (const dangerous of DANGEROUS_GIT_OPTIONS) {
        if (arg === dangerous || arg.startsWith(dangerous + '=')) {
          throw new PolicyError(`Flag cấu hình git nguy hiểm bị cấm: ${arg}`);
        }
      }
    }

    // Tìm subcommand đầu tiên (bỏ qua các flag global lành tính như --no-optional-locks, -C, v.v.)
    let subCmdIndex = -1;
    for (let i = 0; i < args.length; i++) {
      if (!args[i].startsWith('-')) {
        subCmdIndex = i;
        break;
      }
    }

    if (subCmdIndex === -1) {
      if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
        return { bin: 'git', args };
      }
      throw new PolicyError('Lệnh git thiếu subcommand.');
    }

    const subCmd = args[subCmdIndex].toLowerCase();
    if (!GIT_ALLOWED_SUBCOMMANDS.has(subCmd)) {
      throw new PolicyError(`Git subcommand bị chặn hoặc nằm ngoài allowlist: ${subCmd}`);
    }

    return { bin: 'git', args };
  }

  // 2. npm / pnpm / yarn
  if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn') {
    if (args.length === 0) {
      throw new PolicyError(`Lệnh ${bin} thiếu subcommand.`);
    }

    const firstArg = args[0].toLowerCase();

    if (firstArg === 'test' || firstArg === 'lint' || firstArg === 'typecheck' || firstArg === 'build' || firstArg === 'install') {
      return { bin, args };
    }

    if (firstArg === 'run' || firstArg === 'run-script') {
      if (args.length < 2) {
        throw new PolicyError(`Lệnh ${bin} run thiếu tên script.`);
      }
      const scriptName = args[1].toLowerCase();
      if (!NPM_ALLOWED_SCRIPTS.has(scriptName)) {
        throw new PolicyError(`Script "${scriptName}" trong package.json không thuộc allowlist an toàn.`);
      }
      return { bin, args };
    }

    throw new PolicyError(`Subcommand ${bin} bị chặn: ${firstArg}`);
  }

  // 3. npx
  if (bin === 'npx') {
    if (args.length === 0) {
      throw new PolicyError('Lệnh npx thiếu tool name.');
    }
    const tool = args[0].toLowerCase();
    const requiredSub = NPX_REQUIRED_SUBCOMMANDS[tool];
    if (requiredSub) {
      if ((args[1] || '').toLowerCase() !== requiredSub) {
        throw new PolicyError(`npx ${tool} chỉ được phép chạy subcommand "${requiredSub}".`);
      }
      return { bin: 'npx', args };
    }
    if (!NPX_ALLOWED_BINS.has(tool)) {
      throw new PolicyError(`Công cụ npx ngoài allowlist an toàn: ${tool}`);
    }
    return { bin: 'npx', args };
  }

  // 4. Các công cụ kiểm tra và đọc file lành tính
  if (READ_ONLY_BINS.has(bin)) {
    return { bin, args };
  }

  // 5. Node / Python — chỉ cho phép kiểm tra phiên bản
  if (bin === 'node') {
    if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
      return { bin: 'node', args };
    }
    throw new PolicyError('Node chỉ được phép gọi để kiểm tra phiên bản (--version). Chạy file/eval bị cấm.');
  }

  if (bin === 'python' || bin === 'python3') {
    if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
      return { bin: 'python', args };
    }
    throw new PolicyError('Python chỉ được phép gọi để kiểm tra phiên bản (--version). Chạy file/eval bị cấm.');
  }

  throw new PolicyError(`Binary ngoài allowlist an toàn: ${rawBin}`);
}

/**
 * Xây dựng môi trường thực thi đã được lọc sạch (SAFE_ENV).
 * Loại bỏ triệt để các biến môi trường cho phép nạp code động hoặc can thiệp thực thi:
 * NODE_OPTIONS, LD_PRELOAD, GIT_*, npm_config_*, PYTHON*, PERL*, v.v.
 */
function getSafeEnv() {
  const cleanEnv = {};

  const ALLOWED_ENV_VARS = new Set([
    'path',
    'home',
    'userprofile',
    'homedrive',
    'homepath',
    'lang',
    'lc_all',
    'lc_ctype',
    'term',
    'tmpdir',
    'temp',
    'tmp',
    'systemroot',
    'windir',
    'comspec',
    'appdata',
    'localappdata',
  ]);

  for (const [key, value] of Object.entries(process.env)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.startsWith('node_') ||
      lowerKey.startsWith('git_') ||
      lowerKey.startsWith('npm_') ||
      lowerKey.startsWith('ld_') ||
      lowerKey.startsWith('dyld_') ||
      lowerKey.startsWith('python') ||
      lowerKey.startsWith('perl')
    ) {
      continue;
    }

    if (ALLOWED_ENV_VARS.has(lowerKey)) {
      cleanEnv[key] = value;
    }
  }

  cleanEnv.LANG = 'C.UTF-8';

  return cleanEnv;
}

/**
 * Tiêu diệt toàn bộ cây tiến trình (process tree) an toàn trên cả Windows và POSIX.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killProcessTree(child) {
  if (!child || !child.pid) return;

  const isWin = process.platform === 'win32';
  if (isWin) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      try {
        child.kill();
      } catch {}
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }
}

module.exports = {
  PolicyError,
  tokenizeCommandLine,
  compileShellCommand,
  getSafeEnv,
  killProcessTree,
};
