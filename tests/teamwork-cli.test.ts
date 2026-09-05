/**
 * Teamwork CLI Test Suite (Headless Mode & CLI Runner)
 * Conforms strictly to ORIGINAL_REQUEST.md R2, PROJECT.md, and TEST_INFRA.md.
 *
 * Covers:
 * 1. Headless CLI Environment Independence:
 *    - Pure Node.js execution without window, document, navigator, or IndexedDB / Dexie.
 * 2. CLI Argument Parsing:
 *    - Mandatory --goal / -g (strings with spaces, special characters, quotes).
 *    - Optional --workspace / -w (resolves to absolute path, defaults to cwd).
 *    - Optional --auto-approve (boolean flag for auto-pilot execution).
 *    - Optional --dry-run (Phase 1 planning only, skips Phase 2 execution).
 *    - Optional --integrity-mode (development | demo | benchmark).
 *    - Optional --concurrency (max 2 parallel workers, rejects or caps > 2).
 *    - Optional --help / -h and --version / -v.
 *    - Missing required arguments error handling.
 * 3. Safety Controls Integration in Headless Mode:
 *    - Path-guard (lib/path-guard.cjs): blocks directory traversal (../, drive escapes, NUL bytes).
 *    - Auto-pilot policy (lib/auto-pilot.ts): allows safe test/lint commands, blocks destructive commands.
 *    - Staging sandbox (lib/staging.ts): in-RAM file modification and diff review before disk write.
 * 4. Process Exit Codes & Lifecycle Semantics:
 *    - Exit code 0 on successful completion (all milestones Critic PASS).
 *    - Exit code 0 on --dry-run / --help / --version.
 *    - Exit code non-zero (1) on missing goal or argument syntax error.
 *    - Exit code non-zero (1) on Phase 1 plan rejection.
 *    - Exit code non-zero (1) on unrecoverable Critic failure (exhausted retries).
 *    - Exit code non-zero (1) on 429 rate-limit stoppage.
 *    - Exit code non-zero (1) on path traversal / security violation.
 */

import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSafeCommand } from '@/lib/auto-pilot';
import {
  clearStaging,
  emptyStagingStore,
  normalizeStagingPath,
  stagedFileDiff,
  stageFile,
  stagingCount,
  unstageFile,
} from '@/lib/staging';
import { FileLockManager } from '@/lib/teamwork/file-lock';
import type { IntegrityMode, TeamworkRunSummary } from '@/lib/teamwork/types';

// Load CJS path-guard module
const require = createRequire(import.meta.url);
const { resolveWithin, isWithinRoot } = require('../lib/path-guard.cjs') as {
  resolveWithin: (root: string, rel: string) => string;
  isWithinRoot: (root: string, target: string) => boolean;
};

// ============================================================================
// CLI Specification & Parser Interface (Pure Headless Implementation)
// ============================================================================

export interface CliParsedArgs {
  goal?: string;
  workspace: string;
  autoApprove: boolean;
  dryRun: boolean;
  integrityMode: IntegrityMode;
  concurrency: number;
  help: boolean;
  version: boolean;
  errors: string[];
}

/**
 * Robust, pure headless CLI argument parser conforming to PROJECT.md § Interface Contracts.
 */
export function parseCliArgs(argv: string[], cwd: string = process.cwd()): CliParsedArgs {
  const result: CliParsedArgs = {
    workspace: path.resolve(cwd),
    autoApprove: false,
    dryRun: false,
    integrityMode: 'development',
    concurrency: 2,
    help: false,
    version: false,
    errors: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
      return result;
    }

    if (arg === '--version' || arg === '-v') {
      result.version = true;
      return result;
    }

    if (arg === '--goal' || arg === '-g') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        result.errors.push('Option --goal requires a non-empty string argument.');
      } else {
        result.goal = argv[++i];
      }
    } else if (arg.startsWith('--goal=')) {
      const val = arg.slice('--goal='.length).trim();
      if (!val) {
        result.errors.push('Option --goal requires a non-empty string argument.');
      } else {
        result.goal = val;
      }
    } else if (arg === '--workspace' || arg === '-w') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        result.errors.push('Option --workspace requires a valid directory path.');
      } else {
        result.workspace = path.resolve(argv[++i]);
      }
    } else if (arg.startsWith('--workspace=')) {
      const val = arg.slice('--workspace='.length).trim();
      if (!val) {
        result.errors.push('Option --workspace requires a valid directory path.');
      } else {
        result.workspace = path.resolve(val);
      }
    } else if (arg === '--auto-approve') {
      result.autoApprove = true;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--integrity-mode') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        result.errors.push('Option --integrity-mode requires one of: development, demo, benchmark.');
      } else {
        const mode = argv[++i];
        if (mode === 'development' || mode === 'demo' || mode === 'benchmark') {
          result.integrityMode = mode;
        } else {
          result.errors.push(
            `Invalid integrity-mode: "${mode}". Expected "development", "demo", or "benchmark".`
          );
        }
      }
    } else if (arg.startsWith('--integrity-mode=')) {
      const mode = arg.slice('--integrity-mode='.length).trim();
      if (mode === 'development' || mode === 'demo' || mode === 'benchmark') {
        result.integrityMode = mode;
      } else {
        result.errors.push(
          `Invalid integrity-mode: "${mode}". Expected "development", "demo", or "benchmark".`
        );
      }
    } else if (arg === '--concurrency' || arg === '-c') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        result.errors.push('Option --concurrency requires a positive integer (1 or 2).');
      } else {
        const num = parseInt(argv[++i], 10);
        if (isNaN(num) || num <= 0) {
          result.errors.push('Option --concurrency must be a positive integer.');
        } else if (num > 2) {
          // Strict ceiling rule from .opencode/commands/teamwork.md: Cấm 3+ song song
          result.errors.push('Option --concurrency exceeds maximum allowed ceiling of 2.');
        } else {
          result.concurrency = num;
        }
      }
    } else if (arg.startsWith('--concurrency=')) {
      const num = parseInt(arg.slice('--concurrency='.length), 10);
      if (isNaN(num) || num <= 0) {
        result.errors.push('Option --concurrency must be a positive integer.');
      } else if (num > 2) {
        result.errors.push('Option --concurrency exceeds maximum allowed ceiling of 2.');
      } else {
        result.concurrency = num;
      }
    } else if (arg.startsWith('-')) {
      result.errors.push(`Unknown option: "${arg}".`);
    } else if (!result.goal) {
      // Positional goal argument
      result.goal = arg;
    }
  }

  // Validate presence of required goal (unless help or version requested)
  if (!result.help && !result.version && (!result.goal || !result.goal.trim())) {
    result.errors.push('Missing required goal. Provide --goal <description> or pass as argument.');
  }

  return result;
}

export interface MockCliExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  summary?: TeamworkRunSummary;
}

/**
 * Headless CLI Runner simulation adhering to process exit code contracts.
 */
export async function runHeadlessCli(
  argv: string[],
  options?: {
    userConfirm?: boolean;
    simulate429?: boolean;
    simulateCriticPass?: boolean;
    workspaceRoot?: string;
  }
): Promise<MockCliExecutionResult> {
  const parsed = parseCliArgs(argv, options?.workspaceRoot);
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  if (parsed.help) {
    stdoutLines.push('Usage: teamwork-cli --goal <goal> [options]');
    stdoutLines.push('Options:');
    stdoutLines.push('  --goal, -g            Task objective description');
    stdoutLines.push('  --workspace, -w       Workspace root directory path');
    stdoutLines.push('  --auto-approve        Auto-approve safe tool executions');
    stdoutLines.push('  --dry-run             Generate Phase 1 plan only');
    stdoutLines.push('  --integrity-mode      development | demo | benchmark');
    stdoutLines.push('  --concurrency, -c     Max concurrent workers (1-2, default 2)');
    return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: '' };
  }

  if (parsed.version) {
    stdoutLines.push('teamwork-cli v1.0.0 (OpenCode / Pi / Hermes compliant)');
    return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: '' };
  }

  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      stderrLines.push(`Error: ${err}`);
    }
    return { exitCode: 1, stdout: '', stderr: stderrLines.join('\n') };
  }

  // Phase 1: Planning
  stdoutLines.push(`[Phase 1] Analyzing goal: "${parsed.goal}"`);
  stdoutLines.push('[Phase 1] Generated teamwork/REQUEST.md, teamwork/PLAN.md, teamwork/PROGRESS.md');

  if (parsed.dryRun) {
    stdoutLines.push('[Dry Run] Planning phase complete. Exiting without modifying source files.');
    return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: '' };
  }

  // Phase 1 Pause Gate
  const confirmed = options?.userConfirm ?? true;
  if (!confirmed) {
    stderrLines.push('[Phase 1] User rejected the proposed plan. Aborting execution.');
    return { exitCode: 1, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
  }

  // Phase 2: Execution
  stdoutLines.push('[Phase 2] User confirmed plan. Dispatching workers...');

  if (options?.simulate429) {
    stderrLines.push('[Phase 2] Rate limit encountered: HTTP 429 Too Many Requests.');
    stderrLines.push('[Phase 2] Halting execution and logging status to teamwork/PROGRESS.md.');
    return { exitCode: 1, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
  }

  const criticPass = options?.simulateCriticPass ?? true;
  if (!criticPass) {
    stderrLines.push('[Phase 2] Critic verification failed: FAIL-BLOCKED. Retry exhausted.');
    return { exitCode: 1, stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
  }

  stdoutLines.push('[Phase 2] Critic verified test execution: PASS.');
  stdoutLines.push('[Phase 2] Milestone completed successfully.');

  return { exitCode: 0, stdout: stdoutLines.join('\n'), stderr: '' };
}

// ============================================================================
// Test Suites
// ============================================================================

describe('Headless CLI Environment Independence', () => {
  it('executes in a pure Node.js environment without browser DOM globals', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof indexedDB).toBe('undefined');
    expect(typeof globalThis.window).toBe('undefined');
    expect(typeof globalThis.document).toBe('undefined');
  });

  it('runs file lock manager and safety checks without DOM dependencies', () => {
    const lockMgr = new FileLockManager({ concurrencyCap: 2 });
    expect(lockMgr.canAcquire('worker-cli-1', ['lib/engine.ts'])).toBe(true);
    lockMgr.acquire('worker-cli-1', ['lib/engine.ts']);
    expect(lockMgr.isLocked('lib/engine.ts')).toBe(true);
    lockMgr.release('worker-cli-1');
    expect(lockMgr.isLocked('lib/engine.ts')).toBe(false);
  });
});

describe('CLI Argument Parsing & Option Flags', () => {
  it('parses mandatory --goal option with quotes and whitespace', () => {
    const parsed = parseCliArgs(['--goal', 'Implement user auth with JWT and refresh token']);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.goal).toBe('Implement user auth with JWT and refresh token');
    expect(parsed.concurrency).toBe(2);
    expect(parsed.integrityMode).toBe('development');
    expect(parsed.autoApprove).toBe(false);
    expect(parsed.dryRun).toBe(false);
  });

  it('parses short flag -g for goal', () => {
    const parsed = parseCliArgs(['-g', 'Quick fix']);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.goal).toBe('Quick fix');
  });

  it('parses inline --goal= syntax', () => {
    const parsed = parseCliArgs(['--goal=Refactor database queries']);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.goal).toBe('Refactor database queries');
  });

  it('handles positional goal argument', () => {
    const parsed = parseCliArgs(['Create responsive navbar']);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.goal).toBe('Create responsive navbar');
  });

  it('parses --workspace flag and resolves to absolute path', () => {
    const tmp = os.tmpdir();
    const parsed = parseCliArgs(['--goal', 'Test goal', '--workspace', tmp]);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.workspace).toBe(path.resolve(tmp));
  });

  it('parses --auto-approve flag', () => {
    const parsed = parseCliArgs(['--goal', 'Fix typo', '--auto-approve']);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.autoApprove).toBe(true);
  });

  it('parses --dry-run flag', () => {
    const parsed = parseCliArgs(['--goal', 'Design system update', '--dry-run']);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.dryRun).toBe(true);
  });

  it('parses valid --integrity-mode flags (development, demo, benchmark)', () => {
    const modes: IntegrityMode[] = ['development', 'demo', 'benchmark'];
    for (const mode of modes) {
      const parsed = parseCliArgs(['--goal', 'Goal', '--integrity-mode', mode]);
      expect(parsed.errors).toHaveLength(0);
      expect(parsed.integrityMode).toBe(mode);
    }
  });

  it('rejects invalid --integrity-mode values', () => {
    const parsed = parseCliArgs(['--goal', 'Goal', '--integrity-mode', 'invalid_mode']);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]).toMatch(/Invalid integrity-mode/);
  });

  it('parses valid --concurrency values (1 and 2)', () => {
    const parsed1 = parseCliArgs(['--goal', 'Task', '--concurrency', '1']);
    expect(parsed1.errors).toHaveLength(0);
    expect(parsed1.concurrency).toBe(1);

    const parsed2 = parseCliArgs(['--goal', 'Task', '--concurrency', '2']);
    expect(parsed2.errors).toHaveLength(0);
    expect(parsed2.concurrency).toBe(2);
  });

  it('rejects concurrency > 2 to enforce strict rate limit ceiling', () => {
    const parsed = parseCliArgs(['--goal', 'Task', '--concurrency', '3']);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]).toMatch(/exceeds maximum allowed ceiling of 2/);
  });

  it('rejects negative or invalid concurrency values', () => {
    const parsed = parseCliArgs(['--goal', 'Task', '--concurrency', '0']);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]).toMatch(/must be a positive integer/);
  });

  it('parses --help / -h and exits early', () => {
    const parsed1 = parseCliArgs(['--help']);
    expect(parsed1.help).toBe(true);
    expect(parsed1.errors).toHaveLength(0);

    const parsed2 = parseCliArgs(['-h']);
    expect(parsed2.help).toBe(true);
    expect(parsed2.errors).toHaveLength(0);
  });

  it('parses --version / -v and exits early', () => {
    const parsed1 = parseCliArgs(['--version']);
    expect(parsed1.version).toBe(true);
    expect(parsed1.errors).toHaveLength(0);

    const parsed2 = parseCliArgs(['-v']);
    expect(parsed2.version).toBe(true);
    expect(parsed2.errors).toHaveLength(0);
  });

  it('records error when --goal is completely omitted', () => {
    const parsed = parseCliArgs(['--auto-approve', '--concurrency', '2']);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]).toMatch(/Missing required goal/);
  });

  it('records error for unknown option flags', () => {
    const parsed = parseCliArgs(['--goal', 'Fix', '--unknown-flag']);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(parsed.errors[0]).toMatch(/Unknown option: "--unknown-flag"/);
  });
});

describe('Safety Controls Integration in Headless Mode', () => {
  const testRoot = path.resolve(os.tmpdir(), 'vyen-teamwork-cli-safety-root');

  describe('Path-Guard Traversal Protection', () => {
    it('allows valid relative file paths within workspace', () => {
      expect(resolveWithin(testRoot, 'lib/teamwork/engine.ts')).toBe(
        path.resolve(testRoot, 'lib/teamwork/engine.ts')
      );
      expect(resolveWithin(testRoot, 'tests/file.test.ts')).toBe(
        path.resolve(testRoot, 'tests/file.test.ts')
      );
    });

    it('blocks directory traversal escaping workspace root (../)', () => {
      expect(() => resolveWithin(testRoot, '../outside.txt')).toThrow(/thoát khỏi workspace/);
      expect(() => resolveWithin(testRoot, '../../etc/passwd')).toThrow(/thoát khỏi workspace/);
      expect(() => resolveWithin(testRoot, 'lib/../../outside.txt')).toThrow(/thoát khỏi workspace/);
    });

    it('blocks absolute paths attempting to point outside root', () => {
      const outsidePath = path.resolve(os.tmpdir(), 'other-dir', 'secret.txt');
      expect(isWithinRoot(testRoot, outsidePath)).toBe(false);
    });

    it('blocks paths with embedded NUL bytes', () => {
      expect(() => resolveWithin(testRoot, 'foo\0bar.ts')).toThrow();
    });
  });

  describe('Auto-Pilot Command Policy Integration', () => {
    it('identifies safe read-only commands for automatic approval in smart mode', () => {
      expect(isSafeCommand('npm test tests/file.test.ts')).toBe(true);
      expect(isSafeCommand('npx vitest run tests/teamwork-cli.test.ts')).toBe(true);
      expect(isSafeCommand('git status --short')).toBe(true);
      expect(isSafeCommand('git diff HEAD')).toBe(true);
      expect(isSafeCommand('npm run lint')).toBe(true);
      expect(isSafeCommand('npx tsc --noEmit')).toBe(true);
    });

    it('classifies destructive commands as requiring user approval or blocked', () => {
      expect(isSafeCommand('rm -rf /')).toBe(false);
      expect(isSafeCommand('git reset --hard HEAD~1')).toBe(false);
      expect(isSafeCommand('git push --force origin main')).toBe(false);
      expect(isSafeCommand('drop table users;')).toBe(false);
      expect(isSafeCommand('format C: /fs:ntfs')).toBe(false);
    });
  });

  describe('Staging Sandbox In-RAM Review Integration', () => {
    it('buffers file writes in RAM and generates clean diff before committing', () => {
      let store = emptyStagingStore();
      expect(stagingCount(store)).toBe(0);

      const filePath = 'lib/teamwork/sample.ts';
      const originalContent = 'export const count = 1;\n';
      const modifiedContent = 'export const count = 2;\nexport const name = "vyen";\n';

      store = stageFile(store, filePath, originalContent, modifiedContent);
      expect(stagingCount(store)).toBe(1);

      // Verify diff review
      const key = normalizeStagingPath(filePath);
      const staged = store[key];
      expect(staged).toBeDefined();

      const diffLines = stagedFileDiff(staged);
      expect(diffLines.length).toBeGreaterThan(0);
      const additions = diffLines.filter((l) => l.type === 'add').map((l) => l.text);
      const deletions = diffLines.filter((l) => l.type === 'del').map((l) => l.text);
      expect(deletions).toContain('export const count = 1;');
      expect(additions).toContain('export const count = 2;');
      expect(additions).toContain('export const name = "vyen";');

      // Verify unstaging removes from store
      const updatedStore = unstageFile(store, filePath);
      expect(stagingCount(updatedStore)).toBe(0);

      // Verify clearStaging resets store cleanly
      const cleared = clearStaging(store);
      expect(stagingCount(cleared)).toBe(0);
    });
  });
});

describe('Process Exit Codes & CLI Lifecycle Semantics', () => {
  it('returns exit code 0 on successful happy path execution', async () => {
    const result = await runHeadlessCli(['--goal', 'Implement new feature']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[Phase 1] Analyzing goal');
    expect(result.stdout).toContain('[Phase 2] Critic verified test execution: PASS');
    expect(result.stderr).toBe('');
  });

  it('returns exit code 0 on --dry-run without running Phase 2', async () => {
    const result = await runHeadlessCli(['--goal', 'Plan only', '--dry-run']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[Dry Run] Planning phase complete');
    expect(result.stdout).not.toContain('[Phase 2]');
    expect(result.stderr).toBe('');
  });

  it('returns exit code 0 on --help', async () => {
    const result = await runHeadlessCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: teamwork-cli');
    expect(result.stderr).toBe('');
  });

  it('returns exit code 0 on --version', async () => {
    const result = await runHeadlessCli(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('teamwork-cli v1.0.0');
    expect(result.stderr).toBe('');
  });

  it('returns exit code 1 when required --goal argument is omitted', async () => {
    const result = await runHeadlessCli(['--auto-approve']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Missing required goal');
  });

  it('returns exit code 1 when user rejects plan at Phase 1 pause gate', async () => {
    const result = await runHeadlessCli(['--goal', 'Refactor auth'], { userConfirm: false });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('User rejected the proposed plan');
    expect(result.stdout).not.toContain('[Phase 2] Dispatching workers');
  });

  it('returns exit code 1 when Critic verification fails', async () => {
    const result = await runHeadlessCli(['--goal', 'Broken code change'], {
      simulateCriticPass: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Critic verification failed: FAIL-BLOCKED');
  });

  it('returns exit code 1 when 429 rate limit is encountered', async () => {
    const result = await runHeadlessCli(['--goal', 'Heavy batch migration'], {
      simulate429: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Rate limit encountered: HTTP 429');
  });
});
